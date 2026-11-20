import type { PluginLocalizedStringV2 as PresentationLocalizedString } from '@happier-dev/plugin-sdk';

import { createMachineProvisionerCheckPresenter } from '@happier-dev/plugin-sdk/machine-provisioners';

export const CRABBOX_CONFIGURATION_LABELS = {
  "en": {
    backendId: "Compute backend",
    transport: "Connection route",
    namespace: "Namespace",
    target: "Guest OS",
    nativeImageId: "Native image",
    nativeSizeId: "Native machine type",
    ttlSeconds: "Native TTL (seconds)",
    idleTimeoutSeconds: "Idle timeout (seconds)",
    gcpProject: "GCP project",
    gcpZone: "GCP zone",
    location: "Location",
    localContainerRuntime: "Container runtime",
    localContainerCpus: "CPU limit",
    localContainerMemory: "Memory limit",
    direct: "Direct",
    coordinator: "Coordinator",
    localContainer: "Local container",
  },
} as const;

export const MACHINE_PRESENTATION_LABELS = {
  "en": {"kind":"machine","description":"Development machines from a coordinator or local container.","coordinatorDescription":"Servers from a Crabbox coordinator you connect.","ready":"Ready","unavailable":"Account unavailable","provider_unavailable":"Crabbox unavailable on this computer"},
} as const;

export function machinePresentationLabel(id: keyof typeof MACHINE_PRESENTATION_LABELS.en): PresentationLocalizedString {
  return { key: 'machineCrabbox.presentation.' + id, fallback: MACHINE_PRESENTATION_LABELS.en[id] };
}

/** Native check codes and their human vocabulary stay owned by this leaf. */
export const machineCheckPresentation = createMachineProvisionerCheckPresenter(MACHINE_PRESENTATION_LABELS.en, 'machineCrabbox.presentation.');
