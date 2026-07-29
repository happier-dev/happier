import type { ProviderAccountUsageSnapshotV1 } from '@happier-dev/protocol';

export type QuotaLifecycleEvidenceRejectionReason =
  | 'generation_mismatch'
  | 'unstable_subject'
  | 'insufficient_confidence'
  | 'not_loaded'
  | 'stale'
  | 'missing_meters';

export type QuotaLifecycleEvidenceDecision =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; reason: QuotaLifecycleEvidenceRejectionReason }>;

export function canDisplayAccountUsageForQuota(snapshot: ProviderAccountUsageSnapshotV1): boolean {
  return snapshot.state !== 'not_loaded';
}

export function canDriveQuotaLifecycleEdge(input: Readonly<{
  snapshot: ProviderAccountUsageSnapshotV1;
  expectedGroupGeneration: number;
  observedGroupGeneration: number;
  nowMs: number;
  quotaFreshnessMs: number;
  allowUnconfirmedConfidence?: boolean;
}>): QuotaLifecycleEvidenceDecision {
  if (input.observedGroupGeneration !== input.expectedGroupGeneration) {
    return { ok: false, reason: 'generation_mismatch' };
  }
  if (
    input.snapshot.accountSubject.kind !== 'providerSubject'
    || input.snapshot.recordKey.subjectKind === 'unknown'
  ) {
    return { ok: false, reason: 'unstable_subject' };
  }
  if (!input.allowUnconfirmedConfidence && input.snapshot.confidence !== 'confirmed') {
    return { ok: false, reason: 'insufficient_confidence' };
  }
  if (input.snapshot.state !== 'loaded_data') {
    return { ok: false, reason: 'not_loaded' };
  }
  if (input.snapshot.meters.length === 0) {
    return { ok: false, reason: 'missing_meters' };
  }

  const fetchedAtMs = input.snapshot.fetchedAtMs;
  const staleAtMs = fetchedAtMs + input.snapshot.staleAfterMs;
  if (
    input.nowMs > staleAtMs
    || input.nowMs - fetchedAtMs > input.quotaFreshnessMs
  ) {
    return { ok: false, reason: 'stale' };
  }

  return { ok: true };
}

export function canDriveSoftSwitch(input: Readonly<{
  snapshot: ProviderAccountUsageSnapshotV1;
  expectedGroupGeneration: number;
  observedGroupGeneration: number;
  nowMs: number;
  quotaFreshnessMs: number;
}>): QuotaLifecycleEvidenceDecision {
  return canDriveQuotaLifecycleEdge({
    snapshot: input.snapshot,
    expectedGroupGeneration: input.expectedGroupGeneration,
    observedGroupGeneration: input.observedGroupGeneration,
    nowMs: input.nowMs,
    quotaFreshnessMs: input.quotaFreshnessMs,
  });
}
