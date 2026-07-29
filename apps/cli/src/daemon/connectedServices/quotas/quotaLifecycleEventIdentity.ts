const QUOTA_LIFECYCLE_RESET_BUCKET_MS = 60_000;

function normalizeEventIdPart(value: string | null | undefined): string {
  const normalized = typeof value === 'string' && value.trim().length > 0 ? value.trim() : 'none';
  return normalized.replace(/[^a-zA-Z0-9._:-]+/gu, '_');
}

export function normalizeQuotaLifecycleResetBucketMs(resetAtMs: number | null | undefined): number | null {
  if (typeof resetAtMs !== 'number' || !Number.isFinite(resetAtMs)) return null;
  const resetAt = Math.max(0, Math.trunc(resetAtMs));
  return Math.floor(resetAt / QUOTA_LIFECYCLE_RESET_BUCKET_MS) * QUOTA_LIFECYCLE_RESET_BUCKET_MS;
}

export function buildQuotaLifecycleCycleId(input: Readonly<{
  resetAtMs: number | null;
}>): string {
  const resetBucketMs = normalizeQuotaLifecycleResetBucketMs(input.resetAtMs);
  return `reset_at_${resetBucketMs ?? 'none'}`;
}

export function normalizeQuotaLifecycleEventCycleId(input: Readonly<{
  resetAtMs?: number | null;
  cycleId?: string | null;
}>): string {
  const resetBucketMs = normalizeQuotaLifecycleResetBucketMs(input.resetAtMs);
  if (resetBucketMs !== null) return `reset_at_${resetBucketMs}`;

  const cycleId = typeof input.cycleId === 'string' ? input.cycleId.trim() : '';
  const resetMatch = /(?:^|:)reset_at_([a-zA-Z0-9._-]+)/u.exec(cycleId);
  if (resetMatch?.[1]) {
    const resetAtMs = Number(resetMatch[1]);
    const resetBucketMs = normalizeQuotaLifecycleResetBucketMs(resetAtMs);
    return `reset_at_${resetBucketMs ?? resetMatch[1]}`;
  }
  return cycleId || 'none';
}

export function buildQuotaLifecycleTranscriptEventId(params: Readonly<{
  eventType: string;
  issueFingerprint: string | null | undefined;
  resetAtMs?: number | null;
  cycleId?: string | null;
  reason: string | null | undefined;
}>): string {
  const issueFingerprint = typeof params.issueFingerprint === 'string' && params.issueFingerprint.trim().length > 0
    ? params.issueFingerprint
    : 'quota-blocked';
  return [
    params.eventType,
    normalizeEventIdPart(issueFingerprint),
    normalizeEventIdPart(normalizeQuotaLifecycleEventCycleId({
      resetAtMs: params.resetAtMs,
      cycleId: params.cycleId,
    })),
    normalizeEventIdPart(params.reason),
  ].join(':');
}
