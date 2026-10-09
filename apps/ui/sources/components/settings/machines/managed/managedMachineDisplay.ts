import type * as React from 'react';
import type { ProviderPriceFactV1 } from '@happier-dev/protocol/machines/managed/managedConfigurationV1';

import { t } from '@/text';
import { formatAsOfTime } from '@/utils/time/formatAsOfTime';

/**
 * The display facts the creation surfaces draw (plans 50/51): provisioner cards, the configurator's
 * choices and the one receipt. Producers (the provisioner catalog, its `options`/`check` results, a
 * preset, a created machine) map into these; the components never fetch, resolve policy or guess.
 */

export type ProviderPrice = ProviderPriceFactV1;

export type ManagedStatusTone = 'ready' | 'attention' | 'none';

/** One provisioner on Add a machine: what it is, whether it can run here, and the one next step. */
export type ManagedProvisionerCard = Readonly<{
  id: string;
  title: string;
  /** What it creates ("Server", "Droplet"); cloud cards only, where there is room. */
  kind?: string;
  description: string;
  mark: React.ReactNode;
  location: 'local' | 'cloud';
  status: Readonly<{ tone: ManagedStatusTone; label: string }>;
  /** `choose` opens the configurator; `repair` runs the provisioner's own prerequisite or account step. */
  action: Readonly<{
    kind: 'choose' | 'repair';
    label: string;
    onPress: () => void;
  }>;
}>;

export type ManagedSizeOption = Readonly<{
  id: string;
  name: string;
  cpu: string;
  memory: string;
  disk: string;
  /** Provider-returned prices only; absent columns are not drawn, never estimated. */
  hourly?: string;
  monthly?: string;
  /** Local sizes: what the host keeps while this size runs ("8 cores · 28 GB"). */
  headroom?: string;
  /** The receipt's spec line for this size ("4 vCPU · 8 GB · 80 GB"). */
    spec: string;
    unavailableReason?: string;
    /** A dependent choice can be staged while its current combination is unavailable. */
    selectable?: boolean;
}>;

export type ManagedImageOption = Readonly<{
  id: string;
  name: string;
  description: string;
  /** The provisioner descriptor's preview at static props; never a tenant screenshot. */
    preview?: React.ReactNode;
    unavailableReason?: string;
    selectable?: boolean;
}>;

export type ManagedLocationOption = Readonly<{
  id: string;
  city: string;
  country: string;
  /** ISO 3166-1 alpha-2, for the flag beside the city. */
    countryCode?: string;
    unavailableReason?: string;
    selectable?: boolean;
}>;

export type ManagedReceiptFact = Readonly<{
  id: string;
  label: string;
  value: string;
  leading?: React.ReactNode;
}>;

export type ManagedReceiptCost =
  | Readonly<{
      kind: 'price';
      prices: readonly [ProviderPrice, ...ProviderPrice[]];
      /** Who pays, when the receipt is about a shared account ("Billed to Acme’s DigitalOcean team"). */
      billedTo?: string;
    }>
  | Readonly<{ kind: 'unpriced'; provider: string }>
  | Readonly<{
      kind: 'local';
      computer: string;
      meters: readonly Readonly<{
        id: string;
        label: string;
        value: string;
        fraction: number;
      }>[];
      note?: string;
    }>;

/** "€0.0119", from the provider's own decimal string and currency; the digits are never rounded away. */
export function formatProviderAmount(
  price: Pick<ProviderPrice, 'amount' | 'currency'>,
): string {
  const decimals = price.amount.split('.')[1]?.length ?? 0;
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: price.currency,
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format(Number(price.amount));
  } catch {
    return `${price.amount} ${price.currency}`;
  }
}

/** "an hour" / "a month" for the units providers report; another unit is said as the provider named it. */
export function formatPriceUnit(unit: string): string {
  const normalized = unit.trim().toLowerCase();
  if (normalized === 'hour' || normalized === 'h' || normalized === 'hourly')
    return t('managedMachines.price.perHour');
  if (normalized === 'month' || normalized === 'mo' || normalized === 'monthly')
    return t('managedMachines.price.perMonth');
  return t('managedMachines.price.perUnit', { unit });
}

export function formatPriceSource(
  price: Pick<ProviderPrice, 'source' | 'observedAt'>,
): string {
  return t('managedMachines.price.checked', {
    provider: price.source,
    time: formatAsOfTime(price.observedAt),
  });
}

/**
 * A country's name in the reader's language, from its ISO 3166-1 alpha-2 code. Nothing for an absent or
 * unknown code, or where the platform cannot name regions: a country is never guessed from a label.
 */
export function countryName(countryCode: string | undefined, locale: string): string {
  const code = countryCode?.trim().toUpperCase() ?? '';
  if (!/^[A-Z]{2}$/.test(code)) return '';
  try {
    const name = new Intl.DisplayNames([locale], { type: 'region' }).of(code);
    return name && name !== code ? name : '';
  } catch {
    return '';
  }
}

/** A flag from a country code (regional-indicator letters); nothing for a code that is not two letters. */
export function countryFlag(countryCode: string | undefined): string {
  const code = countryCode?.trim().toUpperCase() ?? '';
  if (!/^[A-Z]{2}$/.test(code)) return '';
  return String.fromCodePoint(
    ...[...code].map((letter) => 0x1f1e6 + letter.charCodeAt(0) - 65),
  );
}
