import {
  ConnectedServiceQuotaSnapshotV1Schema,
  SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY,
  SessionRuntimeIssueV1Schema,
  SessionUsageLimitRecoveryV1Schema,
  type ConnectedServiceCredentialRecordV1,
  type ConnectedServiceQuotaSnapshotV1,
  type SessionRuntimeIssueV1,
  type SessionUsageLimitRecoveryV1,
} from '@happier-dev/protocol';

import { ApiClient } from '@/api/api';
import { resolveConnectedServiceCredentials } from '@/cloud/connectedServices/resolveConnectedServiceCredentials';
import type { Credentials } from '@/persistence';
import type {
  ConnectedServiceProviderRuntimeAuthAdapter,
  ConnectedServiceRuntimeAuthTargetInput,
} from '@/daemon/connectedServices/runtimeAuth/types';
import type {
  SessionUsageLimitRecoveryControlAdapter,
  SessionUsageLimitRecoveryControlAdapterParams,
} from '@/session/usageLimitRecoveryControls/sessionUsageLimitRecoveryControlTypes';
import { deriveUsageLimitRecoveryTiming } from '@/session/usageLimitRecoveryControls/deriveUsageLimitRecoveryTiming';
import { resolveUsageLimitRecoveryMaxAttemptsExhaustion } from '@/session/usageLimitRecoveryControls/resolveUsageLimitRecoveryMaxAttemptsExhaustion';
import { createGeminiConnectedServiceRuntimeAuthAdapter } from './createGeminiConnectedServiceRuntimeAuthAdapter';

type MetadataRecord = Record<string, unknown>;

type GeminiUsageLimitRecoveryControlResult =
  | Readonly<{ ok: true; status: 'ready' | 'waiting'; metadata: MetadataRecord }>
  | Readonly<{ ok: false; errorCode: string; error: string }>;

type ResolveGeminiCredential = (params: Readonly<{
  credentials: Credentials;
  serviceId: 'gemini';
  profileId: string;
}>) => Promise<ConnectedServiceCredentialRecordV1 | null>;

type ProbeGeminiQuota = ConnectedServiceProviderRuntimeAuthAdapter['probeQuota'];

const DEFAULT_USAGE_LIMIT_RECOVERY_MAX_ATTEMPTS = 3;

function stableError(errorCode: string): Readonly<{ ok: false; errorCode: string; error: string }> {
  return { ok: false, errorCode, error: errorCode };
}

function readRecoveryIntent(metadata: MetadataRecord): SessionUsageLimitRecoveryV1 | null {
  const parsed = SessionUsageLimitRecoveryV1Schema.safeParse(metadata[SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY]);
  return parsed.success ? parsed.data : null;
}

function buildUsageLimitIssueFingerprint(
  issue: NonNullable<ReturnType<typeof SessionRuntimeIssueV1Schema.safeParse>['data']>,
): string {
  return [
    'usage-limit',
    issue.provider ?? 'gemini',
    issue.providerTurnId ?? 'unknown-turn',
    String(issue.occurredAt),
    issue.usageLimit?.resetAtMs === null || issue.usageLimit?.resetAtMs === undefined
      ? 'no-reset'
      : String(issue.usageLimit.resetAtMs),
  ].join(':');
}

function buildGeminiSelectedAuth(
  connectedService: NonNullable<SessionRuntimeIssueV1['usageLimit']>['connectedService'],
): SessionUsageLimitRecoveryV1['selectedAuth'] | null {
  if (connectedService?.serviceId !== 'gemini') return null;
  if (connectedService.groupId) {
    return {
      kind: 'group',
      serviceId: 'gemini',
      groupId: connectedService.groupId,
      profileId: connectedService.profileId ?? null,
    };
  }
  if (connectedService.profileId) {
    return {
      kind: 'profile',
      serviceId: 'gemini',
      profileId: connectedService.profileId,
    };
  }
  return null;
}

function buildRecoveryIntentFromLatestUsageLimitIssue(
  params: SessionUsageLimitRecoveryControlAdapterParams,
): SessionUsageLimitRecoveryV1 | null {
  if (params.rawSession.latestTurnStatus != null && params.rawSession.latestTurnStatus !== 'failed') {
    return null;
  }

  const issueParsed = SessionRuntimeIssueV1Schema.safeParse(params.rawSession.lastRuntimeIssue);
  if (!issueParsed.success || issueParsed.data.source !== 'usage_limit' || !issueParsed.data.usageLimit) {
    return null;
  }

  const connectedService = issueParsed.data.usageLimit.connectedService;
  const selectedAuth = buildGeminiSelectedAuth(connectedService);
  if (!selectedAuth) return null;

  const timing = deriveUsageLimitRecoveryTiming({
    occurredAtMs: issueParsed.data.occurredAt,
    resetAtMs: issueParsed.data.usageLimit.resetAtMs,
    retryAfterMs: issueParsed.data.usageLimit.retryAfterMs,
  });

  return {
    v: 1,
    status: 'waiting',
    resumePromptMode: 'standard',
    issueFingerprint: buildUsageLimitIssueFingerprint(issueParsed.data),
    armedAtMs: issueParsed.data.occurredAt,
    resetAtMs: timing.resetAtMs,
    nextCheckAtMs: timing.nextCheckAtMs,
    attemptCount: 0,
    maxAttempts: DEFAULT_USAGE_LIMIT_RECOVERY_MAX_ATTEMPTS,
    lastProbeError: null,
    selectedAuth,
  };
}

function latestUsageLimitIssueNeedsGeminiConnectedService(
  params: SessionUsageLimitRecoveryControlAdapterParams,
): boolean {
  if (params.rawSession.latestTurnStatus != null && params.rawSession.latestTurnStatus !== 'failed') {
    return false;
  }
  const issueParsed = SessionRuntimeIssueV1Schema.safeParse(params.rawSession.lastRuntimeIssue);
  if (!issueParsed.success || issueParsed.data.source !== 'usage_limit' || !issueParsed.data.usageLimit) {
    return false;
  }
  return issueParsed.data.provider === 'gemini';
}

function resolveGeminiSelection(
  intent: SessionUsageLimitRecoveryV1,
): Readonly<{ profileId: string; groupId: string | null }> | null {
  if (intent.selectedAuth.kind === 'profile' && intent.selectedAuth.serviceId === 'gemini') {
    return { profileId: intent.selectedAuth.profileId, groupId: null };
  }
  if (intent.selectedAuth.kind === 'group' && intent.selectedAuth.serviceId === 'gemini') {
    if (intent.selectedAuth.profileId === null) return null;
    return { profileId: intent.selectedAuth.profileId, groupId: intent.selectedAuth.groupId };
  }
  return null;
}

function isGeminiGroupWaitingForSelectedProfile(intent: SessionUsageLimitRecoveryV1): boolean {
  return intent.selectedAuth.kind === 'group'
    && intent.selectedAuth.serviceId === 'gemini'
    && intent.selectedAuth.profileId === null;
}

function isQuotaSnapshotExhausted(snapshot: ConnectedServiceQuotaSnapshotV1): boolean {
  if (snapshot.meters.length === 0) return false;
  return snapshot.meters.some((meter) =>
    meter.status === 'unavailable'
    || (typeof meter.utilizationPct === 'number' && Number.isFinite(meter.utilizationPct) && meter.utilizationPct >= 100)
    || (
      typeof meter.used === 'number'
      && typeof meter.limit === 'number'
      && Number.isFinite(meter.used)
      && Number.isFinite(meter.limit)
      && meter.limit > 0
      && meter.used >= meter.limit
    ),
  );
}

function readEarliestQuotaResetAtMs(snapshot: ConnectedServiceQuotaSnapshotV1): number | null {
  const resets = snapshot.meters
    .map((meter) => meter.resetsAt)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0);
  return resets.length > 0 ? Math.min(...resets) : null;
}

function buildNextIntent(params: Readonly<{
  intent: SessionUsageLimitRecoveryV1;
  exhausted: boolean;
  resetAtMs: number | null;
}>): SessionUsageLimitRecoveryV1 {
  const attemptCount = params.intent.attemptCount + 1;
  if (!params.exhausted) {
    return {
      ...params.intent,
      status: 'cancelled',
      attemptCount,
      lastProbeError: null,
    };
  }
  return {
    ...params.intent,
    status: 'waiting',
    attemptCount,
    resetAtMs: params.resetAtMs ?? params.intent.resetAtMs,
    nextCheckAtMs: params.resetAtMs ?? params.intent.nextCheckAtMs ?? params.intent.resetAtMs,
    lastProbeError: null,
  };
}

async function resolveGeminiCredential(params: Readonly<{
  credentials: Credentials;
  serviceId: 'gemini';
  profileId: string;
}>): Promise<ConnectedServiceCredentialRecordV1 | null> {
  const api = await ApiClient.create(params.credentials);
  const records = await resolveConnectedServiceCredentials({
    credentials: params.credentials,
    api,
    bindings: [{ serviceId: params.serviceId, profileId: params.profileId }],
  });
  return records.get(params.serviceId) ?? null;
}

function buildProbeInput(params: Readonly<{
  groupId: string | null;
  record: ConnectedServiceCredentialRecordV1;
}>): ConnectedServiceRuntimeAuthTargetInput {
  return {
    target: { agentId: 'gemini' },
    selection: {
      ...(params.groupId ? { groupId: params.groupId } : {}),
      record: params.record,
    },
  };
}

export function createGeminiUsageLimitRecoveryControlAdapter(deps: Readonly<{
  resolveCredential?: ResolveGeminiCredential;
  probeQuota?: ProbeGeminiQuota;
}> = {}): SessionUsageLimitRecoveryControlAdapter {
  const resolveCredential = deps.resolveCredential ?? resolveGeminiCredential;
  const probeQuota = deps.probeQuota ?? createGeminiConnectedServiceRuntimeAuthAdapter().probeQuota;

  return {
    checkNow: async (params): Promise<GeminiUsageLimitRecoveryControlResult> => {
      if (!params.credentials) {
        return stableError('session_usage_limit_recovery_control_credentials_unavailable');
      }

      const persistedIntent = readRecoveryIntent(params.metadata);
      const intent = persistedIntent && persistedIntent.status !== 'cancelled'
        ? persistedIntent
        : buildRecoveryIntentFromLatestUsageLimitIssue(params);
      if (!intent) {
        if (latestUsageLimitIssueNeedsGeminiConnectedService(params)) {
          return stableError('session_usage_limit_recovery_control_connected_service_unavailable');
        }
        return stableError('session_usage_limit_recovery_control_inactive');
      }

      const exhaustedIntent = resolveUsageLimitRecoveryMaxAttemptsExhaustion(intent);
      if (exhaustedIntent) {
        return {
          ok: true,
          status: 'waiting',
          metadata: {
            ...params.metadata,
            [SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY]: exhaustedIntent,
          },
        };
      }

      const selection = resolveGeminiSelection(intent);
      if (!selection) {
        if (isGeminiGroupWaitingForSelectedProfile(intent)) {
          return {
            ok: true,
            status: 'waiting',
            metadata: {
              ...params.metadata,
              [SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY]: intent,
            },
          };
        }
        return stableError('session_usage_limit_recovery_control_connected_service_unavailable');
      }

      const record = await resolveCredential({
        credentials: params.credentials,
        serviceId: 'gemini',
        profileId: selection.profileId,
      });
      if (!record) {
        return stableError('session_usage_limit_recovery_control_connected_service_unavailable');
      }

      const probeResult = await probeQuota(buildProbeInput({
        groupId: selection.groupId,
        record,
      }));
      if (probeResult.status !== 'available') {
        return stableError('session_usage_limit_recovery_control_probe_unavailable');
      }

      const snapshotParsed = ConnectedServiceQuotaSnapshotV1Schema.safeParse(probeResult.quotaSnapshot);
      if (!snapshotParsed.success || snapshotParsed.data.meters.length === 0) {
        return stableError('session_usage_limit_recovery_control_quota_unavailable');
      }

      const exhausted = isQuotaSnapshotExhausted(snapshotParsed.data);
      const nextIntent = buildNextIntent({
        intent,
        exhausted,
        resetAtMs: readEarliestQuotaResetAtMs(snapshotParsed.data),
      });
      return {
        ok: true,
        status: exhausted ? 'waiting' : 'ready',
        metadata: {
          ...params.metadata,
          [SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY]: nextIntent,
        },
      };
    },
  };
}

export const geminiUsageLimitRecoveryControlAdapter =
  createGeminiUsageLimitRecoveryControlAdapter();
