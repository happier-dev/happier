import type { RetentionV1 } from './managedMachineV1.js';
import type { BillingCapabilitiesV1, ProviderNativeOptionFactsV1 } from './providerFactsV1.js';
import type { ProviderPriceFactV1 } from './managedConfigurationV1.js';

export type ManagedCost =
  | Readonly<{ kind: 'price'; prices: readonly [ProviderPriceFactV1, ...ProviderPriceFactV1[]] }>
  | Readonly<{ kind: 'local' }>
  | Readonly<{ kind: 'unpriced'; provider: string | null }>;

/** The reviewed price wins; only an explicit local billing fact establishes "No bill". */
export function resolveManagedConfigurationCost(input: Readonly<{
  prices?: readonly ProviderPriceFactV1[]; billing?: BillingCapabilitiesV1; provider: string | null;
}>): ManagedCost {
  const [first, ...rest] = input.prices ?? [];
  return first ? { kind: 'price', prices: [first, ...rest] }
    : input.billing?.location === 'local' ? { kind: 'local' }
      : { kind: 'unpriced', provider: input.billing === undefined ? null : input.provider };
}

/** Provider precision: currency digits normally, three significant digits for sub-ten-cent rates. */
export function formatProviderAmount(price: Pick<ProviderPriceFactV1, 'amount' | 'currency'>): string {
  const given = price.amount.split('.')[1]?.replace(/0+$/, '').length ?? 0;
  const value = Number(price.amount);
  try {
    const currencyDigits = new Intl.NumberFormat(undefined, { style: 'currency', currency: price.currency })
      .resolvedOptions().maximumFractionDigits ?? 2;
    const leadingZeros = value !== 0 && Math.abs(value) < 0.1 ? -Math.floor(Math.log10(Math.abs(value))) - 1 : 0;
    const decimals = leadingZeros === 0 ? currencyDigits : Math.max(currencyDigits, Math.min(given, leadingZeros + 3));
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: price.currency,
      minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(value);
  } catch {
    return `${price.amount} ${price.currency}`;
  }
}

export type ManagedPriceLabels = Readonly<{
  perHour: string; perMonth: string; perUnit: (unit: string) => string;
  noBill: string; unavailable: (provider: string | null) => string;
}>;
const priceLabels: ManagedPriceLabels = {
  perHour: 'an hour', perMonth: 'a month', perUnit: unit => `per ${unit}`, noBill: 'No bill',
  unavailable: provider => provider ? `Price unavailable · billed directly by ${provider}` : 'Price unavailable',
};

export function formatPriceUnit(unit: string, labels: ManagedPriceLabels = priceLabels): string {
  const normalized = unit.trim().toLowerCase();
  if (normalized === 'hour' || normalized === 'h' || normalized === 'hourly') return labels.perHour;
  if (normalized === 'month' || normalized === 'mo' || normalized === 'monthly') return labels.perMonth;
  return labels.perUnit(unit);
}

/** One headline for the receipt, phone summary and approval. */
export function presentManagedCost(cost: ManagedCost, labels: ManagedPriceLabels = priceLabels): Readonly<{ value: string; unit: string }> {
  return cost.kind === 'price' ? { value: formatProviderAmount(cost.prices[0]), unit: formatPriceUnit(cost.prices[0].unit, labels) }
    : { value: cost.kind === 'local' ? labels.noBill : labels.unavailable(cost.provider), unit: '' };
}

export type ManagedDurationLabels = Readonly<{
  days: (count: number) => string; hours: (count: number) => string; minutes: (count: number) => string;
}>;
const durationLabels: ManagedDurationLabels = {
  days: count => `${count} ${count === 1 ? 'day' : 'days'}`,
  hours: count => `${count} h`,
  minutes: count => `${count} min`,
};
export function formatRetentionDuration(ms: number, labels: ManagedDurationLabels = durationLabels): string {
  if (ms >= 86_400_000 && ms % 86_400_000 === 0) return labels.days(ms / 86_400_000);
  if (ms >= 3_600_000 && ms % 3_600_000 === 0) return labels.hours(ms / 3_600_000);
  return labels.minutes(Math.max(1, Math.round(ms / 60_000)));
}

export type ManagedRetentionLabels = Readonly<{
  untilDelete: string;
  stopAfterUnused: (duration: string) => string; suspendAfterUnused: (duration: string) => string;
  deleteAfterUnused: (duration: string) => string;
  stopAt: (time: string) => string; suspendAt: (time: string) => string; deleteAt: (time: string) => string;
}>;
const retentionLabels: ManagedRetentionLabels = {
  untilDelete: 'Until I delete it',
  stopAfterUnused: duration => `Stop after ${duration} unused`,
  suspendAfterUnused: duration => `Suspend after ${duration} unused`,
  deleteAfterUnused: duration => `Delete after ${duration} unused`,
  stopAt: time => `Stop at ${time}`, suspendAt: time => `Suspend at ${time}`, deleteAt: time => `Delete at ${time}`,
};
export function describeRetention(retention: RetentionV1, options: Readonly<{
  formatTime?: (at: number) => string; parking?: 'stop' | 'suspend';
  labels?: ManagedRetentionLabels; durationLabels?: ManagedDurationLabels;
}> = {}): string {
  const labels = options.labels ?? retentionLabels;
  if (retention.kind === 'until-delete') return labels.untilDelete;
  if (retention.kind === 'unused') {
    const duration = formatRetentionDuration(retention.afterMs, options.durationLabels);
    return retention.effect === 'delete' ? labels.deleteAfterUnused(duration)
      : options.parking === 'suspend' ? labels.suspendAfterUnused(duration) : labels.stopAfterUnused(duration);
  }
  const time = options.formatTime?.(retention.at) ?? new Date(retention.at).toLocaleString();
  return retention.effect === 'delete' ? labels.deleteAt(time)
    : options.parking === 'suspend' ? labels.suspendAt(time) : labels.stopAt(time);
}

type NativeSizeFact = NonNullable<ProviderNativeOptionFactsV1['size']>;

/** The managed launch form and receipt express both memory and disk in GiB, to three significant digits. */
export function formatManagedSizeBytes(bytes: number): string {
  const value = Number.isFinite(bytes) ? Math.max(0, bytes) / 1024 ** 3 : 0;
  return `${new Intl.NumberFormat(undefined, { maximumSignificantDigits: 3 }).format(Number(value.toPrecision(3)))} GiB`;
}

export function managedSizeDimensions(size: NativeSizeFact, cores: (count: number) => string = count => `${count} cores`): string[] {
  return [size.cpuCores === undefined ? null : cores(size.cpuCores),
    size.memoryBytes === undefined ? null : formatManagedSizeBytes(size.memoryBytes),
    size.diskBytes === undefined ? null : formatManagedSizeBytes(size.diskBytes)]
    .filter((part): part is string => part !== null).map(part => part.replace(/ /g, '\u00a0'));
}

export function describeManagedSize(title: string, size: NativeSizeFact, cores?: (count: number) => string): string {
  return [title, ...managedSizeDimensions(size, cores)].join(' · ');
}

/** The host's reviewed acquire-role names, when a private native Action has no catalog title. */
const acquireStepLabels = {
  acquire: 'Create machine', bootstrap: 'Prepare Happier installation', inspect: 'Inspect machine',
  destroy: 'Delete machine', exec: 'Run setup command', putFile: 'Write setup file',
  reconcile: 'Recover machine creation', cleanup: 'Clean up machine creation',
} as const;
export function presentManagedAcquireStep(role: string): Readonly<{ label: string; labelKey: string }> | null {
  const entry = Object.entries(acquireStepLabels).find(([key]) => key === role);
  return entry ? { label: entry[1], labelKey: `managedMachines.approvalSteps.${entry[0]}` } : null;
}
