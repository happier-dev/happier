import {
  ProviderAccountUsageSnapshotV1Schema,
  buildProviderAccountUsageRecordId,
  type ProviderAccountUsageSnapshotV1,
} from '@happier-dev/plugin-sdk/experimental/cloud/usage';

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

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeTimestampMs(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function buildRecordKey(subject: CodexUsageSubjectRef): ProviderAccountUsageSnapshotV1['recordKey'] {
  return {
    providerId: 'openai-codex',
    accountSubjectId: subject.accountSubjectId,
    subjectKind: subject.kind === 'providerSubject' ? 'account' : 'unknown',
    quotaScope: 'account',
  };
}

export function mapCodexRateLimitSnapshotToProviderAccountUsageSnapshot(
  params: MapCodexRateLimitSnapshotToProviderAccountUsageSnapshotInput,
): ProviderAccountUsageSnapshotV1 {
  const recordKey = buildRecordKey(params.subject);
  const state = resolveCodexRuntimeRateLimitsState(params.rawSnapshot).status;
  const recoveryCredits = mapCodexRateLimitResetCredits({
    rawUsage: params.rawSnapshot,
    rawResetCredits: params.rawResetCredits,
  });
  return ProviderAccountUsageSnapshotV1Schema.parse({
    v: 1,
    recordId: buildProviderAccountUsageRecordId(recordKey),
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
    ...(recoveryCredits ? { recoveryCredits } : {}),
    meters: state === 'loaded_data'
      ? mapCodexRateLimitSnapshotToUsageMeters(params.rawSnapshot)
      : [],
  });
}
