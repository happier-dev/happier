import { parseProviderTimestampMs, type ConnectedAccountCompletionObservation, type ConnectedAccountRuntime } from '@happier-dev/plugin-sdk/connected-accounts';
import { PluginError } from '@happier-dev/plugin-sdk';
import { museRecord } from './nativeAuth.js';
export type MuseQuotaObservation = Awaited<ReturnType<NonNullable<ConnectedAccountRuntime['quota']>>>;
export type MuseUsageObservationResult =
  | Readonly<{ status: 'supported'; observation: MuseQuotaObservation }>
  | Readonly<{ status: 'unavailable'; reason: 'api_key' | 'no_allowance' | 'server_sent_no_usage' | 'unsupported' | 'malformed' }>;
function timestamp(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }

/** Normalize characterized native MSP/CLI data, never acquire or infer an allowance. */
export function parseMuseUsageObservation(value: unknown): MuseUsageObservationResult {
  const root = museRecord(value);
  if (!root) return { status: 'unavailable', reason: 'malformed' };
  if (root.schemaVersion !== undefined && root.schemaVersion !== 1) return { status: 'unavailable', reason: 'unsupported' };
  if (root.allowance === null) return { status: 'unavailable', reason: root.reason === 'api_key' || root.reason === 'no_allowance' ? root.reason : 'server_sent_no_usage' };
  if ('allowance' in root && root.schemaVersion !== 1) return { status: 'unavailable', reason: 'malformed' };
  if (root.schemaVersion === 1 && !('allowance' in root)) return { status: 'unavailable', reason: 'malformed' };
  // MSP notifications carry SubscriptionUsage directly; reads carry { usage }.
  const rawUsage = root.usage ?? root.allowance ?? ('observedAtMs' in root ? root : undefined);
  const usage = museRecord(rawUsage);
  if (!usage) return { status: 'unavailable', reason: rawUsage === undefined || rawUsage === null ? 'server_sent_no_usage' : 'malformed' };
  const observedAtMs = usage.observedAtMs ?? usage.asOfMs ?? root.asOfMs;
  if (!timestamp(observedAtMs)) return { status: 'unavailable', reason: 'malformed' };
  const limits: MuseQuotaObservation['limits'][number][] = [];
  for (const id of ['weekly', 'window'] as const) {
    const raw = usage[id];
    if (raw === undefined || raw === null) continue;
    const window = museRecord(raw);
    if (!window || typeof window.usedPercent !== 'number' || !Number.isFinite(window.usedPercent) || window.usedPercent < 0
      || (window.resetsAtMs != null && !timestamp(window.resetsAtMs))
      || (window.windowDurationMins != null && (typeof window.windowDurationMins !== 'number' || !Number.isFinite(window.windowDurationMins) || window.windowDurationMins <= 0))) return { status: 'unavailable', reason: 'malformed' };
    limits.push({ id, label: id === 'weekly' ? 'Weekly' : 'Rolling window',
      used: window.usedPercent, limit: 100, utilizationPct: window.usedPercent,
      remainingPct: Math.max(0, 100 - window.usedPercent), isExhausted: window.usedPercent >= 100,
      ...(timestamp(window.resetsAtMs) ? { resetsAtMs: window.resetsAtMs } : {}),
      ...(typeof window.windowDurationMins === 'number' ? { windowDurationMs: window.windowDurationMins * 60000 } : {}),
    });
  }
  if (limits.length === 0) return { status: 'unavailable', reason: 'server_sent_no_usage' };
  const planLabel = typeof usage.tier === 'string' ? usage.tier.trim() : '';
  return { status: 'supported', observation: { observedAtMs, ...(planLabel ? { planLabel } : {}), limits } };
}

/** No independently characterized non-acquiring CLI refresh source exists yet. */
export function readMuseQuotaObservation(): never {
  throw new PluginError({ code: 'plugin_connected_account_usage_unavailable', message: 'Muse has not supplied a safe subscription usage sample.',
    details: { reason: 'safe_source_unavailable' } });
}

/** Both native notifications and connection completion expose the same allowance meters. */
export function mapMuseUsageObservationMeters(observation: MuseQuotaObservation,
  resetSource: 'body' | 'provider_event'): ConnectedAccountCompletionObservation['meters'] {
  return observation.limits.map(limit => ({ meterId: limit.id, label: limit.label ?? limit.id,
    used: limit.used ?? null, limit: limit.limit ?? null, unit: 'unknown',
    utilizationPct: limit.utilizationPct == null ? null : Math.min(100, limit.utilizationPct),
    remainingPct: limit.remainingPct, isExhausted: limit.isExhausted,
    resetsAt: limit.resetsAtMs ?? null, ...(limit.resetsAtMs == null ? {} : { resetAtMs: limit.resetsAtMs, resetSource }),
    ...(limit.windowDurationMs === undefined ? {} : { windowDurationMs: limit.windowDurationMs }),
    status: 'ok', details: {},
  }));
}

/** Pinned Muse key-response schema; acquisition time is the fallback observation time. */
export function parseMuseMintCompletionObservation(value: unknown, fetchedAtMs: number): ConnectedAccountCompletionObservation | undefined {
  const root = museRecord(value);
  const usage = museRecord(root?.subs_usage);
  if (!root || !usage || !timestamp(fetchedAtMs)) return undefined;
  const windows: Record<string, unknown> = {};
  for (const id of ['weekly', 'window'] as const) {
    const raw = usage[id];
    if (raw === undefined || raw === null) continue;
    const window = museRecord(raw);
    if (!window) return undefined;
    if (window.used_percent === undefined) continue;
    const resetsAtMs = window.resets_at == null ? undefined : parseProviderTimestampMs(window.resets_at);
    if (resetsAtMs === null) return undefined;
    windows[id] = { usedPercent: window.used_percent,
      ...(resetsAtMs === undefined ? {} : { resetsAtMs }),
      ...(window.window_duration_mins == null ? {} : { windowDurationMins: window.window_duration_mins }),
    };
  }
  const parsed = parseMuseUsageObservation({ usage: { observedAtMs: fetchedAtMs,
    ...(typeof root.subs_tier_name === 'string' ? { tier: root.subs_tier_name } : {}), ...windows } });
  if (parsed.status !== 'supported') return undefined;
  return { v: 1, providerId: 'meta', observedAtMs: parsed.observation.observedAtMs, fetchedAtMs,
    source: 'providerHttp', confidence: 'confirmed', state: 'loaded_data',
    ...(parsed.observation.planLabel ? { planLabel: parsed.observation.planLabel } : {}),
    meters: mapMuseUsageObservationMeters(parsed.observation, 'body'),
  };
}
