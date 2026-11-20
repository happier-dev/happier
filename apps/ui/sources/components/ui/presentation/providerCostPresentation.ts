import type { ManagedConfigurationFactsV1, ProviderPriceFactV1 } from '@happier-dev/protocol/machines/managed/managedConfigurationV1';
import {
  formatProviderAmount,
  formatPriceUnit as formatSharedPriceUnit,
  presentManagedCost as presentSharedManagedCost,
  resolveManagedConfigurationCost,
  type ManagedCost,
  type ManagedPriceLabels,
} from '@happier-dev/protocol/machines/managed/managedConfigurationV1';
import type { BillingCapabilitiesV1 } from '@happier-dev/protocol/machines/managed/providerFactsV1';
import type { ProviderAmountV1 } from '@happier-dev/protocol/common/providerAmountV1';
import { t } from '@/text';
import { formatCalendarDate } from '@/utils/datetime/cachedIntlFormatters';
import { formatAsOfTime } from '@/utils/time/formatAsOfTime';

/**
 * The one UI owner of price text (deploy auto-mode U3): a provider's price, its cost headline, and the dated line
 * saying where and when it was read. Machines settings, presets, deploy cards, Review and the Restore sheet all
 * print prices through here; no surface formats an amount, currency or unit itself.
 */

function priceLabels(): ManagedPriceLabels {
  return { perHour: t('managedMachines.price.perHour'), perMonth: t('managedMachines.price.perMonth'),
    perUnit: unit => t('managedMachines.price.perUnit', { unit }), noBill: t('managedMachines.price.noBill'),
    unavailable: provider => t('managedMachines.price.unavailable', { provider }) };
}

/** "an hour" / "a month" for the units providers report; another unit is said as the provider named it. */
export function formatPriceUnit(unit: string): string {
  return formatSharedPriceUnit(unit, priceLabels());
}

/** A cost's headline in the reader's language: "$5.00" + "a month", "No bill", or the provider's charges apply. */
export function presentManagedCost(cost: ManagedCost): Readonly<{ value: string; unit: string }> {
  return presentSharedManagedCost(cost, priceLabels());
}

/** "vercel.com" from a public page's URL; anything that is not a web page names nothing. */
export function sourceName(source: string | undefined): string | null {
  if (!source) return null;
  try {
    const url = new URL(source);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.host.replace(/^www\./, '') : null;
  } catch {
    return null;
  }
}

/**
 * When a price was read, credited to the provider by name. A price's `source` is the provider's evidence reference
 * (an API URL or an id), never a name to show; without a provider name the line keeps only its time.
 */
export function formatPriceSource(price: Pick<ProviderPriceFactV1, 'observedAt'>, provider: string | null): string {
  const time = formatAsOfTime(price.observedAt);
  return provider ? t('managedMachines.price.checked', { provider, time }) : t('surfaceState.asOf', { time });
}

/** A declared plan's dated source (an ISO calendar date and its public page), on the reader's calendar day. */
export function formatDeclaredPlanSource(source: Readonly<{ url: string; checkedAt: string }>): string {
  const [year, month, day] = source.checkedAt.split('-').map(Number);
  // The date and the word before it keep one line: a narrow card never leaves "Nov 16" alone under "checked".
  const time = formatCalendarDate(new Date(year!, month! - 1, day!)).replace(/ /g, '\u00a0');
  return t('managedMachines.price.checked', { provider: sourceName(source.url) ?? source.url, time }).replace(` ${time}`, `\u00a0${time}`);
}

/** A declared plan's price (Protocol ProviderAmountV1), said like any provider price: "$20.00 a month". */
export function formatDeclaredPlanPrice(price: ProviderAmountV1): string {
  return `${formatProviderAmount(price)} ${formatPriceUnit(price.unit)}`;
}

/** One observed price with its public pricing page, when it has one: "$0.05 a month · digitalocean.com". */
export function formatProviderPrice(price: ProviderPriceFactV1, pricingPage?: string): string {
  const headline = presentManagedCost({ kind: 'price', prices: [price] });
  const page = sourceName(pricingPage);
  return page ? `${headline.value} ${headline.unit} · ${page}` : `${headline.value} ${headline.unit}`;
}

/**
 * A preset offer's cost column (lab m-pick): "No bill" and the computer it runs on for a local machine, or the
 * provider's returned price with when it was read. Unpriced says provider charges apply: the column never guesses a figure.
 */
export function presentManagedPresetCost(input: Readonly<{
  prices?: ManagedConfigurationFactsV1['prices']; billing?: BillingCapabilitiesV1; provider: string | null; runsOn?: string;
}>): Readonly<{ value: string; detail?: string }> | null {
  const cost = resolveManagedConfigurationCost({ prices: input.prices, billing: input.billing, provider: input.provider });
  // Unpriced: the owner's short "Provider charges apply" (the offer line already names the provider), never a
  // blank that reads as free and never a figure.
  if (cost.kind === 'unpriced') return { value: presentManagedCost({ kind: 'unpriced', provider: null }).value };
  const headline = presentManagedCost(cost);
  if (cost.kind === 'local') return { value: headline.value,
    ...(input.runsOn ? { detail: t('managedMachines.price.runsOn', { computer: input.runsOn }) } : {}) };
  return { value: `${headline.value} ${headline.unit}`, detail: formatPriceSource(cost.prices[0], null) };
}

export { formatProviderAmount };
