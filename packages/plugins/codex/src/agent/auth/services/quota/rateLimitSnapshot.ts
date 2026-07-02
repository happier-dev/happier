import {
  ConnectedServiceQuotaSnapshotV1Schema,
  type ConnectedServiceId,
  type ConnectedServiceProfileId,
  type ConnectedServiceQuotaMeterV1,
  type ConnectedServiceQuotaSnapshotV1,
} from '@happier-dev/protocol';

export const CODEX_RATE_LIMIT_SNAPSHOT_STALE_AFTER_MS = 5 * 60 * 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readFiniteNumber(value: unknown): number | null {
  if (typeof value === 'string' && value.trim().length === 0) return null;
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function parseProviderTimestampMs(value: unknown): number | null {
  const numeric = readFiniteNumber(value);
  if (numeric !== null && numeric >= 0) {
    return Math.trunc(numeric < 10_000_000_000 ? numeric * 1000 : numeric);
  }
  const text = readString(value);
  if (!text) return null;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function readUtilizationPct(value: unknown): number | null {
  const numeric = readFiniteNumber(value);
  if (numeric === null) return null;
  return Math.max(0, Math.min(100, numeric));
}

export function unwrapCodexRateLimitSnapshot(rawSnapshot: unknown): unknown {
  const record = isRecord(rawSnapshot) ? rawSnapshot : null;
  if (record && isRecord(record.rateLimits)) return record.rateLimits;
  if (record && isRecord(record.rate_limits)) return record.rate_limits;
  return rawSnapshot;
}

function buildMeter(meterId: 'primary' | 'secondary', raw: unknown): ConnectedServiceQuotaMeterV1 | null {
  const record = isRecord(raw) ? raw : null;
  if (!record) return null;
  const utilizationPct = readUtilizationPct(record.usedPercent ?? record.used_percent ?? record.utilizationPct ?? record.utilization_pct);
  const used = readFiniteNumber(record.used ?? record.usedTokens ?? record.used_tokens);
  const limit = readFiniteNumber(record.limit ?? record.tokenLimit ?? record.token_limit);
  const resetsAt = parseProviderTimestampMs(record.resetsAt ?? record.resets_at ?? record.resetAt ?? record.reset_at);
  if (utilizationPct === null && used === null && limit === null && resetsAt === null) return null;
  const derivedRemainingPct = utilizationPct !== null
    ? Math.max(0, Math.min(100, 100 - utilizationPct))
    : used !== null && limit !== null && limit > 0
      ? Math.max(0, Math.min(100, ((limit - used) / limit) * 100))
      : null;
  const providerLimitId =
    readString(record.providerLimitId ?? record.provider_limit_id ?? record.limitId ?? record.limit_id)
    ?? meterId;
  return {
    meterId,
    label: meterId === 'primary' ? 'Primary' : 'Secondary',
    used,
    limit,
    remainingPct: derivedRemainingPct,
    resetAtMs: resetsAt,
    providerLimitId,
    unit: 'unknown',
    utilizationPct,
    resetsAt,
    status: 'ok',
    source: 'in_band_provider_snapshot',
    scope: meterId,
    limitScope: 'account',
    confidence: utilizationPct !== null || (used !== null && limit !== null) ? 'exact' : 'unknown',
    details: {},
  };
}

export function mapCodexRateLimitSnapshotToQuotaSnapshot(params: Readonly<{
  serviceId: ConnectedServiceId;
  profileId: ConnectedServiceProfileId;
  activeAccountId?: string | null;
  accountLabel?: string | null;
  fetchedAt: number;
  staleAfterMs?: number;
  rawSnapshot: unknown;
}>): ConnectedServiceQuotaSnapshotV1 {
  const activeAccountId = readString(params.activeAccountId);
  return ConnectedServiceQuotaSnapshotV1Schema.parse({
    v: 1,
    serviceId: params.serviceId,
    profileId: params.profileId,
    ...(activeAccountId ? { activeAccountId } : {}),
    fetchedAt: Math.max(0, Math.trunc(params.fetchedAt)),
    staleAfterMs: params.staleAfterMs ?? CODEX_RATE_LIMIT_SNAPSHOT_STALE_AFTER_MS,
    planLabel: readCodexRateLimitSnapshotPlanLabel(params.rawSnapshot),
    accountLabel: readCodexRateLimitSnapshotAccountLabel(params.rawSnapshot) ?? readString(params.accountLabel),
    meters: mapCodexRateLimitSnapshotToUsageMeters(params.rawSnapshot),
  });
}

function readCodexRateLimitMeter(rawSnapshot: unknown, key: 'primary' | 'secondary'): Record<string, unknown> | null {
  const unwrappedSnapshot = unwrapCodexRateLimitSnapshot(rawSnapshot);
  const snapshot = isRecord(unwrappedSnapshot) ? unwrappedSnapshot : null;
  return snapshot && isRecord(snapshot[key]) ? snapshot[key] : null;
}

function readCodexRateLimitRecord(rawSnapshot: unknown): Record<string, unknown> {
  const unwrappedSnapshot = unwrapCodexRateLimitSnapshot(rawSnapshot);
  return isRecord(unwrappedSnapshot) ? unwrappedSnapshot : {};
}

export function readCodexRateLimitSnapshotPlanLabel(rawSnapshot: unknown): string | null {
  const raw = readCodexRateLimitRecord(rawSnapshot);
  const envelope = isRecord(rawSnapshot) ? rawSnapshot : {};
  return readString(raw.planType ?? raw.plan_type ?? envelope.planType ?? envelope.plan_type);
}

export function readCodexRateLimitSnapshotAccountLabel(rawSnapshot: unknown): string | null {
  const raw = readCodexRateLimitRecord(rawSnapshot);
  const envelope = isRecord(rawSnapshot) ? rawSnapshot : {};
  const account = isRecord(raw.account) ? raw.account : {};
  const envelopeAccount = isRecord(envelope.account) ? envelope.account : {};
  return readString(
    account.email
      ?? raw.email
      ?? raw.accountLabel
      ?? raw.account_label
      ?? envelopeAccount.email
      ?? envelope.email
      ?? envelope.accountLabel
      ?? envelope.account_label,
  );
}

export function mapCodexRateLimitSnapshotToUsageMeters(rawSnapshot: unknown): readonly ConnectedServiceQuotaMeterV1[] {
  const raw = readCodexRateLimitRecord(rawSnapshot);
  return [
    buildMeter('primary', raw.primary ?? raw.primary_window ?? raw.primaryWindow),
    buildMeter('secondary', raw.secondary ?? raw.secondary_window ?? raw.secondaryWindow),
  ].filter((meter): meter is ConnectedServiceQuotaMeterV1 => meter !== null);
}

export function isCodexRateLimitSnapshotExhausted(rawSnapshot: unknown): boolean {
  for (const key of ['primary', 'secondary'] as const) {
    const meter = readCodexRateLimitMeter(rawSnapshot, key);
    const usedPercent = readFiniteNumber(meter?.usedPercent ?? meter?.used_percent ?? meter?.utilizationPct ?? meter?.utilization_pct);
    if (usedPercent !== null && usedPercent >= 100) return true;
    const status = readString(meter?.status)?.toLowerCase();
    if (status === 'exhausted' || status === 'limited' || status === 'rate_limited') return true;
  }
  return false;
}

export function readEarliestCodexRateLimitResetAtMs(rawSnapshot: unknown): number | null {
  const resets = (['primary', 'secondary'] as const)
    .map((key) => {
      const meter = readCodexRateLimitMeter(rawSnapshot, key);
      return parseProviderTimestampMs(meter?.resetsAt ?? meter?.resets_at ?? meter?.resetAt ?? meter?.reset_at);
    })
    .filter((value): value is number => value !== null);
  return resets.length > 0 ? Math.min(...resets) : null;
}

export function readCodexRateLimitPlanType(rawSnapshot: unknown): string | null {
  const unwrappedSnapshot = unwrapCodexRateLimitSnapshot(rawSnapshot);
  const snapshot = isRecord(unwrappedSnapshot) ? unwrappedSnapshot : null;
  return readString(snapshot?.plan_type ?? snapshot?.planType);
}
