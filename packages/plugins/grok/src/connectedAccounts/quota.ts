import {
  QuotaFetchError,
  parseProviderTimestampMs,
  parseRetryAfterHeader,
  type ConnectedAccountRuntime,
} from '@happier-dev/plugin-sdk/connected-accounts';
import type { XaiCredential } from './credential.js';
import { readXaiPolicyReason } from './failures.js';

type Quota = Awaited<ReturnType<NonNullable<ConnectedAccountRuntime['quota']>>>;
type Limit = Quota['limits'][number];
type Http = Parameters<NonNullable<ConnectedAccountRuntime['quota']>>[0]['services']['http'];
type Period = Readonly<{ resetsAtMs: number; windowDurationMs: number }>;

const BILLING_URL = 'https://cli-chat-proxy.grok.com/v1/billing';
const CREDITS_URL = `${BILLING_URL}?format=credits`;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function amount(value: unknown): number | null {
  const number = typeof value === 'number' ? value
    : typeof value === 'string' && value.trim() ? Number(value) : Number.NaN;
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function percent(value: unknown): number | null {
  const number = amount(value);
  return number !== null && number <= 100 ? number : null;
}

function period(start: unknown, end: unknown): Period | null {
  const startMs = parseProviderTimestampMs(start);
  const endMs = parseProviderTimestampMs(end);
  return startMs !== null && endMs !== null && endMs > startMs
    ? { resetsAtMs: endMs, windowDurationMs: endMs - startMs } : null;
}

function weeklyMeter(id: string, label: string, utilizationPct: number, window: Period, source: string): Limit {
  return {
    id, label, used: null, limit: null, unit: 'credits', utilizationPct,
    remainingPct: 100 - utilizationPct, ...window,
    scope: 'weekly', limitScope: 'account', status: 'ok', confidence: 'exact',
    details: { note: `Source: ${source}. The provider reports credit usage as a percentage, not a credit count.` },
  };
}

function billingAmountMeter(input: Readonly<{
  id: string; label: string; used: number; limit: number | null; window: Period | null; source: string;
}>): Limit {
  const { used, limit } = input;
  return {
    id: input.id, label: input.label, used, limit, unit: 'unknown',
    remaining: limit === null ? null : Math.max(0, limit - used),
    ...(limit !== null && limit > 0 ? { utilizationPct: Math.min(100, used / limit * 100) } : {}),
    ...(input.window ? { ...input.window, scope: 'monthly' as const } : {}),
    limitScope: 'account', status: 'ok', confidence: 'exact',
    details: { note: `Source: ${input.source}. The provider does not declare the billing amount denomination.` },
  };
}

/** Normalize billing observations only; this adapter never ranks or selects credentials. */
export function parseXaiBilling(payload: unknown, sourceUrl?: string): Quota['limits'] {
  const config = record(record(payload)?.config);
  if (!config) return [];
  const source = sourceUrl ?? (config.monthlyLimit !== undefined ? BILLING_URL : CREDITS_URL);
  const limits: Limit[] = [];
  const currentPeriod = record(config.currentPeriod);
  const weekly = currentPeriod && typeof currentPeriod.type === 'string' && currentPeriod.type.toUpperCase().includes('WEEK')
    ? period(currentPeriod.start, currentPeriod.end) : null;
  if (weekly) {
    const overall = percent(config.creditUsagePercent);
    if (overall !== null) limits.push(weeklyMeter('weekly-credits', 'Weekly credits', overall, weekly, source));
    if (Array.isArray(config.productUsage)) {
      for (const item of config.productUsage) {
        const product = record(item);
        const name = typeof product?.product === 'string' ? product.product.trim() : '';
        const usage = percent(product?.usagePercent);
        if (name && usage !== null) {
          limits.push(weeklyMeter(`weekly-product:${encodeURIComponent(name)}`, `${name} weekly credits`, usage, weekly, source));
        }
      }
    }
  }
  const monthly = period(config.billingPeriodStart, config.billingPeriodEnd);
  const monthlyLimit = amount(record(config.monthlyLimit)?.val);
  const monthlyUsed = amount(record(config.used)?.val);
  if (monthly && monthlyLimit !== null && monthlyUsed !== null) {
    limits.push(billingAmountMeter({ id: 'monthly-included', label: 'Monthly included',
      used: monthlyUsed, limit: monthlyLimit, window: monthly, source }));
  }
  const onDemandUsed = amount(record(config.onDemandUsed)?.val);
  if (onDemandUsed !== null) {
    limits.push(billingAmountMeter({ id: 'on-demand', label: 'On-demand spend', used: onDemandUsed,
      limit: amount(record(config.onDemandCap)?.val), window: monthly, source }));
  }
  return limits;
}

async function fetchBilling(input: Readonly<{
  http: Pick<Http, 'request'>; accessToken: string; url: string; nowMs: number; signal?: AbortSignal;
}>): Promise<unknown> {
  let response: Awaited<ReturnType<Http['request']>>;
  try {
    response = await input.http.request({
      url: input.url, method: 'GET', redirect: 'error',
      headers: { Authorization: `Bearer ${input.accessToken}`, Accept: 'application/json', 'X-XAI-Token-Auth': 'xai-grok-cli' },
    }, { signal: input.signal });
  } catch {
    input.signal?.throwIfAborted();
    throw new QuotaFetchError('xAI billing request failed', { quotaFetchErrorCode: 'network' });
  }
  input.signal?.throwIfAborted();
  if (response.status < 200 || response.status >= 300) {
    // A policy 403 does not establish invalid credentials. Keep its HTTP provenance.
    const policyReason = response.status === 403 ? readXaiPolicyReason(response.body) : undefined;
    const quotaFetchErrorCode = response.status === 401 ? 'auth_failure'
      : response.status === 429 || response.status >= 500 ? 'provider_backoff' : 'network';
    throw new QuotaFetchError(`xAI billing returned HTTP ${response.status}${policyReason ? `: ${policyReason}` : ''}`, {
      status: response.status, quotaFetchErrorCode, providerCode: policyReason,
      ...parseRetryAfterHeader(response.headers['retry-after'], { nowMs: input.nowMs }),
    });
  }
  try {
    return JSON.parse(new TextDecoder().decode(response.body)) as unknown;
  } catch {
    throw new QuotaFetchError('xAI billing response is malformed', { quotaFetchErrorCode: 'malformed' });
  }
}

export async function fetchXaiQuota(input: Readonly<{
  http: Pick<Http, 'request'>;
  credential: Pick<XaiCredential, 'mode' | 'accessToken'>;
  signal?: AbortSignal;
  nowMs: number;
}>): Promise<Quota> {
  if (input.credential.mode === 'api-key') return { observedAtMs: input.nowMs, limits: [] };
  const request = { http: input.http, accessToken: input.credential.accessToken, nowMs: input.nowMs, signal: input.signal };
  const credits = await fetchBilling({ ...request, url: CREDITS_URL });
  const limits = [...parseXaiBilling(credits, CREDITS_URL)];
  const weeklyUsable = limits.some((limit) => limit.scope === 'weekly');
  const unified = record(record(credits)?.config)?.isUnifiedBillingUser === true;
  if (unified || !weeklyUsable) {
    let monthly: Quota['limits'];
    try {
      monthly = parseXaiBilling(await fetchBilling({ ...request, url: BILLING_URL }), BILLING_URL);
      if (monthly.length === 0) throw new QuotaFetchError('xAI billing schema is unsupported', { quotaFetchErrorCode: 'malformed' });
    } catch (error) {
      input.signal?.throwIfAborted();
      if (!weeklyUsable || !(error instanceof QuotaFetchError)) throw error;
      monthly = [{ id: 'monthly-included', label: 'Monthly included', unit: 'unknown', used: null, limit: null,
        status: 'unavailable', confidence: 'unknown', scope: 'monthly',
        details: { code: error.quotaFetchErrorCode, note: `Source: ${BILLING_URL}. ${error.message}` } }];
    }
    for (const meter of monthly) {
      const existing = limits.find((limit) => limit.id === meter.id);
      if (!existing) limits.push(meter);
      else if (meter.id === 'on-demand' && (existing.used !== meter.used || existing.limit !== meter.limit)) {
        limits.push({ ...meter, id: 'on-demand-monthly', label: 'On-demand spend (monthly billing)' });
      }
    }
  }
  if (limits.length === 0) throw new QuotaFetchError('xAI billing schema is unsupported', { quotaFetchErrorCode: 'malformed' });
  return { observedAtMs: input.nowMs, limits };
}
