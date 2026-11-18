import type { ManagedConfigurationFactsV1, ProviderPriceFactV1 } from '@happier-dev/protocol/machines/managed/managedConfigurationV1';
import { presentManagedCost, resolveManagedConfigurationCost } from '@happier-dev/protocol/machines/managed/managedConfigurationV1';
import type { BillingCapabilitiesV1 } from '@happier-dev/protocol/machines/managed/providerFactsV1';
import { t } from '@/text';
import { formatAsOfTime } from '@/utils/time/formatAsOfTime';

/** The one UI owner for a provider cost headline and its dated evidence line. */
export function formatPriceSource(price: Pick<ProviderPriceFactV1, 'observedAt'> & Readonly<{ source?: string }>, provider: string | null): string {
  const asOf = formatAsOfTime(price.observedAt);
  const source = typeof price.source === 'string' && price.source.trim().length > 0 ? ` · ${price.source}` : '';
  return `${provider ? t('managedMachines.price.checked', { provider, time: asOf }) : t('surfaceState.asOf', { time: asOf })}${source}`;
}

/** Formats a provider's already-observed amount for any surface that needs the full price line. */
export function formatProviderPrice(price: Readonly<{ amount: string; currency: string; unit: string }>, source?: string): string {
  const value = `${price.amount} ${price.currency}/${price.unit}`;
  return typeof source === 'string' && source.trim().length > 0 ? `${value} · ${source}` : value;
}

export function presentManagedPresetCost(input: Readonly<{
  prices?: ManagedConfigurationFactsV1['prices']; billing?: BillingCapabilitiesV1; provider: string | null; runsOn?: string;
}>): Readonly<{ value: string; detail?: string }> | null {
  const cost = resolveManagedConfigurationCost({ prices: input.prices, billing: input.billing, provider: input.provider });
  if (cost.kind === 'unpriced') return { value: presentManagedCost({ kind: 'unpriced', provider: null }).value };
  const headline = presentManagedCost(cost);
  if (cost.kind === 'local') return { value: headline.value,
    ...(input.runsOn ? { detail: t('managedMachines.price.runsOn', { computer: input.runsOn }) } : {}) };
  return { value: `${headline.value} ${headline.unit}`, detail: formatPriceSource(cost.prices[0], null) };
}
