import type * as React from 'react';
import type { ProviderPriceFactV1 } from '@happier-dev/protocol/machines/managed/managedConfigurationV1';
import { formatPriceUnit as formatSharedPriceUnit, presentManagedCost as presentSharedManagedCost,
  type ManagedCost, type ManagedPriceLabels } from '@happier-dev/protocol/machines/managed/managedConfigurationV1';
export { formatProviderAmount } from '@happier-dev/protocol/machines/managed/managedConfigurationV1';

import { t } from '@/text';
import { formatAsOfTime } from '@/utils/time/formatAsOfTime';
import type { ManagedProvisionerRepairFailure } from './useManagedProvisionerPresentation';

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
  /** The provisioner's mark at the size its slot draws it (a tile's, a row's). */
  mark: (size: number) => React.ReactNode;
  location: 'local' | 'cloud';
  /** Who creates it, from the provisioner's declared acquire role: the Account, or one of your computers. */
  acquire: 'account' | 'daemon';
  status: Readonly<{ tone: ManagedStatusTone; label: string }>;
  repairFailure?: ManagedProvisionerRepairFailure;
  /**
   * `choose` opens the configurator; `repair` runs the provisioner's own prerequisite or account step;
   * `handoff` sends the person to the app that can reach the provider (web, Needs the app);
   * `retry` re-reads an unavailable catalog or check without entering configuration.
   */
  action: Readonly<{
    kind: 'choose' | 'repair' | 'handoff' | 'retry';
    label: string;
    onPress: () => void;
    /** No configuration step can start yet (for example, a missing tool without a repair Action). */
    disabled?: boolean;
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
    /** Advice remains visible without changing whether the size can be selected. */
    warning?: string;
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

/** One of the provider's public-networking variants, offered beside size, system and place. */
export type ManagedNetworkOption = Readonly<{
  id: string;
  name: string;
  unavailableReason?: string;
  selectable?: boolean;
}>;

export type ManagedReceiptFact = Readonly<{
  id: string;
  label: string;
  /** `null`: the value is still being read; the receipt holds its place with a pending bar. */
  value: string | null;
  leading?: React.ReactNode;
}>;

export type ManagedReceiptCost =
  | Readonly<{
      kind: 'price';
      prices: readonly [ProviderPrice, ...ProviderPrice[]];
      /** The provider the prices come from, by name ("Hetzner"); `null` when it is not known. */
      provider?: string | null;
      /** Who pays, when the receipt is about a shared account ("Billed to Acme’s DigitalOcean team"). */
      billedTo?: string;
    }>
  | Readonly<{ kind: 'unpriced'; provider: string | null }>
  | Readonly<{
      kind: 'local';
      /** `null` while the computer's name is still being read. */
      computer: string | null;
      meters: readonly Readonly<{
        id: string;
        label: string;
        value: string;
        fraction: number;
      }>[];
      note?: string;
    }>;

function priceLabels(): ManagedPriceLabels {
  return { perHour: t('managedMachines.price.perHour'), perMonth: t('managedMachines.price.perMonth'),
    perUnit: unit => t('managedMachines.price.perUnit', { unit }), noBill: t('managedMachines.price.noBill'),
    unavailable: provider => t('managedMachines.price.unavailable', { provider }) };
}

/** "an hour" / "a month" for the units providers report; another unit is said as the provider named it. */
export function formatPriceUnit(unit: string): string {
  return formatSharedPriceUnit(unit, priceLabels());
}

export function presentManagedCost(cost: ManagedCost): Readonly<{ value: string; unit: string }> {
  return presentSharedManagedCost(cost, priceLabels());
}

/**
 * When a price was read, credited to the provider by name. A price's `source` is the provider's evidence
 * reference (an API URL or an id), never a name to show; without a provider name the line keeps only its time.
 */
export function formatPriceSource(
  price: Pick<ProviderPrice, 'observedAt'>,
  provider: string | null,
): string {
  const time = formatAsOfTime(price.observedAt);
  return provider ? t('managedMachines.price.checked', { provider, time }) : t('surfaceState.asOf', { time });
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

/**
 * An image reference reads by its name and tag ("linux:24.04-disk"), not by the registry host and
 * namespace that lead it; a title that is not a reference ("Ubuntu 24.04") is left as it is.
 */
export function managedImageLabel(title: string): string {
  if (/\s/.test(title) || !title.includes('/')) return title;
  return title.slice(title.lastIndexOf('/') + 1) || title;
}

/** A flag from a country code (regional-indicator letters); nothing for a code that is not two letters. */
export function countryFlag(countryCode: string | undefined): string {
  const code = countryCode?.trim().toUpperCase() ?? '';
  if (!/^[A-Z]{2}$/.test(code)) return '';
  return String.fromCodePoint(
    ...[...code].map((letter) => 0x1f1e6 + letter.charCodeAt(0) - 65),
  );
}
