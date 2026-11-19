import { parseTimestampMs } from '@happier-dev/plugin-sdk';
import type { AgentAccountUsageMeter } from '@happier-dev/plugin-sdk/agents/runtime';
import { resolveConnectedServiceQuotaMeterLabel } from '@happier-dev/plugin-sdk/connected-accounts';
import { resolveConnectedAccountPlanLabel } from '@happier-dev/plugin-sdk/connected-accounts';
import { CODEX_ACCOUNT_USAGE_PLAN_METADATA } from '../../../../connectedAccounts/planLabels.js';

export const CODEX_RATE_LIMIT_SNAPSHOT_STALE_AFTER_MS = 5 * 60 * 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readFiniteNumber(value: unknown): number | null {
  if (typeof value !== 'number' && (typeof value !== 'string' || value.trim().length === 0)) return null;
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function parseProviderTimestampMs(value: unknown): number | null {
  if (typeof value === 'number') return parseTimestampMs(value);
  const numeric = readFiniteNumber(value);
  if (numeric !== null && numeric >= 0) {
    return parseTimestampMs(numeric);
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

function readWindowDurationMs(record: Record<string, unknown>): number | null {
  const exactMs = readFiniteNumber(record.windowDurationMs ?? record.window_duration_ms);
  if (exactMs !== null && exactMs > 0) return Math.round(exactMs);
  const minutes = readFiniteNumber(
    record.windowDurationMins
      ?? record.window_duration_mins
      ?? record.windowMinutes
      ?? record.window_minutes,
  );
  if (minutes !== null && minutes > 0) return Math.round(minutes * 60_000);
  const seconds = readFiniteNumber(
    record.limitWindowSeconds
      ?? record.limit_window_seconds
      ?? record.windowSeconds
      ?? record.window_seconds,
  );
  return seconds !== null && seconds > 0 ? Math.round(seconds * 1_000) : null;
}

export function unwrapCodexRateLimitSnapshot(rawSnapshot: unknown): unknown {
  const record = isRecord(rawSnapshot) ? rawSnapshot : null;
  if (record && isRecord(record.rateLimits)) return record.rateLimits;
  if (record && isRecord(record.rate_limits)) return record.rate_limits;
  if (record && isRecord(record.rate_limit)) return record.rate_limit;
  return rawSnapshot;
}

function buildMeter(input: Readonly<{
  meterId: string;
  window: 'primary' | 'secondary';
  raw: unknown;
  providerLimitId?: string;
  providerLimitLabel?: string | null;
  modelId?: string | null;
  windowLabel?: string;
  scope?: AgentAccountUsageMeter['scope'];
  source?: AgentAccountUsageMeter['source'];
}>): AgentAccountUsageMeter | null {
  const { meterId, raw } = input;
  const record = isRecord(raw) ? raw : null;
  if (!record) return null;
  const utilizationPct = readUtilizationPct(record.usedPercent ?? record.used_percent ?? record.utilizationPct ?? record.utilization_pct);
  const used = readFiniteNumber(record.used ?? record.usedTokens ?? record.used_tokens);
  const limit = readFiniteNumber(record.limit ?? record.tokenLimit ?? record.token_limit);
  const resetsAt = parseProviderTimestampMs(record.resetsAt ?? record.resets_at ?? record.resetAt ?? record.reset_at);
  const windowDurationMs = readWindowDurationMs(record);
  if (utilizationPct === null && used === null && limit === null && resetsAt === null) return null;
  const derivedRemainingPct = utilizationPct !== null
    ? Math.max(0, Math.min(100, 100 - utilizationPct))
    : used !== null && limit !== null && limit > 0
      ? Math.max(0, Math.min(100, ((limit - used) / limit) * 100))
      : null;
  const providerLimitId = input.providerLimitId ?? (
    readString(record.providerLimitId ?? record.provider_limit_id ?? record.limitId ?? record.limit_id)
    ?? meterId
  );
  const knownWindowId = windowDurationMs === 5 * 60 * 60_000 ? 'five_hour'
    : windowDurationMs === 7 * 24 * 60 * 60_000 ? 'seven_day' : null;
  const baseLabel = knownWindowId
    ? resolveConnectedServiceQuotaMeterLabel(knownWindowId)
    : input.windowLabel ?? (input.window === 'primary' ? 'Primary' : 'Secondary');
  return {
    meterId,
    label: input.providerLimitLabel ? `${input.providerLimitLabel} · ${baseLabel}` : baseLabel,
    used,
    limit,
    remainingPct: derivedRemainingPct,
    resetAtMs: resetsAt,
    providerLimitId,
    ...(windowDurationMs !== null ? { windowDurationMs } : {}),
    modelId: input.modelId ?? null,
    unit: 'unknown',
    utilizationPct,
    resetsAt,
    status: 'ok',
    source: input.source ?? 'in_band_provider_snapshot',
    scope: input.scope ?? input.window,
    limitScope: 'account',
    confidence: utilizationPct !== null || (used !== null && limit !== null) ? 'exact' : 'unknown',
    details: {},
  };
}

function readNamedRateLimitMap(rawSnapshot: unknown): Record<string, unknown> | null {
  const envelope = isRecord(rawSnapshot) ? rawSnapshot : null;
  if (!envelope) return null;
  const value = envelope.rateLimitsByLimitId ?? envelope.rate_limits_by_limit_id;
  if (!isRecord(value) || Object.keys(value).length === 0) return null;
  return value;
}

function readNamedRateLimitMetadata(entry: Record<string, unknown>): Readonly<{
  source: Record<string, unknown>;
  providerLimitId: string | null;
  label: string | null;
  modelId: string | null;
}> {
  const source = isRecord(entry.rateLimits)
    ? entry.rateLimits
    : isRecord(entry.rate_limits)
      ? entry.rate_limits
      : isRecord(entry.rate_limit)
        ? entry.rate_limit
      : entry;
  return {
    source,
    providerLimitId: readString(
      entry.providerLimitId ?? entry.provider_limit_id ?? entry.limitId ?? entry.limit_id
      ?? entry.meteredFeature ?? entry.metered_feature
      ?? source.providerLimitId ?? source.provider_limit_id ?? source.limitId ?? source.limit_id,
    ),
    label: readString(
      entry.limitName ?? entry.limit_name ?? entry.displayName ?? entry.display_name ?? entry.name
      ?? source.limitName ?? source.limit_name ?? source.displayName ?? source.display_name ?? source.name,
    ),
    modelId: readString(
      entry.modelId ?? entry.model_id ?? source.modelId ?? source.model_id,
    ),
  };
}

type CodexRateLimitAllowance = Readonly<{
  providerLimitId: string | null;
  label: string | null;
  modelId: string | null;
  source: Record<string, unknown>;
}>;

function collectCodexRateLimitAllowances(rawSnapshot: unknown): readonly CodexRateLimitAllowance[] {
  const root = isRecord(rawSnapshot) ? rawSnapshot : {};
  const allowances: CodexRateLimitAllowance[] = [];
  const seenProviderLimitIds = new Set<string>();
  const add = (value: unknown, fallbackProviderLimitId?: string | null): void => {
    const entry = isRecord(value) ? value : null;
    if (!entry) return;
    const metadata = readNamedRateLimitMetadata(entry);
    const providerLimitId = metadata.providerLimitId ?? readString(fallbackProviderLimitId);
    if (providerLimitId && seenProviderLimitIds.has(providerLimitId)) return;
    if (providerLimitId) seenProviderLimitIds.add(providerLimitId);
    allowances.push({ ...metadata, providerLimitId });
  };

  const named = readNamedRateLimitMap(rawSnapshot);
  if (named) {
    for (const providerLimitId of Object.keys(named).sort()) {
      add(named[providerLimitId], providerLimitId);
    }
  } else {
    add(readCodexRateLimitRecord(rawSnapshot));
  }

  for (const collection of [root.additionalRateLimits, root.additional_rate_limits]) {
    if (Array.isArray(collection)) {
      for (const entry of collection) add(entry);
      continue;
    }
    if (!isRecord(collection)) continue;
    for (const providerLimitId of Object.keys(collection).sort()) {
      add(collection[providerLimitId], providerLimitId);
    }
  }
  return allowances;
}

function readCodexRateLimitRecord(rawSnapshot: unknown): Record<string, unknown> {
  const unwrappedSnapshot = unwrapCodexRateLimitSnapshot(rawSnapshot);
  return isRecord(unwrappedSnapshot) ? unwrappedSnapshot : {};
}

export function readCodexRateLimitSnapshotPlanLabel(rawSnapshot: unknown): string | null {
  const raw = readCodexRateLimitRecord(rawSnapshot);
  const envelope = isRecord(rawSnapshot) ? rawSnapshot : {};
  const plan = readString(raw.planType ?? raw.plan_type ?? envelope.planType ?? envelope.plan_type);
  return resolveConnectedAccountPlanLabel(plan, CODEX_ACCOUNT_USAGE_PLAN_METADATA);
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

function readBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

/**
 * Codex credits (`wham/usage` `credits`, app-server `rateLimits.credits`): the balance Codex spends
 * once the included windows are used up. Headroom comes from the credit facts themselves — a
 * positive balance or unlimited credits, with neither the overage limit nor a workspace spend
 * control reached. `rate_limit.allowed` is deliberately not consulted: whether it stays true while
 * credits pay is unverified. Accounts without any credits facility get no meter.
 */
function buildCodexCreditMeter(
  rawSnapshot: unknown,
  source: AgentAccountUsageMeter['source'] | undefined,
): AgentAccountUsageMeter | null {
  const root = isRecord(rawSnapshot) ? rawSnapshot : {};
  const nested = readCodexRateLimitRecord(rawSnapshot);
  const credits = isRecord(root.credits) ? root.credits : isRecord(nested.credits) ? nested.credits : null;
  if (!credits) return null;
  const hasCredits = readBoolean(credits.has_credits ?? credits.hasCredits) === true;
  const unlimited = readBoolean(credits.unlimited) === true;
  if (!hasCredits && !unlimited) return null;
  const balance = readFiniteNumber(credits.balance);
  const spendControl = isRecord(root.spend_control) ? root.spend_control
    : isRecord(root.spendControl) ? root.spendControl : null;
  const blocked = readBoolean(credits.overage_limit_reached ?? credits.overageLimitReached) === true
    || readBoolean(spendControl?.reached) === true;
  return {
    meterId: 'credits',
    label: 'Credits',
    used: null,
    limit: null,
    remaining: unlimited ? null : balance,
    unit: 'credits',
    utilizationPct: null,
    resetsAt: null,
    isExhausted: blocked || (!unlimited && !(balance !== null && balance > 0)),
    status: 'ok',
    source: source ?? 'in_band_provider_snapshot',
    limitScope: 'account',
    confidence: 'exact',
    details: {},
  };
}

export function mapCodexRateLimitSnapshotToUsageMeters(
  rawSnapshot: unknown,
  options: Readonly<{
    legacyPrimary?: Readonly<{ meterId: string; label: string; scope?: AgentAccountUsageMeter['scope'] }>;
    legacySecondary?: Readonly<{ meterId: string; label: string; scope?: AgentAccountUsageMeter['scope'] }>;
    source?: AgentAccountUsageMeter['source'];
  }> = {},
): readonly AgentAccountUsageMeter[] {
  const legacyPrimary = options.legacyPrimary ?? { meterId: 'primary', label: 'Primary' };
  const legacySecondary = options.legacySecondary ?? { meterId: 'secondary', label: 'Secondary' };
  const allowanceMeters = collectCodexRateLimitAllowances(rawSnapshot).flatMap((allowance) => (
    (['primary', 'secondary'] as const).flatMap((window) => {
      const legacy = window === 'primary' ? legacyPrimary : legacySecondary;
      const meter = buildMeter({
        meterId: allowance.providerLimitId ? `${allowance.providerLimitId}:${window}` : legacy.meterId,
        window,
        raw: allowance.source[window]
          ?? allowance.source[`${window}_window`]
          ?? allowance.source[`${window}Window`],
        ...(allowance.providerLimitId ? { providerLimitId: allowance.providerLimitId } : {}),
        providerLimitLabel: allowance.label ?? allowance.providerLimitId,
        modelId: allowance.modelId,
        ...(!allowance.providerLimitId ? { windowLabel: legacy.label } : {}),
        scope: allowance.providerLimitId ? window : legacy.scope ?? window,
        ...(options.source ? { source: options.source } : {}),
      });
      return meter ? [meter] : [];
    })
  ));
  const creditMeter = buildCodexCreditMeter(rawSnapshot, options.source);
  return creditMeter ? [...allowanceMeters, creditMeter] : allowanceMeters;
}

/**
 * Usage-limit recovery readiness after the provider itself reported a limit: included windows
 * only, because that provider verdict stays authoritative over credit headroom.
 */
export function readCodexRateLimitReadiness(rawSnapshot: unknown):
  | Readonly<{ status: 'ready' }>
  | Readonly<{ status: 'waiting'; resetAtMs: number | null }> {
  const exhausted = mapCodexRateLimitSnapshotToUsageMeters(rawSnapshot).filter((meter) => meter.unit !== 'credits' && (
    meter.isExhausted === true || (meter.utilizationPct !== null && meter.utilizationPct >= 100)
  ));
  if (exhausted.length === 0) return { status: 'ready' };
  let resetAtMs = 0;
  for (const meter of exhausted) {
    if (meter.resetsAt === null) return { status: 'waiting', resetAtMs: null };
    resetAtMs = Math.max(resetAtMs, meter.resetsAt);
  }
  return { status: 'waiting', resetAtMs };
}

export function readCodexRateLimitPlanType(rawSnapshot: unknown): string | null {
  const unwrappedSnapshot = unwrapCodexRateLimitSnapshot(rawSnapshot);
  const snapshot = isRecord(unwrappedSnapshot) ? unwrappedSnapshot : null;
  return readString(snapshot?.plan_type ?? snapshot?.planType);
}
