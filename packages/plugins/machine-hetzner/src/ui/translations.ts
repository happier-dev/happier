import type { PluginLocalizedStringV2 as PresentationLocalizedString } from '@happier-dev/plugin-sdk';

import { createMachineProvisionerCheckPresenter } from '@happier-dev/plugin-sdk/machine-provisioners';

export const HETZNER_PRICE_LABELS = {
  en: { compute: 'Compute', primaryIpv4: 'Primary IPv4', primaryIpv6: 'Primary IPv6' },
} as const;

/** The public-networking variants a server can be created with, as the person chooses between them. */
export const HETZNER_NETWORK_LABELS = {
  en: { ipv4: 'IPv4 only', ipv6: 'IPv6 only', dual: 'IPv4 and IPv6' },
} as const;

export const MACHINE_PRESENTATION_LABELS = {
  "en": {"kind":"VM","description":"A cloud machine with a persistent disk.","ready":"Account connected","unavailable":"Account unavailable"},
} as const;

export function machinePresentationLabel(id: keyof typeof MACHINE_PRESENTATION_LABELS.en): PresentationLocalizedString {
  return { key: 'machineHetzner.presentation.' + id, fallback: MACHINE_PRESENTATION_LABELS.en[id] };
}

/** Native check codes and their human vocabulary stay owned by this leaf. */
export const machineCheckPresentation = createMachineProvisionerCheckPresenter(MACHINE_PRESENTATION_LABELS.en, 'machineHetzner.presentation.');
