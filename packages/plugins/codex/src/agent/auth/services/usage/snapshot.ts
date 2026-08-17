import type {
  AgentAccountUsageMeter,
  AgentAccountUsageRecoveryCredits,
  AgentAccountUsageSnapshot,
} from '@happier-dev/plugin-sdk/agents/runtime';

import {
  CODEX_RATE_LIMIT_SNAPSHOT_STALE_AFTER_MS,
  mapCodexRateLimitSnapshotToUsageMeters,
  readCodexRateLimitSnapshotAccountLabel,
  readCodexRateLimitSnapshotPlanLabel,
} from '../quota/rateLimitSnapshot.js';
import { resolveCodexRuntimeRateLimitsState } from '../quota/runtimeRateLimits.js';
import { mapCodexRateLimitResetCredits } from '../quota/rateLimitResetCredits.js';
import type { CodexUsageSubjectRef } from './identity.js';

export type MapCodexRateLimitSnapshotToProviderAccountUsageSnapshotInput = Readonly<{
  subject: CodexUsageSubjectRef;
  rawSnapshot: unknown;
  rawResetCredits?: unknown;
  observedAtMs: number;
  fetchedAtMs: number;
  accountLabel?: string | null;
  staleAfterMs?: number;
}>;

export type MapCodexProviderHttpUsageSnapshotInput = Readonly<{
  subject: CodexUsageSubjectRef;
  observedAtMs: number;
  fetchedAtMs: number;
  staleAfterMs: number;
  planLabel?: string | null;
  accountLabel?: string | null;
  recoveryCredits?: AgentAccountUsageRecoveryCredits;
  meters: readonly AgentAccountUsageMeter[];
}>;

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeTimestampMs(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function buildRecordKey(subject: CodexUsageSubjectRef): AgentAccountUsageSnapshot['recordKey'] {
  return {
    providerId: 'openai-codex',
    accountSubjectId: subject.accountSubjectId,
    subjectKind: subject.kind === 'providerSubject' ? 'account' : 'unknown',
    quotaScope: 'account',
  };
}

/**
 * Maps a Codex-owned provider HTTP observation to the public Agent usage
 * contract. The CLI host subsequently owns persistence identity and projection.
 */
export function mapCodexProviderHttpUsageSnapshot(
  params: MapCodexProviderHttpUsageSnapshotInput,
): AgentAccountUsageSnapshot {
  const recordKey = buildRecordKey(params.subject);
  return {
    v: 1,
    recordKey,
    providerId: 'openai-codex',
    accountSubject: {
      kind: params.subject.kind,
      id: params.subject.accountSubjectId,
    },
    observedAtMs: normalizeTimestampMs(params.observedAtMs),
    fetchedAtMs: normalizeTimestampMs(params.fetchedAtMs),
    staleAfterMs: params.staleAfterMs,
    source: 'providerHttp',
    confidence: params.subject.kind === 'providerSubject' ? 'confirmed' : 'unknown',
    state: params.meters.length > 0 ? 'loaded_data' : 'loaded_empty',
    planLabel: params.planLabel ?? null,
    accountLabel: params.accountLabel ?? null,
    ...(params.recoveryCredits
      ? { recoveryCredits: { ...params.recoveryCredits, credits: [...params.recoveryCredits.credits] } }
      : {}),
    meters: [...params.meters],
  };
}

export function mapCodexRateLimitSnapshotToProviderAccountUsageSnapshot(
  params: MapCodexRateLimitSnapshotToProviderAccountUsageSnapshotInput,
): AgentAccountUsageSnapshot {
  const recordKey = buildRecordKey(params.subject);
  const state = resolveCodexRuntimeRateLimitsState(params.rawSnapshot).status;
  const recoveryCredits = mapCodexRateLimitResetCredits({
    rawUsage: params.rawSnapshot,
    rawResetCredits: params.rawResetCredits,
  });
  const agentRecoveryCredits = recoveryCredits
    ? { ...recoveryCredits, credits: [...recoveryCredits.credits] }
    : undefined;
  return {
    v: 1,
    recordKey,
    providerId: 'openai-codex',
    accountSubject: {
      kind: params.subject.kind,
      id: params.subject.accountSubjectId,
    },
    observedAtMs: normalizeTimestampMs(params.observedAtMs),
    fetchedAtMs: normalizeTimestampMs(params.fetchedAtMs),
    staleAfterMs: params.staleAfterMs ?? CODEX_RATE_LIMIT_SNAPSHOT_STALE_AFTER_MS,
    source: 'runtimeSignal',
    confidence: params.subject.kind === 'providerSubject' ? 'confirmed' : 'unknown',
    state,
    planLabel: readCodexRateLimitSnapshotPlanLabel(params.rawSnapshot),
    accountLabel: readCodexRateLimitSnapshotAccountLabel(params.rawSnapshot) ?? readString(params.accountLabel),
    ...(agentRecoveryCredits ? { recoveryCredits: agentRecoveryCredits } : {}),
    meters: state === 'loaded_data'
      ? [...mapCodexRateLimitSnapshotToUsageMeters(params.rawSnapshot)]
      : [],
  };
}
