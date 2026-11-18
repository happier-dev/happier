import type * as React from 'react';
import type { ProviderPriceFactV1 } from '@happier-dev/protocol/machines/managed/managedConfigurationV1';

import type { ManagedProvisionerRepairFailure } from './useManagedProvisionerPresentation';
import type { MachineProvisionersListResultV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import type { ManagedProvisionerReadiness } from './managedProvisionerReadiness';

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
  description: string;
  /** What it creates, from its declaration ("server", "sandbox"): a cloud card names it beside the provider. */
  kind?: string;
  /** The provisioner's mark at the size its slot draws it (a tile's, a row's). */
  mark: (size: number) => React.ReactNode;
  location: 'local' | 'cloud';
  /** The provisioner's declared machine kind distinguishes cloud sandboxes from servers. */
  enrollmentRole?: MachineProvisionersListResultV1['provisioners'][number]['descriptor']['enrollmentRole'];
  /** Where it runs, from the placement owner (`readMachineProvisionerHostAvailability`): the Account, or one of your computers. */
  acquire: 'account' | 'daemon';
  /** Native placement/readiness permits setup here, independently of a catalog refresh disabling admission. */
  canSetUpHere: boolean;
  /**
   * The readiness owner says this kind is not ready yet (it needs setup, an account or an install), even when its
   * configurator may already open: a flow with a Set up step shows that step for it, never ticks it as done.
   */
  needsSetup?: true;
  /** What it needs is the Home's own address, not a tool: no install here can fix it (its repair sets the address). */
  homeUnreachable?: true;
  status: Readonly<{ tone: ManagedStatusTone; label: string }>;
  repairFailure?: ManagedProvisionerRepairFailure;
  /** The card's existing repair Action is still awaiting confirmation or completion. */
  repairPending?: true;
  /** The native prerequisite's existing installer and review inputs, consumed by Machine Setup. */
  repairAction?: NonNullable<ManagedProvisionerReadiness['repair']>['action'];
  setupSources?: NonNullable<ManagedProvisionerReadiness['repair']>['setupSources'];
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

/** A retained resource's native identity as its provider names it, one `key: value` fact per line. */
export function nativeIdentityLines(value: unknown): string[] {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return [JSON.stringify(value)];
    return Object.entries(value).map(([key, entry]) => `${key}: ${typeof entry === 'string' ? entry : JSON.stringify(entry)}`);
}
