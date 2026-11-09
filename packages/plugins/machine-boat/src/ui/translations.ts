import type { PluginLocalizedStringV2 } from '@happier-dev/plugin-sdk';

import type { MachineProvisionerCheckResultV1 } from '@happier-dev/plugin-sdk/machine-provisioners';

const BOAT_PRESENTATION_LABELS = {
  en: {
    kind: 'sandbox',
    description: 'EU-only sandboxes billed per second of running time.',
    ready: 'Account connected',
    unavailable: 'Account unavailable',
    compute: 'Running compute',
  },
} as const;

const en = BOAT_PRESENTATION_LABELS.en;

export function boatPresentationLabel(id: keyof typeof en): PluginLocalizedStringV2 {
  return { key: `machineBoat.presentation.${id}`, fallback: en[id] };
}

export function boatCheckPresentation(result: MachineProvisionerCheckResultV1): MachineProvisionerCheckResultV1 {
  return { ...result, status: result.status ?? boatPresentationLabel(result.available ? 'ready' : 'unavailable') };
}
