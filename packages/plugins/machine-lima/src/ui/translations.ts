import type { PluginLocalizedStringV2 } from '@happier-dev/plugin-sdk';

import { createMachineProvisionerCheckPresenter } from '@happier-dev/plugin-sdk/machine-provisioners';

export const MACHINE_PRESENTATION_LABELS = {
  // Dimensions are formatted once by the shared receipt from the numeric native facts.
  // This title names the size rather than projecting those same dimensions again.
  "en": {"kind":"Machine","description":"A lightweight Linux machine for code, scripts and dev servers.","ready":"Installed","unavailable":"Not installed","lima_2_required":"Lima 2 required","qemu_unavailable":"QEMU unavailable","qemu_driver_unavailable":"QEMU unavailable","vz_driver_unavailable":"VZ needs macOS 13 or later","customSize":"Custom size",
    "agent_session_memory_too_small": "Too small for an agent Session. Startup peaked at {measuredPeakGiB} GiB. Choose at least {minimumGiB} GiB. We recommend {recommendedGiB} GiB.",
  },
} as const;

export function machinePresentationLabel(id: keyof typeof MACHINE_PRESENTATION_LABELS.en,
  params?: Readonly<Record<string, string | number>>): PluginLocalizedStringV2 {
  return { key: 'machineLima.presentation.' + id, fallback: MACHINE_PRESENTATION_LABELS.en[id], ...(params ? { params } : {}) };
}

/** Native check codes and their human vocabulary stay owned by this leaf. */
export const machineCheckPresentation = createMachineProvisionerCheckPresenter(MACHINE_PRESENTATION_LABELS.en, 'machineLima.presentation.');
