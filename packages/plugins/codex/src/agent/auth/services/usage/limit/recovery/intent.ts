import {
  SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY,
  SessionRuntimeIssueV1Schema,
  SessionUsageLimitRecoveryV1Schema,
  type SessionRuntimeIssueV1,
  type SessionUsageLimitRecoveryResumePromptModeV1,
  type SessionUsageLimitRecoveryV1,
} from '@happier-dev/plugin-sdk/experimental/cloud/usage';

import {
  isCodexRateLimitSnapshotExhausted,
  readEarliestCodexRateLimitResetAtMs,
} from '../../../quota/rateLimitSnapshot.js';

type MetadataRecord = Record<string, unknown>;

export const CODEX_USAGE_LIMIT_RECOVERY_CONNECTED_SERVICE_ID = 'openai-codex' as const;
export const DEFAULT_CODEX_USAGE_LIMIT_RECOVERY_MAX_ATTEMPTS = 3;

export type CodexUsageLimitRecoveryTiming = Readonly<{
  resetAtMs: number | null;
  nextCheckAtMs: number | null;
}>;

export type DeriveCodexUsageLimitRecoveryTiming = (
  issue: SessionRuntimeIssueV1,
) => CodexUsageLimitRecoveryTiming;

export type CodexUsageLimitRecoveryProbeResult = Readonly<{
  status: 'ready' | 'waiting';
  intent: SessionUsageLimitRecoveryV1;
}>;

export function readCodexUsageLimitRecoveryIntent(
  metadata: MetadataRecord,
): SessionUsageLimitRecoveryV1 | null {
  const parsed = SessionUsageLimitRecoveryV1Schema.safeParse(
    metadata[SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY],
  );
  if (!parsed.success || parsed.data.status === 'cancelled') return null;
  return parsed.data;
}

function readResumePromptMode(value: unknown): SessionUsageLimitRecoveryResumePromptModeV1 | null {
  return value === 'standard' || value === 'off' || value === 'custom' ? value : null;
}

export function applyCodexUsageLimitRecoveryResumePromptMode(
  intent: SessionUsageLimitRecoveryV1,
  requestedMode: unknown,
): SessionUsageLimitRecoveryV1 {
  return {
    ...intent,
    resumePromptMode: readResumePromptMode(requestedMode)
      ?? readResumePromptMode(intent.resumePromptMode)
      ?? 'standard',
  };
}

export function buildCodexUsageLimitIssueFingerprint(issue: SessionRuntimeIssueV1): string {
  return [
    'usage-limit',
    issue.agentId ?? 'codex',
    issue.agentTurnId ?? 'unknown-turn',
    String(issue.occurredAt),
    issue.usageLimit?.resetAtMs === null || issue.usageLimit?.resetAtMs === undefined
      ? 'no-reset'
      : String(issue.usageLimit.resetAtMs),
  ].join(':');
}

function buildSelectedAuth(
  connectedService: NonNullable<SessionRuntimeIssueV1['usageLimit']>['connectedService'],
): SessionUsageLimitRecoveryV1['selectedAuth'] {
  if (connectedService?.groupId) {
    return {
      kind: 'group',
      serviceId: connectedService.serviceId,
      groupId: connectedService.groupId,
      profileId: connectedService.profileId ?? null,
    };
  }
  if (connectedService?.profileId) {
    return {
      kind: 'profile',
      serviceId: connectedService.serviceId,
      profileId: connectedService.profileId,
    };
  }
  return {
    kind: 'native',
    serviceId: CODEX_USAGE_LIMIT_RECOVERY_CONNECTED_SERVICE_ID,
  };
}

export function resolveCodexUsageLimitRecoveryIntent(params: Readonly<{
  metadata: MetadataRecord;
  latestTurnStatus?: unknown;
  lastRuntimeIssue?: unknown;
  resumePromptMode?: unknown;
  deriveTiming: DeriveCodexUsageLimitRecoveryTiming;
}>): SessionUsageLimitRecoveryV1 | null {
  const persistedIntent = readCodexUsageLimitRecoveryIntent(params.metadata);
  if (persistedIntent) {
    return applyCodexUsageLimitRecoveryResumePromptMode(persistedIntent, params.resumePromptMode);
  }

  if (params.latestTurnStatus != null && params.latestTurnStatus !== 'failed') {
    return null;
  }

  const issueParsed = SessionRuntimeIssueV1Schema.safeParse(params.lastRuntimeIssue);
  if (!issueParsed.success || issueParsed.data.source !== 'usage_limit' || !issueParsed.data.usageLimit) {
    return null;
  }

  const timing = params.deriveTiming(issueParsed.data);
  return {
    v: 1,
    status: 'waiting',
    resumePromptMode: readResumePromptMode(params.resumePromptMode) ?? 'standard',
    issueFingerprint: buildCodexUsageLimitIssueFingerprint(issueParsed.data),
    armedAtMs: issueParsed.data.occurredAt,
    resetAtMs: timing.resetAtMs,
    nextCheckAtMs: timing.nextCheckAtMs,
    attemptCount: 0,
    maxAttempts: DEFAULT_CODEX_USAGE_LIMIT_RECOVERY_MAX_ATTEMPTS,
    lastProbeError: null,
    selectedAuth: buildSelectedAuth(issueParsed.data.usageLimit.connectedService),
  };
}

export function buildCodexUsageLimitRecoveryProbeResult(params: Readonly<{
  intent: SessionUsageLimitRecoveryV1;
  rawSnapshot: unknown;
}>): CodexUsageLimitRecoveryProbeResult {
  const attemptCount = params.intent.attemptCount + 1;
  const exhausted = isCodexRateLimitSnapshotExhausted(params.rawSnapshot);
  if (!exhausted) {
    return {
      status: 'ready',
      intent: {
        ...params.intent,
        status: 'cancelled',
        attemptCount,
        lastProbeError: null,
      },
    };
  }

  const resetAtMs = readEarliestCodexRateLimitResetAtMs(params.rawSnapshot);
  return {
    status: 'waiting',
    intent: {
      ...params.intent,
      status: 'waiting',
      attemptCount,
      resetAtMs: resetAtMs ?? params.intent.resetAtMs,
      nextCheckAtMs: resetAtMs ?? params.intent.nextCheckAtMs ?? params.intent.resetAtMs,
      lastProbeError: null,
    },
  };
}
