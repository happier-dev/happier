import type { PluginLocalizedStringV2 } from '@happier-dev/plugin-sdk';

import type { PluginLocalizedStringV2 as PresentationLocalizedString } from '@happier-dev/plugin-sdk';

import type { MachineProvisionerCheckResultV1 } from '@happier-dev/plugin-sdk/machine-provisioners';

export const LUME_CONFIGURATION_LABELS = {
  en: {
    storage: 'Storage', storageDescription: 'Exact native storage name from the available locations.',
    cpu: 'CPU cores', memory: 'Memory', disk: 'Disk', imageKind: 'Image selection',
    publishedImage: 'Published image', nativeReference: 'Native image reference', publishedReference: 'Published image reference',
    nativeDescription: 'A tagged or digest-qualified Lume-format image prepared for this guest.',
    privateCarrier: 'Prepared private connection',
    privateDescription: 'Select only for a reviewed image prepared for native Lume default-password SSH.',
    preparedSsh: 'Prepared for native Lume SSH', guestOs: 'Prepared guest OS', user: 'Prepared SSH user',
    userDescription: 'The explicit account prepared in this image; it is never inferred from the guest OS.', customSize: 'Custom size',
    keepPasswordLogin: 'Keep password login',
    keepPasswordLoginDescription: 'Allow SSH login with the image password. Leave off to use SSH keys only. Applies to macOS guests.',
    macosVmLimitReached: 'Host macOS VM limit reached: {count}/{limit} are running. Stop a macOS VM on this host and try again.',
    macosVmCount: '{count} of {limit} macOS VMs running on this Mac',
    macosVmCountUnavailable: 'Running macOS VM count unavailable on this Mac',
  },
};

export function lumeConfigurationLabel(id: keyof typeof LUME_CONFIGURATION_LABELS.en): Exclude<PluginLocalizedStringV2, string> {
  return { key: `machineLume.configure.${id}`, fallback: LUME_CONFIGURATION_LABELS.en[id] };
}

export const MACHINE_PRESENTATION_LABELS = {
  "en": {"kind":"Machine","description":"A local macOS or Linux machine with your chosen image.","ready":"Ready","unavailable":"Unavailable","lume_not_installed":"Not installed · get it from cua.ai/docs/lume","lume_transport":"Lume isn’t running · start it with lume serve","lume_http":"Connection unavailable","lume_response":"Runtime response unavailable",
    lume_cache_enabled: 'Ready · image cache enabled',
    lume_cache_disabled: 'Ready · image cache disabled',
    lume_cache_unknown: 'Ready · image cache status unavailable',
  },
} as const;

export function machinePresentationLabel(id: keyof typeof MACHINE_PRESENTATION_LABELS.en): PresentationLocalizedString {
  return { key: 'machineLume.presentation.' + id, fallback: MACHINE_PRESENTATION_LABELS.en[id] };
}

/** Native check codes and their human vocabulary stay owned by this leaf. */
export function machineCheckPresentation(result: MachineProvisionerCheckResultV1): MachineProvisionerCheckResultV1 {
  const code = result.code;
  const id = code && Object.hasOwn(MACHINE_PRESENTATION_LABELS.en, code)
    ? code as keyof typeof MACHINE_PRESENTATION_LABELS.en : result.available ? 'ready' : 'unavailable';
  return { ...result, status: result.status ?? machinePresentationLabel(id) };
}
