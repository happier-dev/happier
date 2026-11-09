import type { PluginLocalizedStringV2 as PresentationLocalizedString } from '@happier-dev/plugin-sdk';

import type { MachineProvisionerCheckResultV1 } from '@happier-dev/plugin-sdk/machine-provisioners';

export const MACHINE_PRESENTATION_LABELS = {
  "en": {"kind":"sandbox","description":"An isolated machine for coding and development.","ready":"Ready","unavailable":"Runtime unavailable","cua_native_unavailable":"Not installed · get it from cua.ai","cua_native_outdated":"Update required · update the Cua CLI","cua_connection_unavailable":"Connection unavailable","credential_unavailable":"No account yet","spaceKind":"space","spaceDescription":"A local workspace with its own machine and screen.","byocKind":"machine","byocDescription":"Machines on your own cloud account, managed by Cua.","native_facts_unknown":"Runtime response unavailable","native_runtime_unavailable":"Runtime unavailable"},
} as const;

export function machinePresentationLabel(id: keyof typeof MACHINE_PRESENTATION_LABELS.en): PresentationLocalizedString {
  return { key: 'machineCua.presentation.' + id, fallback: MACHINE_PRESENTATION_LABELS.en[id] };
}

const CONFIGURATION_LABELS = {
  en: ['CPU cores', 'Memory', 'Disk', 'Cloud'],
} satisfies Record<keyof typeof MACHINE_PRESENTATION_LABELS, readonly string[]>;

const configurationIds = ['cpu', 'memoryBytes', 'diskBytes', 'cloud'] as const;

export function configurationLabel(id: typeof configurationIds[number]): PresentationLocalizedString {
  return { key: 'machineCua.configure.' + id, fallback: CONFIGURATION_LABELS.en[configurationIds.indexOf(id)] };
}

/** One name per connected native account, wherever Happier shows it (service title, connected account, status). */
export const CUA_ACCOUNT_NAMES = { cloud: 'Cua cloud account', cua: 'Cua login' } as const;

/** Native check codes and their human vocabulary stay owned by this leaf. */
export function machineCheckPresentation(result: MachineProvisionerCheckResultV1): MachineProvisionerCheckResultV1 {
  const code = result.code;
  const id = result.available ? 'ready' : code && Object.hasOwn(MACHINE_PRESENTATION_LABELS.en, code)
    ? code as keyof typeof MACHINE_PRESENTATION_LABELS.en : 'unavailable';
  return { ...result, status: result.status ?? machinePresentationLabel(id) };
}
