import type { PluginLocalizedStringV2 as PresentationLocalizedString } from '@happier-dev/plugin-sdk';

import type { MachineProvisionerCheckResultV1 } from '@happier-dev/plugin-sdk/machine-provisioners';

const en = {
  appOwnership: 'App', createApp: 'Create a new app', existingApp: 'Use an existing app', appName: 'App name',
  organization: 'Organization', organizationDescription: 'Use the organization configured for the selected Fly account.',
  region: 'Region code', image: 'Image', imageDescription: 'Optional; defaults to Ubuntu 24.04 when not supplied.',
  cpuKind: 'CPU kind', shared: 'Shared', performance: 'Performance', cpus: 'CPU count', memory: 'Memory (MB)',
  volumeKind: 'Persistent volume', createVolume: 'Create a new volume', attachVolume: 'Attach an existing volume',
  volumeSize: 'Volume size (GB)', volumeId: 'Volume ID',
} as const;

export const FLY_CONFIGURATION_LABELS = {
  en,
} as const satisfies Readonly<Record<string, Readonly<Record<keyof typeof en, string>>>>;

export const MACHINE_PRESENTATION_LABELS = {
  "en": {"kind":"VM","description":"Machines with a persistent volume. Compute and retained storage are billed separately.","ready":"Account connected","unavailable":"Account unavailable",
    "rootFilesystem":"Stopped root disk","volumeStorage":"Volume","snapshotStorage":"Snapshots over allowance"},
} as const;

export function machinePresentationLabel(id: keyof typeof MACHINE_PRESENTATION_LABELS.en): PresentationLocalizedString {
  return { key: 'machineFly.presentation.' + id, fallback: MACHINE_PRESENTATION_LABELS.en[id] };
}

/** Native check codes and their human vocabulary stay owned by this leaf. */
export function machineCheckPresentation(result: MachineProvisionerCheckResultV1): MachineProvisionerCheckResultV1 {
  const code = result.code;
  const id = result.available ? 'ready' : code && Object.hasOwn(MACHINE_PRESENTATION_LABELS.en, code)
    ? code as keyof typeof MACHINE_PRESENTATION_LABELS.en : 'unavailable';
  return { ...result, status: result.status ?? machinePresentationLabel(id) };
}
