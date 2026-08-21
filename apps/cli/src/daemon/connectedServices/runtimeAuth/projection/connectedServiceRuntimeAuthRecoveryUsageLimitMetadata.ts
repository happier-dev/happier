import {
  ConnectedServiceIdSchema,
  SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY,
  SessionUsageLimitRecoveryV1Schema,
  SessionUsageLimitRecoveryResumePromptModeV1Schema,
  type SessionUsageLimitRecoveryV1,
  type SessionUsageLimitRecoveryResumePromptModeV1,
} from '@happier-dev/protocol';

import type { Metadata } from '@/api/types';
import { deriveUsageLimitRecoveryTiming } from '@/session/usageLimitRecoveryControls/deriveUsageLimitRecoveryTiming';
import type { ConnectedServiceRuntimeAuthFailureDaemonReport } from '../reportConnectedServiceRuntimeAuthFailureToDaemon';
import type { ConnectedServiceRuntimeFailureClassification } from '../types';
import { resolveRuntimeAuthRecoveryResultDisposition } from '../resolveRuntimeAuthRecoveryResultDisposition';

const DEFAULT_USAGE_LIMIT_RECOVERY_MAX_ATTEMPTS = 3;
const FALLBACK_WAIT_CHECK_DELAY_MS = 60_000;

type MetadataRecord = Record<string, unknown>;

type ProjectedRecoveryState = Readonly<{
  status: SessionUsageLimitRecoveryV1['status'];
  lastProbeError: string | null;
  activeProfileId: string | null;
  nextCheckAtMs?: number | null;
}>;

function readRecord(value: unknown): MetadataRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as MetadataRecord
    : null;
}

function readString(value: unknown): string | null {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized.length > 0 ? normalized : null;
}

function readNonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : null;
}

function readConnectedServiceId(value: unknown): SessionUsageLimitRecoveryV1['selectedAuth']['serviceId'] | null {
  const parsed = ConnectedServiceIdSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function readResumePromptMode(value: unknown): SessionUsageLimitRecoveryResumePromptModeV1 | null {
  const parsed = SessionUsageLimitRecoveryResumePromptModeV1Schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function readRecoveryIntent(metadata: MetadataRecord): SessionUsageLimitRecoveryV1 | null {
  const parsed = SessionUsageLimitRecoveryV1Schema.safeParse(metadata[SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY]);
  return parsed.success ? parsed.data : null;
}

function readOuterResult(report: unknown): MetadataRecord | null {
  const envelope = readRecord(report);
  if (!envelope || envelope.ok !== true) return null;
  return readRecord(envelope.result);
}

function readRecoveryRecord(result: MetadataRecord | null): MetadataRecord | null {
  return readRecord(result?.recovery);
}

function readSwitchResult(result: MetadataRecord | null): MetadataRecord | null {
  return readRecord(result?.result);
}

function buildSelectedAuth(input: Readonly<{
  classification: ConnectedServiceRuntimeFailureClassification;
  current: SessionUsageLimitRecoveryV1 | null;
  activeProfileId: string | null;
}>): SessionUsageLimitRecoveryV1['selectedAuth'] {
  const existingGroupProfileId = input.current?.selectedAuth.kind === 'group'
    && input.current.selectedAuth.serviceId === input.classification.serviceId
    && input.current.selectedAuth.groupId === input.classification.groupId
    ? input.current.selectedAuth.profileId
    : null;
  const profileId = input.activeProfileId ?? input.classification.profileId ?? existingGroupProfileId;
  const serviceId = readConnectedServiceId(input.classification.serviceId);

  if (serviceId && input.classification.groupId && profileId) {
    return {
      kind: 'group',
      serviceId,
      groupId: input.classification.groupId,
      profileId,
    };
  }
  if (serviceId && profileId) {
    return {
      kind: 'profile',
      serviceId,
      profileId,
    };
  }
  return {
    kind: 'native',
    serviceId,
  };
}

function sameUsageLimitSelection(
  current: SessionUsageLimitRecoveryV1 | null,
  next: SessionUsageLimitRecoveryV1['selectedAuth'],
): boolean {
  if (!current) return false;
  const existing = current.selectedAuth;
  if (existing.kind !== next.kind || existing.serviceId !== next.serviceId) return false;
  if (existing.kind === 'group' && next.kind === 'group') return existing.groupId === next.groupId;
  if (existing.kind === 'profile' && next.kind === 'profile') return existing.profileId === next.profileId;
  return true;
}

function buildIssueFingerprint(input: Readonly<{
  classification: ConnectedServiceRuntimeFailureClassification;
  selectedAuth: SessionUsageLimitRecoveryV1['selectedAuth'];
}>): string {
  const selectionMaterial = input.selectedAuth.kind === 'group'
    ? `group:${input.selectedAuth.groupId}`
    : input.selectedAuth.kind === 'profile'
      ? `profile:${input.selectedAuth.profileId}`
      : `native:${input.selectedAuth.serviceId ?? 'unknown'}`;
  const resetMaterial = input.classification.resetsAtMs === null ? 'no-reset' : String(input.classification.resetsAtMs);
  return [
    'usage-limit',
    input.classification.serviceId,
    selectionMaterial,
    resetMaterial,
    'runtime-auth',
  ].join(':');
}

function resolveProjectedRecoveryState(input: Readonly<{
  report: ConnectedServiceRuntimeAuthFailureDaemonReport;
  classification: ConnectedServiceRuntimeFailureClassification;
  nowMs: number;
}>): ProjectedRecoveryState | null {
  const report = input.report;
  const result = readOuterResult(report.report);
  if (!result) return null;

  switch (result.status) {
    case 'credential_refreshed':
    case 'temporary_retry_armed':
    case 'recovery_retry_scheduled':
      return { status: 'waiting', lastProbeError: null, activeProfileId: null };
    case 'recovery_cancelled':
      return { status: 'cancelled', lastProbeError: null, activeProfileId: null };
    case 'recovery_dead_lettered':
    case 'recovery_terminal':
      return {
        status: 'exhausted',
        lastProbeError: readString(readRecoveryRecord(result)?.lastError) ?? readString(result.status),
        activeProfileId: null,
      };
    case 'recovery_action_required': {
      const action = readRecord(result.action);
      const actionKind = readString(action?.kind);
      // FIX-4 (incident Jun-11 F-NEW-1): for non-group waitable limit failures with a known
      // reset the daemon arms a durable wait until that reset instead of terminalizing —
      // mirror it here so session metadata renders "waiting until reset", not "exhausted".
      const waitableActionKind = actionKind === 'profile_action_required' || actionKind === 'connected_service_required';
      const actionReason = readString(action?.reason);
      const waitableReason = actionReason === 'usage_limit' || actionReason === 'rate_limit' || actionReason === 'temporary_throttle';
      const resetAtMs = readNonNegativeInteger(input.classification.resetsAtMs);
      if (waitableActionKind && waitableReason && resetAtMs !== null) {
        return {
          status: 'waiting',
          lastProbeError: 'awaiting_limit_reset',
          activeProfileId: null,
          nextCheckAtMs: resetAtMs,
        };
      }
      return {
        status: 'exhausted',
        lastProbeError: actionKind ?? 'recovery_action_required',
        activeProfileId: null,
      };
    }
    case 'switch_attempted': {
      const switchResult = readSwitchResult(result);
      const disposition = resolveRuntimeAuthRecoveryResultDisposition({
        result,
        classificationFailureKind: input.classification.kind,
        classificationResetsAtMs: input.classification.resetsAtMs ?? null,
        nowMs: input.nowMs,
      });
      if (disposition?.kind === 'durable_wait') {
        return {
          status: 'waiting',
          lastProbeError: disposition.reason,
          activeProfileId: readString(switchResult?.activeProfileId),
          nextCheckAtMs: disposition.nextRetryAtMs,
        };
      }
      if (disposition?.kind === 'terminal') {
        return {
          status: 'exhausted',
          lastProbeError: disposition.reason,
          activeProfileId: readString(switchResult?.activeProfileId),
        };
      }
      switch (switchResult?.status) {
        case 'switched':
          return {
            status: 'waiting',
            lastProbeError: null,
            activeProfileId: readString(switchResult.activeProfileId),
          };
        case 'generation_apply_failed':
          return {
            status: 'exhausted',
            lastProbeError: `connected_service_generation_apply_failed:${readString(switchResult.errorCode) ?? 'unknown'}`,
            activeProfileId: readString(switchResult.activeProfileId),
          };
        default:
          return null;
      }
    }
    default:
      return null;
  }
}

function resolveNextCheckAtMs(input: Readonly<{
  status: SessionUsageLimitRecoveryV1['status'];
  current: SessionUsageLimitRecoveryV1 | null;
  recoveryRecord: MetadataRecord | null;
  projectedNextCheckAtMs?: number | null;
  classification: ConnectedServiceRuntimeFailureClassification;
  armedAtMs: number;
  nowMs: number;
}>): number | null {
  if (input.status === 'cancelled' || input.status === 'exhausted') return null;
  const fromRecovery = readNonNegativeInteger(input.recoveryRecord?.nextRetryAtMs);
  if (fromRecovery !== null) return fromRecovery;
  if (typeof input.projectedNextCheckAtMs === 'number') return input.projectedNextCheckAtMs;
  const timing = deriveUsageLimitRecoveryTiming({
    occurredAtMs: input.armedAtMs,
    resetAtMs: input.classification.resetsAtMs,
    retryAfterMs: input.classification.retryAfterMs ?? null,
  });
  if (timing.nextCheckAtMs !== null) return timing.nextCheckAtMs;
  if (typeof input.current?.nextCheckAtMs === 'number') return input.current.nextCheckAtMs;
  if (input.classification.resetsAtMs !== null) return input.classification.resetsAtMs;
  return input.nowMs + FALLBACK_WAIT_CHECK_DELAY_MS;
}

export function buildRuntimeAuthUsageLimitRecoveryMetadataUpdater(input: Readonly<{
  report: ConnectedServiceRuntimeAuthFailureDaemonReport;
  classification: ConnectedServiceRuntimeFailureClassification;
  nowMs?: () => number;
}>): ((metadata: Metadata) => Metadata) | null {
  if (input.classification.kind !== 'usage_limit') return null;

  const now = input.nowMs?.() ?? Date.now();

  const projectedState = resolveProjectedRecoveryState({
    report: input.report,
    classification: input.classification,
    nowMs: now,
  });
  if (!projectedState) return null;

  const recoveryRecord = readRecoveryRecord(readOuterResult(input.report.report));

  return (metadata: Metadata): Metadata => {
    const nextMetadataBase = (metadata ?? {}) as Metadata;
    const current = readRecoveryIntent(nextMetadataBase);
    const selectedAuth = buildSelectedAuth({
      classification: input.classification,
      current,
      activeProfileId: projectedState.activeProfileId,
    });
    const issueFingerprint = current && sameUsageLimitSelection(current, selectedAuth)
      ? current.issueFingerprint
      : buildIssueFingerprint({
        classification: input.classification,
        selectedAuth,
      });
    const armedAtMs = current?.armedAtMs ?? now;
    const attemptCount = readNonNegativeInteger(recoveryRecord?.attemptCount) ?? current?.attemptCount ?? 0;
    const maxAttempts = readNonNegativeInteger(recoveryRecord?.maxAttempts) ?? current?.maxAttempts ?? DEFAULT_USAGE_LIMIT_RECOVERY_MAX_ATTEMPTS;
    const resetAtMs = input.classification.resetsAtMs ?? current?.resetAtMs ?? null;
    const nextCheckAtMs = resolveNextCheckAtMs({
      status: projectedState.status,
      current,
      recoveryRecord,
      projectedNextCheckAtMs: projectedState.nextCheckAtMs ?? null,
      classification: input.classification,
      armedAtMs,
      nowMs: now,
    });
    const runtimeAuthRecoveryAttemptId = readString(recoveryRecord?.attemptId)
      ?? readString(input.report.recoveryReceipt?.attemptId)
      ?? current?.runtimeAuthRecoveryAttemptId;

    return {
      ...nextMetadataBase,
      [SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY]: {
        v: 1,
        status: projectedState.status,
        issueFingerprint,
        armedAtMs,
        ...(runtimeAuthRecoveryAttemptId ? { runtimeAuthRecoveryAttemptId } : {}),
        resetAtMs,
        nextCheckAtMs,
        attemptCount,
        maxAttempts,
        lastProbeError: projectedState.lastProbeError,
        // Prompt policy is resolved by the async daemon owner before the durable
        // attempt/report is written. Projection is synchronous and may only read
        // that immutable fact; legacy/malformed records fail closed to standard.
        resumePromptMode: readResumePromptMode(input.report.resumePromptMode) ?? 'standard',
        selectedAuth,
      } satisfies SessionUsageLimitRecoveryV1,
    };
  };
}
