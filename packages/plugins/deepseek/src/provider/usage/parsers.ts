import type { ProviderUsageParser } from '@happier-dev/plugin-sdk/providers';

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid DeepSeek balance response');
  return value as Record<string, unknown>;
}

function decimal(value: unknown): number {
  if (typeof value !== 'string' || !/^-?\d+(?:\.\d+)?$/u.test(value)) throw new TypeError('Invalid DeepSeek balance decimal');
  const amount = Number(value);
  if (!Number.isFinite(amount)) throw new TypeError('Invalid DeepSeek balance decimal');
  return amount;
}

/** `/user/balance` reports a separate total for each denomination, never a spending cap.
 * https://api-docs.deepseek.com/api/get-user-balance/ (observed 2026-10-27). */
export const parseDeepSeekBalance: ProviderUsageParser = (body) => {
  const data = record(body);
  if (typeof data.is_available !== 'boolean' || !Array.isArray(data.balance_infos)) throw new TypeError('Invalid DeepSeek balance response');
  return { meters: data.balance_infos.map((value) => {
    const balance = record(value);
    const currency = balance.currency;
    if (currency !== 'CNY' && currency !== 'USD') throw new TypeError('Invalid DeepSeek balance currency');
    return {
      meterId: `balance-${currency}`, label: `Balance (${currency})`, currency,
      // Existing readers retain the denominated label and amount without falsely displaying USD.
      unit: currency === 'USD' ? 'usd' : 'unknown',
      used: null, remaining: decimal(balance.total_balance), limit: null,
      utilizationPct: null, resetsAt: null, status: 'ok', source: 'provider_api',
      confidence: 'exact', limitScope: 'account', details: {},
    };
  }) };
};
