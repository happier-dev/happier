import type { ConnectedServiceQuotaMeterV1 } from '@happier-dev/protocol';
import { isAgyInternalQuotaModel, resolveAgyQuotaPoolForModel, resolveAgyQuotaPoolForLimit, resolveAgyQuotaModelFamily } from '@happier-dev/agents';
import { isRecord, normalizeNonEmptyString } from '@/daemon/connectedServices/quotas/quotaNormalization';
import { parseProviderTimestampMs } from '@/daemon/connectedServices/quotas/normalization/parseRetryAfterHeader';

function meter(input: Readonly<{
  id: string; label: string; quota: Record<string, unknown>; modelId?: string;
  scope?: ConnectedServiceQuotaMeterV1['scope']; providerLimitId?: string;
  confidence?: ConnectedServiceQuotaMeterV1['confidence'];
  windowDurationMs?: number;
}>): ConnectedServiceQuotaMeterV1 {
  const fraction = input.quota.remainingFraction;
  const remainingPct = typeof fraction === 'number' && Number.isFinite(fraction) && fraction >= 0 && fraction <= 1
    ? fraction * 100 : null;
  const usedPct = remainingPct === null ? null : 100 - remainingPct;
  const resetAtMs = parseProviderTimestampMs(input.quota.resetTime);
  return {
    meterId: input.id, label: input.label, used: null, limit: null, remaining: null,
    remainingPct, usedPct, utilizationPct: usedPct, resetAtMs, resetsAt: resetAtMs,
    ...(resetAtMs === null ? {} : { resetSource: 'provider' }),
    ...(input.modelId ? { modelId: input.modelId } : {}),
    ...(input.providerLimitId ? { providerLimitId: input.providerLimitId } : {}),
    ...(input.windowDurationMs ? { windowDurationMs: input.windowDurationMs } : {}),
    unit: 'unknown', status: remainingPct === null ? 'unavailable' : 'ok', source: 'provider_api',
    confidence: remainingPct === null ? 'unknown' : input.confidence ?? 'exact',
    scope: input.scope ?? 'model', limitScope: input.modelId ? 'model' : 'account',
    ...(remainingPct === null ? {} : { isExhausted: remainingPct === 0 }),
    details: remainingPct === null ? { code: 'quota_unknown' } : {},
  };
}

/** Live buckets override catalog data, including an explicitly unknown allowance. */
/**
 * Combines live model readings with catalog labels and explicitly reported shared limits.
 * Shared five-hour pools replace per-model duplicates; missing summaries retain
 * conservative model-family readings without inventing totals, confidence, or reset times.
 */
export function normalizeAgyQuota(input: Readonly<{ live: unknown; catalog: unknown; summary: unknown }>): ConnectedServiceQuotaMeterV1[] {
  const models = isRecord(input.catalog) && isRecord(input.catalog.models) ? input.catalog.models : {};
  const tabModels = new Set(isRecord(input.catalog) && Array.isArray(input.catalog.tabModelIds) ? input.catalog.tabModelIds : []);
  const internal = (modelId: string) => isAgyInternalQuotaModel(modelId) || tabModels.has(modelId) || (isRecord(models[modelId]) && models[modelId].isInternal === true);
  const byModel = new Map<string, ConnectedServiceQuotaMeterV1>();
  for (const [modelId, raw] of Object.entries(models)) {
    if (internal(modelId) || !isRecord(raw) || !isRecord(raw.quotaInfo)) continue;
    byModel.set(modelId, meter({ id: `model:${modelId}`, modelId, label: normalizeNonEmptyString(raw.displayName) ?? modelId, quota: raw.quotaInfo, confidence: 'estimated' }));
  }
  if (isRecord(input.live) && Array.isArray(input.live.buckets)) {
    for (const raw of input.live.buckets) {
      if (!isRecord(raw)) continue;
      const modelId = normalizeNonEmptyString(raw.modelId);
      if (!modelId || internal(modelId)) continue;
      const model = models[modelId];
      byModel.set(modelId, meter({ id: `model:${modelId}`, modelId, label: isRecord(model) ? normalizeNonEmptyString(model.displayName) ?? modelId : modelId, quota: raw }));
    }
  }
  const shared: ConnectedServiceQuotaMeterV1[] = [];
  const summary = isRecord(input.summary) && isRecord(input.summary.quotaSummary) ? input.summary.quotaSummary : input.summary;
  if (isRecord(summary) && Array.isArray(summary.groups)) {
    for (const [groupIndex, group] of summary.groups.entries()) {
      if (!isRecord(group) || !Array.isArray(group.buckets)) continue;
      const groupLabel = normalizeNonEmptyString(group.displayName) ?? `Quota group ${groupIndex + 1}`;
      for (const [bucketIndex, raw] of group.buckets.entries()) {
        if (!isRecord(raw) || raw.disabled === true) continue;
        const bucketId = normalizeNonEmptyString(raw.bucketId);
        const label = normalizeNonEmptyString(raw.displayName) ?? normalizeNonEmptyString(raw.description) ?? 'Shared allowance';
        const window = normalizeNonEmptyString(raw.window);
        // Only explicit provider window facts label weekly/five-hour usage. No reset-date guesses.
        const scope = window === 'weekly' ? 'weekly' : window === '5h' ? 'five_hour' : 'unknown';
        const pool = resolveAgyQuotaPoolForLimit(bucketId);
        const duration = window === 'weekly' ? 604_800_000 : window === '5h' ? 18_000_000 : undefined;
        const shortLabel = pool && duration ? `${pool === 'gemini' ? 'Gemini' : 'Claude / GPT'} · ${window === 'weekly' ? 'Weekly' : '5 hours'}` : `${groupLabel} — ${label}`;
        shared.push(meter({ id: `shared:${bucketId ?? `${groupLabel}:${bucketIndex}`}`, label: shortLabel, quota: raw, scope, ...(duration ? { windowDurationMs: duration } : {}), ...(bucketId ? { providerLimitId: bucketId } : {}) }));
      }
    }
  }
  // A five-hour summary replaces the repeated per-model allowance for that pool.
  // A weekly-only or unknown window cannot replace a missing short-window reading.
  const coveredPools = new Set(shared.filter((m) => m.scope === 'five_hour').map((m) => resolveAgyQuotaPoolForLimit(m.providerLimitId)).filter(Boolean));
  const fallback = new Map<string, ConnectedServiceQuotaMeterV1>();
  for (const [modelId, modelMeter] of byModel) {
    if (coveredPools.has(resolveAgyQuotaPoolForModel(modelId))) continue;
    const family = resolveAgyQuotaModelFamily(modelId);
    const id = family ? `family:${family.id}` : modelMeter.meterId;
    const previous = fallback.get(id);
    // Keep a whole observation, with its reset and confidence. Missing values
    // stay unknown; otherwise choose the most constrained variant, never sum.
    if (previous && (previous.remainingPct == null || (modelMeter.remainingPct != null && previous.remainingPct <= modelMeter.remainingPct))) continue;
    const { modelId: _modelId, ...familyMeter } = modelMeter;
    fallback.set(id, family ? { ...familyMeter, meterId: id, label: family.label } : modelMeter);
  }
  const order = ['gemini-5h', 'gemini-weekly', '3p-5h', '3p-weekly'];
  const rank = (m: ConnectedServiceQuotaMeterV1) => { const index = order.indexOf(m.providerLimitId ?? ''); return index < 0 ? order.length : index; };
  shared.sort((a, b) => rank(a) - rank(b));
  return [...fallback.values(), ...shared];
}
