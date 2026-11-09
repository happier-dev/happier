import type { ProviderUsageParser, ProviderRequestCostParser } from '@happier-dev/plugin-sdk/providers';
type UsageMeter = ReturnType<ProviderUsageParser>['meters'][number];

/** OpenRouter's terminal usage.cost is the USD account charge. Upstream
 * inference cost is a different fact and must never be added to it.
 * https://openrouter.ai/docs/cookbook/administration/usage-accounting */
export const parseOpenRouterRequestCost: ProviderRequestCostParser = (usage) => {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return null;
  const cost = (usage as Record<string, unknown>).cost;
  return typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? cost : null;
};

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid OpenRouter usage response');
  return value as Record<string, unknown>;
}
function amount(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError('Invalid OpenRouter USD amount');
  return value;
}
function meter(meterId: string, label: string, used: number | null, extra: Partial<UsageMeter> = {}): UsageMeter {
  return { meterId, label, used, limit: null, unit: 'usd', currency: 'USD', utilizationPct: null, resetsAt: null,
    status: 'ok', source: 'provider_api', confidence: 'exact', details: {}, ...extra };
}

/** `/api/v1/key` describes this inference key, never the Account's credit balance. Its meters carry no
 * account `limitScope`, which is how hosts tell them apart from account credits. */
export const parseOpenRouterKeyUsage: ProviderUsageParser = (body) => {
  const data = record(record(body).data);
  const meters = [
    meter('key-spend-daily', 'Today', amount(data.usage_daily), { scope: 'daily' }),
    meter('key-spend-weekly', 'This week', amount(data.usage_weekly), { scope: 'weekly' }),
    meter('key-spend-monthly', 'This month', amount(data.usage_monthly), { scope: 'monthly' }),
    meter('key-spend-lifetime', 'Lifetime spend', amount(data.usage)),
  ];
  const limit = amount(data.limit);
  const remaining = amount(data.limit_remaining);
  meters.push(meter('key-allowance', 'Allowance', limit !== null && remaining !== null ? limit - remaining : null,
    { limit, remaining }));
  return { meters };
};

/** `/api/v1/credits` is authenticated separately with an optional management key. */
export const parseOpenRouterCredits: ProviderUsageParser = (body) => {
  const data = record(record(body).data);
  const total = amount(data.total_credits);
  const used = amount(data.total_usage);
  if (total === null || used === null) throw new TypeError('OpenRouter credits require purchased and used totals');
  // Purchased credits establish the balance, not an Account spending cap.
  return { meters: [meter('account-credits', 'Credits', used, { remaining: total - used, limitScope: 'account' })] };
};
