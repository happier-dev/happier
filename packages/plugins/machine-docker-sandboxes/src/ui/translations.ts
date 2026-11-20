import type { PluginLocalizedStringV2 as PresentationLocalizedString } from '@happier-dev/plugin-sdk';

import { createMachineProvisionerCheckPresenter } from '@happier-dev/plugin-sdk/machine-provisioners';

export const MACHINE_PRESENTATION_LABELS = {
  "en": {"kind":"sandbox","description":"Isolated machines from Docker Sandboxes; requires Docker’s sbx.","ready":"sbx installed","unavailable":"Needs sbx"},
} as const;

export function machinePresentationLabel(id: keyof typeof MACHINE_PRESENTATION_LABELS.en): PresentationLocalizedString {
  return { key: 'machineDocker.presentation.' + id, fallback: MACHINE_PRESENTATION_LABELS.en[id] };
}

/** Native check codes and their human vocabulary stay owned by this leaf. */
export const machineCheckPresentation = createMachineProvisionerCheckPresenter(MACHINE_PRESENTATION_LABELS.en, 'machineDocker.presentation.');
