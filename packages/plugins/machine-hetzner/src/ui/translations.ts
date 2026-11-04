import type { PluginLocalizedStringV2 as PresentationLocalizedString } from '@happier-dev/plugin-sdk';

import type { MachineProvisionerCheckResultV1 } from '@happier-dev/plugin-sdk/machine-provisioners';

export const HETZNER_PRICE_LABELS = {
  en: { compute: 'Compute', primaryIpv4: 'Primary IPv4', primaryIpv6: 'Primary IPv6' },
} as const;

export const MACHINE_PRESENTATION_LABELS = {
  "en": {"kind":"VM","description":"A cloud machine with a persistent disk.","ready":"Account connected","unavailable":"Account unavailable"},
} as const;

export function machinePresentationLabel(id: keyof typeof MACHINE_PRESENTATION_LABELS.en): PresentationLocalizedString {
  return { key: 'machineHetzner.presentation.' + id, fallback: MACHINE_PRESENTATION_LABELS.en[id] };
}

/** Native check codes and their human vocabulary stay owned by this leaf. */
export function machineCheckPresentation(result: MachineProvisionerCheckResultV1): MachineProvisionerCheckResultV1 {
  const code = result.code;
  const id = result.available ? 'ready' : code && Object.hasOwn(MACHINE_PRESENTATION_LABELS.en, code)
    ? code as keyof typeof MACHINE_PRESENTATION_LABELS.en : 'unavailable';
  return { ...result, status: result.status ?? machinePresentationLabel(id) };
}
