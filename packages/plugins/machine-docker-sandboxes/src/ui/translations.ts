import type { PluginLocalizedStringV2 as PresentationLocalizedString } from '@happier-dev/plugin-sdk';

import type { MachineProvisionerCheckResultV1 } from '@happier-dev/plugin-sdk/machine-provisioners';

export const MACHINE_PRESENTATION_LABELS = {
  "en": {"kind":"sandbox","description":"Isolated machines from Docker Sandboxes; requires Docker’s sbx.","ready":"sbx installed","unavailable":"Needs sbx"},
} as const;

export function machinePresentationLabel(id: keyof typeof MACHINE_PRESENTATION_LABELS.en): PresentationLocalizedString {
  return { key: 'machineDocker.presentation.' + id, fallback: MACHINE_PRESENTATION_LABELS.en[id] };
}

/** Native check codes and their human vocabulary stay owned by this leaf. */
export function machineCheckPresentation(result: MachineProvisionerCheckResultV1): MachineProvisionerCheckResultV1 {
  const code = result.code;
  const id = result.available ? 'ready' : code && Object.hasOwn(MACHINE_PRESENTATION_LABELS.en, code)
    ? code as keyof typeof MACHINE_PRESENTATION_LABELS.en : 'unavailable';
  return { ...result, status: result.status ?? machinePresentationLabel(id) };
}
