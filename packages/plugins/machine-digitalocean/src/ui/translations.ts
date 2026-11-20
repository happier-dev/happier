import type { PluginLocalizedStringV2 as PresentationLocalizedString } from '@happier-dev/plugin-sdk';

import { createMachineProvisionerCheckPresenter } from '@happier-dev/plugin-sdk/machine-provisioners';

/** Whether a Droplet also gets an IPv6 address; every Droplet has IPv4. */
export const DIGITALOCEAN_NETWORK_LABELS = {
  en: { ipv4: 'IPv4 only', dual: 'IPv4 and IPv6' },
} as const;

export const MACHINE_PRESENTATION_LABELS = {
  "en": {"kind":"Machine","description":"A cloud machine with your chosen size, image and region.","ready":"Account connected","unavailable":"Account unavailable"},
} as const;

export function machinePresentationLabel(id: keyof typeof MACHINE_PRESENTATION_LABELS.en): PresentationLocalizedString {
  return { key: 'machineDigitalOcean.presentation.' + id, fallback: MACHINE_PRESENTATION_LABELS.en[id] };
}

/** Native check codes and their human vocabulary stay owned by this leaf. */
export const machineCheckPresentation = createMachineProvisionerCheckPresenter(MACHINE_PRESENTATION_LABELS.en, 'machineDigitalOcean.presentation.');
