import type { ProviderUsageParser } from '@happier-dev/plugin-sdk/providers';
type UsageMeter = ReturnType<ProviderUsageParser>['meters'][number];

function usd(value: unknown): number {
  if (typeof value !== 'string' || !/^-?\d+(?:\.\d+)?$/u.test(value)) throw new TypeError('Invalid Gateway USD decimal');
  const result = Number(value);
  if (!Number.isFinite(result)) throw new TypeError('Invalid Gateway USD decimal');
  return result;
}

/** Gateway `/v1/credits` reports USD decimal strings, not a credit-unit counter. */
export const parseVercelCredits: ProviderUsageParser = (body) => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new TypeError('Invalid Gateway credits response');
  const data = body as Record<string, unknown>;
  const facts = { limit: null, unit: 'usd', currency: 'USD', utilizationPct: null, resetsAt: null, status: 'ok', source: 'provider_api',
    confidence: 'exact', limitScope: 'account', details: {} } as const;
  const meters: UsageMeter[] = [
    { ...facts, meterId: 'balance', label: 'Balance', used: null, remaining: usd(data.balance) },
    { ...facts, meterId: 'spend-lifetime', label: 'Lifetime spend', used: usd(data.total_used) },
  ];
  return { meters };
};
