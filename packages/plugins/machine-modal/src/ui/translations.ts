import type { PluginLocalizedStringV2 as PresentationLocalizedString } from '@happier-dev/plugin-sdk';

import { createMachineProvisionerCheckPresenter } from '@happier-dev/plugin-sdk/machine-provisioners';

export const MODAL_CONFIGURATION_LABELS = {
  en: {
    appReference: 'Existing App',
    imageReference: 'Registry image',
    cpu: 'Physical CPU cores',
    memoryMb: 'Memory (MiB)',
    timeoutMs: 'Native lifetime (ms)',
    timeoutDescription: 'Whole seconds, from 1 second to 24 hours.',
  },
} as const;

export const MACHINE_PRESENTATION_LABELS = {
  "en": {"customSize":"Custom size","kind":"sandbox","description":"On-demand cloud sandboxes with a native lifetime.","ready":"Account connected","unavailable":"Account unavailable"},
} as const;

export function machinePresentationLabel(id: keyof typeof MACHINE_PRESENTATION_LABELS.en): PresentationLocalizedString {
  return { key: 'machineModal.presentation.' + id, fallback: MACHINE_PRESENTATION_LABELS.en[id] };
}

/** Native check codes and their human vocabulary stay owned by this leaf. */
export const machineCheckPresentation = createMachineProvisionerCheckPresenter(MACHINE_PRESENTATION_LABELS.en, 'machineModal.presentation.');
