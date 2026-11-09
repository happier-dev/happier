import { QuotaFetchError, parseRetryAfterHeader, type ConnectedAccountRuntime } from '@happier-dev/plugin-sdk/connected-accounts';
import type { HttpService } from '@happier-dev/plugin-sdk/http';

type Snapshot = Awaited<ReturnType<NonNullable<ConnectedAccountRuntime['quota']>>>;
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function numeric(value: unknown): number | undefined {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}
function unavailable(): never {
  throw new QuotaFetchError('Kimi usage is unavailable', { quotaFetchErrorCode: 'malformed' });
}
/** Vendor windows remain separate observations; no guessed allowance or billing equivalence. */
export function parseKimiQuota(value: unknown, observedAtMs: number): Snapshot {
  const body = record(value);
  const usages = record(body.usages);
  const limits: Snapshot['limits'][number][] = [];
  for (const [id, raw] of Object.entries(usages)) {
    const entry = record(raw);
    const ratio = numeric(entry.used_ratio);
    if (ratio === undefined) continue;
    const reset = typeof entry.reset_time === 'string' ? Date.parse(entry.reset_time) : NaN;
    limits.push({ id, label: id, utilizationPct: ratio * 100, unit: 'percent',
      ...(Number.isFinite(reset) ? { resetsAtMs: reset } : {}) });
  }
  const wallet = record(body.boosterWallet);
  const balance = record(wallet.balance);
  const spending = record(wallet.monthlyUsed);
  const cap = record(wallet.monthlyChargeLimit);
  const spendingCurrency = typeof spending.currency === 'string' ? spending.currency : undefined;
  const capCurrency = typeof cap.currency === 'string' ? cap.currency : undefined;
  const currency = capCurrency || spendingCurrency;
  const used = numeric(spending.priceInCents);
  const capAmount = wallet.monthlyChargeLimitEnabled === true ? numeric(cap.priceInCents) : undefined;
  if (spendingCurrency && used !== undefined) limits.push({ id: 'monthly_spend', label: 'Extra usage', used,
    ...(capCurrency === spendingCurrency && capAmount !== undefined ? { limit: capAmount } : {}), unit: `${spendingCurrency} cents` });
  if (capCurrency && capAmount !== undefined && (used === undefined || capCurrency !== spendingCurrency)) {
    limits.push({ id: 'monthly_charge_limit', label: 'Extra usage monthly limit', limit: capAmount, unit: `${capCurrency} cents` });
  }
  const amount = numeric(balance.amount);
  const left = numeric(balance.amountLeft);
  if (balance.type === 'BOOSTER' && currency && amount !== undefined && left !== undefined) {
    // The vendor wallet stores one cent as 1,000,000 fixed-point units.
    limits.push({ id: 'booster_balance', label: 'Extra usage balance', remaining: left / 1_000_000, limit: amount / 1_000_000, unit: `${currency} cents` });
  }
  if (!limits.length) return unavailable();
  return { observedAtMs, limits };
}

export async function fetchKimiQuota(input: Readonly<{
  http: Pick<HttpService, 'request'>; baseUrl: string; headers: Readonly<Record<string, string>>;
  observedAtMs: number; signal: AbortSignal;
}>): Promise<Snapshot> {
  let response;
  try { response = await input.http.request({ url: `${input.baseUrl}/usages`, method: 'GET', headers: input.headers, redirect: 'error' }, { signal: input.signal }); }
  catch { input.signal.throwIfAborted(); throw new QuotaFetchError('Kimi usage request failed', { quotaFetchErrorCode: 'network' }); }
  input.signal.throwIfAborted();
  if (response.status !== 200) throw new QuotaFetchError('Kimi usage request was unavailable', {
    status: response.status, quotaFetchErrorCode: response.status === 401 ? 'auth_failure' : response.status === 429 || response.status >= 500 ? 'provider_backoff' : 'network',
    ...parseRetryAfterHeader(response.headers['retry-after'], { nowMs: input.observedAtMs }),
  });
  let body: unknown;
  try { body = JSON.parse(new TextDecoder().decode(response.body)); } catch { return unavailable(); }
  return parseKimiQuota(body, input.observedAtMs);
}
