import {
  ConnectedServiceQuotaSnapshotV1Schema,
  type ConnectedServiceId,
  type ConnectedServiceProfileId,
  type ConnectedServiceQuotaMeterV1,
  type ConnectedServiceQuotaSnapshotV1,
} from '@happier-dev/protocol';

import { mapCodexRateLimitResetCreditsToQuotaRecoveryCredits } from '../quota/codexQuotaRecoveryCredits';
import { unwrapCodexRateLimitSnapshot } from '../appServer/rateLimitSnapshot';
import { parseProviderTimestampMs } from '@/daemon/connectedServices/quotas/normalization';

export const CODEX_RATE_LIMIT_SNAPSHOT_STALE_AFTER_MS = 5 * 60 * 1000;
const RESET_AT_PLAUSIBILITY_FLOOR_TOLERANCE_MS = 24 * 60 * 60_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function formatProviderLimitLabel(providerLimitId: string | null): string | null {
  if (!providerLimitId) return null;
  const words = providerLimitId.split(/[-_.:\s]+/).filter(Boolean);
  if (words.length === 0) return providerLimitId;
  return words.map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`).join(' ');
}

function readCodexSnapshotAccount(rawSnapshot: unknown, unwrappedSnapshot: unknown): Record<string, unknown> {
  const rawRecord = isRecord(rawSnapshot) ? rawSnapshot : {};
  const unwrappedRecord = isRecord(unwrappedSnapshot) ? unwrappedSnapshot : {};
  const account =
    (isRecord(unwrappedRecord.account) ? unwrappedRecord.account : null)
    ?? (isRecord(rawRecord.account) ? rawRecord.account : null)
    ?? {};
  return account;
}

function readCodexSnapshotActiveAccountId(account: Record<string, unknown>): string | null {
  return readString(
    account.id
      ?? account.accountId
      ?? account.account_id
      ?? account.chatgptAccountId
      ?? account.chatgpt_account_id,
  );
}

function readFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text.length === 0) return null;
  const numeric = Number(text);
  return Number.isFinite(numeric) ? numeric : null;
}

function readUtilizationPct(value: unknown): number | null {
  const numeric = readFiniteNumber(value);
  if (numeric === null) return null;
  return Math.max(0, Math.min(100, numeric));
}

function readWindowDurationMs(record: Record<string, unknown>): number | null {
  const exactMs = readFiniteNumber(record.windowDurationMs ?? record.window_duration_ms);
  if (exactMs !== null && exactMs > 0) return Math.trunc(exactMs);

  const minutes = readFiniteNumber(
    record.windowDurationMins
      ?? record.window_duration_mins
      ?? record.windowMinutes
      ?? record.window_minutes,
  );
  if (minutes !== null && minutes > 0) return Math.trunc(minutes * 60_000);

  const seconds = readFiniteNumber(
    record.limitWindowSeconds
      ?? record.limit_window_seconds
      ?? record.windowSeconds
      ?? record.window_seconds,
  );
  return seconds !== null && seconds > 0 ? Math.trunc(seconds * 1000) : null;
}

function readRelativeResetAtMs(record: Record<string, unknown>, nowMs: number): number | null {
  const seconds = readFiniteNumber(record.resetsInSeconds ?? record.resets_in_seconds);
  if (seconds === null || seconds < 0) return null;
  return Math.trunc(nowMs + seconds * 1000);
}

function readAbsoluteResetAtMs(record: Record<string, unknown>, nowMs: number): number | null {
  const resetAtMs = parseProviderTimestampMs(record.resetsAt ?? record.resets_at ?? record.resetAt ?? record.reset_at);
  if (resetAtMs === null || resetAtMs < nowMs - RESET_AT_PLAUSIBILITY_FLOOR_TOLERANCE_MS) return null;
  return resetAtMs;
}

type CodexRateLimitAllowance = Readonly<{
  providerLimitId: string | null;
  label: string | null;
  modelId: string | null;
  snapshot: Record<string, unknown>;
}>;

function readAllowance(raw: unknown, fallbackId?: string | null): CodexRateLimitAllowance | null {
  const record = isRecord(raw) ? raw : null;
  if (!record) return null;
  const nested = isRecord(record.rate_limit) ? record.rate_limit : isRecord(record.rateLimits) ? record.rateLimits : record;
  return {
    providerLimitId:
      readString(
        record.limitId
        ?? record.limit_id
        ?? record.providerLimitId
        ?? record.provider_limit_id
        ?? record.meteredFeature
        ?? record.metered_feature,
      )
      ?? readString(nested.limitId ?? nested.limit_id ?? nested.providerLimitId ?? nested.provider_limit_id)
      ?? readString(fallbackId),
    label:
      readString(record.limitName ?? record.limit_name ?? record.label ?? record.name)
      ?? readString(nested.limitName ?? nested.limit_name ?? nested.label ?? nested.name),
    modelId:
      readString(record.modelId ?? record.model_id ?? record.model)
      ?? readString(nested.modelId ?? nested.model_id ?? nested.model),
    snapshot: nested,
  };
}

function collectAllowanceEntries(rawSnapshot: unknown): readonly CodexRateLimitAllowance[] {
  const root = isRecord(rawSnapshot) ? rawSnapshot : {};
  const entries: CodexRateLimitAllowance[] = [];
  const seenIds = new Set<string>();
  const add = (raw: unknown, fallbackId?: string | null): void => {
    const allowance = readAllowance(raw, fallbackId);
    if (!allowance) return;
    if (allowance.providerLimitId && seenIds.has(allowance.providerLimitId)) return;
    if (allowance.providerLimitId) seenIds.add(allowance.providerLimitId);
    entries.push(allowance);
  };
  const keyedLimits = isRecord(root.rateLimitsByLimitId)
    ? root.rateLimitsByLimitId
    : isRecord(root.rate_limits_by_limit_id)
      ? root.rate_limits_by_limit_id
      : null;
  if (keyedLimits && Object.keys(keyedLimits).length > 0) {
    for (const [limitId, item] of Object.entries(keyedLimits)) add(item, limitId);
  } else {
    add(unwrapCodexRateLimitSnapshot(rawSnapshot));
  }
  const maps = [root.additional_rate_limits, root.additionalRateLimits];
  for (const collection of maps) {
    if (Array.isArray(collection)) {
      for (const item of collection) add(item);
    } else if (isRecord(collection)) {
      for (const [limitId, item] of Object.entries(collection)) add(item, limitId);
    }
  }
  return entries;
}

function buildMeter(
  meterKind: 'primary' | 'secondary',
  raw: unknown,
  nowMs: number,
  allowance: Pick<CodexRateLimitAllowance, 'providerLimitId' | 'label' | 'modelId'>,
  legacyPresentation: Readonly<{ meterId: string; label: string }>,
): ConnectedServiceQuotaMeterV1 | null {
  const record = isRecord(raw) ? raw : null;
  if (!record) return null;
  const utilizationPct = readUtilizationPct(record.usedPercent ?? record.used_percent ?? record.utilizationPct ?? record.utilization_pct);
  const used = readFiniteNumber(record.used ?? record.usedTokens ?? record.used_tokens);
  const limit = readFiniteNumber(record.limit ?? record.tokenLimit ?? record.token_limit);
  // Absolute reset fields win; legacy relative `resets_in_seconds` shapes are converted
  // to an absolute timestamp at mapping time (RD-QUO-1) so F0 durable-wait timing and
  // member providerResetsAtMs carry true reset evidence instead of null.
  const resetsAt = readAbsoluteResetAtMs(record, nowMs)
    ?? readRelativeResetAtMs(record, nowMs);
  if (utilizationPct === null && used === null && limit === null && resetsAt === null) return null;
  const derivedRemainingPct = utilizationPct !== null
    ? Math.max(0, Math.min(100, 100 - utilizationPct))
    : used !== null && limit !== null && limit > 0
    ? Math.max(0, Math.min(100, ((limit - used) / limit) * 100))
    : null;
  const providerLimitId =
    readString(record.providerLimitId ?? record.provider_limit_id ?? record.limitId ?? record.limit_id)
    ?? allowance.providerLimitId
    ?? legacyPresentation.meterId;
  const meterId = allowance.providerLimitId ? `${allowance.providerLimitId}:${meterKind}` : legacyPresentation.meterId;
  const allowanceLabel = allowance.label ?? formatProviderLimitLabel(allowance.providerLimitId);
  const windowDurationMs = readWindowDurationMs(record);
  const windowLabel = windowDurationMs === 5 * 60 * 60_000
    ? '5 hour'
    : windowDurationMs === 7 * 24 * 60 * 60_000
      ? 'Weekly'
      : null;
  return {
    meterId,
    label: allowanceLabel
      ? `${allowanceLabel} · ${windowLabel ?? (meterKind === 'primary' ? 'Primary' : 'Secondary')}`
      : windowLabel ?? legacyPresentation.label,
    used,
    limit,
    remainingPct: derivedRemainingPct,
    resetAtMs: resetsAt,
    providerLimitId,
    ...(windowDurationMs !== null ? { windowDurationMs } : {}),
    ...(allowance.modelId ? { modelId: allowance.modelId } : {}),
    unit: 'unknown',
    utilizationPct,
    resetsAt,
    status: 'ok',
    source: 'in_band_provider_snapshot',
    scope: meterKind,
    limitScope: 'account',
    confidence: utilizationPct !== null || (used !== null && limit !== null) ? 'exact' : 'unknown',
    details: {},
  };
}

export function mapCodexRateLimitPayloadToQuotaMeters(
  rawSnapshot: unknown,
  nowMs: number,
  options: Readonly<{
    legacyPrimary?: Readonly<{ meterId: string; label: string }>;
    legacySecondary?: Readonly<{ meterId: string; label: string }>;
  }> = {},
): readonly ConnectedServiceQuotaMeterV1[] {
  const primary = options.legacyPrimary ?? { meterId: 'primary', label: 'Primary' };
  const secondary = options.legacySecondary ?? { meterId: 'secondary', label: 'Secondary' };
  return collectAllowanceEntries(rawSnapshot).flatMap((allowance) => {
    const raw = allowance.snapshot;
    return [
      buildMeter('primary', raw.primary ?? raw.primary_window ?? raw.primaryWindow, nowMs, allowance, primary),
      buildMeter('secondary', raw.secondary ?? raw.secondary_window ?? raw.secondaryWindow, nowMs, allowance, secondary),
    ].filter((meter): meter is ConnectedServiceQuotaMeterV1 => meter !== null);
  });
}

export function mapCodexRateLimitSnapshotToQuotaSnapshot(params: Readonly<{
  serviceId: ConnectedServiceId;
  profileId: ConnectedServiceProfileId;
  activeAccountId?: string | null;
  accountLabel?: string | null;
  fetchedAt: number;
  staleAfterMs?: number;
  rawSnapshot: unknown;
  rawResetCredits?: unknown;
}>): ConnectedServiceQuotaSnapshotV1 {
  const unwrappedSnapshot = unwrapCodexRateLimitSnapshot(params.rawSnapshot);
  const rawRoot = isRecord(params.rawSnapshot) ? params.rawSnapshot : {};
  const raw = isRecord(unwrappedSnapshot) ? unwrappedSnapshot : {};
  const account = readCodexSnapshotAccount(params.rawSnapshot, unwrappedSnapshot);
  const relativeResetReferenceMs = Math.max(0, Math.trunc(params.fetchedAt));
  const resetCredits = mapCodexRateLimitResetCreditsToQuotaRecoveryCredits(
    params.rawResetCredits ?? rawRoot.rate_limit_reset_credits ?? raw.rate_limit_reset_credits,
  );
  const meters = mapCodexRateLimitPayloadToQuotaMeters(params.rawSnapshot, relativeResetReferenceMs);
  const activeAccountId = readString(params.activeAccountId) ?? readCodexSnapshotActiveAccountId(account);

  return ConnectedServiceQuotaSnapshotV1Schema.parse({
    v: 1,
    serviceId: params.serviceId,
    profileId: params.profileId,
    fetchedAt: Math.max(0, Math.trunc(params.fetchedAt)),
    staleAfterMs: params.staleAfterMs ?? CODEX_RATE_LIMIT_SNAPSHOT_STALE_AFTER_MS,
    providerId: 'codex',
    ...(activeAccountId ? { activeAccountId } : {}),
    fetchedAtMs: Math.max(0, Math.trunc(params.fetchedAt)),
    staleAtMs: Math.max(0, Math.trunc(params.fetchedAt)) + (params.staleAfterMs ?? CODEX_RATE_LIMIT_SNAPSHOT_STALE_AFTER_MS),
    source: 'in_band_provider_snapshot',
    confidence: meters.length > 0 ? 'exact' : 'unknown',
    planLabel: readString(raw.planType ?? raw.plan_type ?? rawRoot.planType ?? rawRoot.plan_type),
    accountLabel: readString(account.email ?? raw.email ?? rawRoot.email ?? raw.accountLabel ?? raw.account_label ?? params.accountLabel),
    ...(resetCredits ? { recoveryCredits: resetCredits } : {}),
    meters,
  });
}
