import { QuotaFetchError, parseRetryAfterHeader, type ConnectedAccountRuntime } from '@happier-dev/plugin-sdk/connected-accounts';

type Quota = NonNullable<ConnectedAccountRuntime['quota']>;
type Snapshot = Awaited<ReturnType<Quota>>;
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function numeric(value: unknown): number | undefined {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return undefined;
  const result = Number(value);
  return Number.isFinite(result) ? result : undefined;
}
function malformed(): never {
  throw new QuotaFetchError('Cursor usage response is unavailable', { quotaFetchErrorCode: 'malformed' });
}
/** Dashboard JSON contract: OpenUsage 35e88e93, CursorUsageClient/Mapper (2026-11-12). */
export const readCursorQuota: Quota = async (context, options) => {
  const signal = options?.signal ?? context.signal;
  signal.throwIfAborted();
  if (await context.credentials.get('credentialKind', options) !== 'oauth') {
    throw new QuotaFetchError('Cursor usage requires subscription sign-in', { quotaFetchErrorCode: 'missing_auth' });
  }
  const token = await context.credentials.get('accessToken', options);
  if (!token) throw new QuotaFetchError('Cursor subscription credentials are unavailable', { quotaFetchErrorCode: 'missing_auth' });
  let response;
  try {
    response = await context.services.http.request({
      url: 'https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage', method: 'POST', redirect: 'error',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' },
      body: new TextEncoder().encode('{}'),
    }, { signal });
  } catch {
    signal.throwIfAborted();
    throw new QuotaFetchError('Cursor usage request failed', { quotaFetchErrorCode: 'network' });
  }
  signal.throwIfAborted();
  if (response.status !== 200) throw new QuotaFetchError('Cursor usage request was unavailable', {
    status: response.status,
    quotaFetchErrorCode: response.status === 401 ? 'auth_failure' : response.status === 429 || response.status >= 500 ? 'provider_backoff' : 'network',
    ...parseRetryAfterHeader(response.headers['retry-after'], { nowMs: context.invokedAtMs }),
  });
  let value: unknown;
  try { value = JSON.parse(new TextDecoder().decode(response.body)); } catch { return malformed(); }
  const body = record(value);
  if (body.enabled === false) return malformed();
  const plan = record(body.planUsage);
  const reset = numeric(body.billingCycleEnd);
  const start = numeric(body.billingCycleStart);
  const cycle = { ...(reset !== undefined ? { resetsAtMs: reset } : {}),
    ...(reset !== undefined && start !== undefined && reset > start ? { windowDurationMs: reset - start } : {}) };
  const cap = numeric(plan.limit);
  const remaining = numeric(plan.remaining);
  const used = numeric(plan.totalSpend);
  const percent = numeric(plan.totalPercentUsed);
  if (cap === undefined && remaining === undefined && used === undefined && percent === undefined) return malformed();
  const limits: Snapshot['limits'][number][] = [{ id: 'plan_usage', label: 'Plan usage', unit: 'usd', ...cycle,
    ...(cap !== undefined ? { limit: cap / 100 } : {}),
    ...(remaining !== undefined ? { remaining: remaining / 100 } : {}),
    ...(used !== undefined ? { used: used / 100 } : {}),
    ...(percent !== undefined ? { utilizationPct: percent } : {}),
  }];
  for (const [field, label] of [['autoPercentUsed', 'Cursor Models'], ['apiPercentUsed', 'Other Models']] as const) {
    const utilizationPct = numeric(plan[field]);
    if (utilizationPct !== undefined) limits.push({ id: field, label, utilizationPct, unit: 'unknown', ...cycle });
  }
  const spend = record(body.spendLimitUsage);
  const team = spend.limitType === 'team' || (numeric(spend.pooledLimit) ?? 0) > 0;
  const individual = numeric(spend.individualLimit) !== undefined;
  const spendCap = numeric(individual ? spend.individualLimit : spend.pooledLimit);
  const spendRemaining = numeric(individual ? spend.individualRemaining : spend.pooledRemaining);
  const spendUsed = numeric(individual ? spend.individualUsed : spend.pooledUsed) ?? (!team ? numeric(spend.totalSpend) : undefined);
  if (spendCap !== undefined || spendRemaining !== undefined || spendUsed !== undefined) limits.push({
    id: 'on_demand', label: team ? 'Team spend' : 'Extra usage', unit: 'usd', ...cycle,
    ...(spendCap !== undefined ? { limit: spendCap / 100 } : {}),
    ...(spendRemaining !== undefined ? { remaining: spendRemaining / 100 } : {}),
    ...(spendUsed !== undefined ? { used: spendUsed / 100 } : {}),
  });
  return { observedAtMs: context.invokedAtMs, limits };
};
