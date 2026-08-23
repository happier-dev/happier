import {
    MachineAdministrationSelectionsV1Schema,
    type MachineAdministrationSelectionsV1,
    type MachineAdministrationTargetV1,
    type PluginMachineExecutionOriginV1,
} from '@happier-dev/protocol';

import { getSyncSingleton } from '@/sync/runtime/getSyncSingleton';

export const MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 = Object.freeze({
    plugins: 'plugins.home',
    agents: 'agents',
    sourceControl: 'sourceControl.settings',
    promptAssets: 'promptAssets.externalAssets',
    promptRegistries: 'promptRegistries.browse',
    mcpServers: 'mcpServers.settings',
    relayDrift: 'server.relayDrift',
    externalSessions: 'externalSessions.settings',
    connectedAccounts: 'connectedAccounts.settings',
    memory: 'memory.settings',
    pets: 'pets.settings',
    providers: 'providers.settings',
    actions: 'actions.settings',
} as const);

/**
 * Builds one exact named-entry proposal. Parsing delegates key/value/document
 * bounds to the Settings-owned schema; persistence and CAS remain with Settings.
 */
export function setMachineAdministrationTargetPreference(
    current: MachineAdministrationSelectionsV1,
    key: string,
    target: MachineAdministrationTargetV1,
): MachineAdministrationSelectionsV1 {
    return MachineAdministrationSelectionsV1Schema.parse({
        ...current,
        targetsByKey: {
            ...current.targetsByKey,
            [key]: target,
        },
    });
}

export function clearMachineAdministrationTargetPreference(
    current: MachineAdministrationSelectionsV1,
    key: string,
): MachineAdministrationSelectionsV1 {
    const targetsByKey = { ...current.targetsByKey };
    delete targetsByKey[key];
    return MachineAdministrationSelectionsV1Schema.parse({ ...current, targetsByKey });
}

export function setPluginMachineExecutionOriginPreference(
    current: MachineAdministrationSelectionsV1,
    pluginId: string,
    origin: PluginMachineExecutionOriginV1,
): MachineAdministrationSelectionsV1 {
    if (origin.materializationRef.pluginId !== pluginId) {
        throw new Error('Plugin execution origin must belong to the selected plugin');
    }
    return MachineAdministrationSelectionsV1Schema.parse({
        ...current,
        pluginExecutionOriginsByPluginId: {
            ...current.pluginExecutionOriginsByPluginId,
            [pluginId]: origin,
        },
    });
}

export function clearPluginMachineExecutionOriginPreference(
    current: MachineAdministrationSelectionsV1,
    pluginId: string,
): MachineAdministrationSelectionsV1 {
    const pluginExecutionOriginsByPluginId = { ...current.pluginExecutionOriginsByPluginId };
    delete pluginExecutionOriginsByPluginId[pluginId];
    return MachineAdministrationSelectionsV1Schema.parse({
        ...current,
        pluginExecutionOriginsByPluginId,
    });
}

/**
 * Replays one Administration-owned named-entry mutation against the current
 * Account Settings CAS winner. Unknown root settings and concurrent sibling
 * selections remain owned by that winner rather than by a rendered snapshot.
 */
export function applyMachineAdministrationSelectionMutationToAccountSettings(
    raw: Readonly<Record<string, unknown>>,
    mutate: (current: MachineAdministrationSelectionsV1) => MachineAdministrationSelectionsV1,
): Record<string, unknown> {
    const current = MachineAdministrationSelectionsV1Schema.parse(
        raw.machineAdministrationSelectionsV1 ?? {},
    );
    return {
        ...raw,
        machineAdministrationSelectionsV1: MachineAdministrationSelectionsV1Schema.parse(mutate(current)),
    };
}

export async function persistMachineAdministrationSelectionMutation(
    mutate: (current: MachineAdministrationSelectionsV1) => MachineAdministrationSelectionsV1,
): Promise<void> {
    await getSyncSingleton().mutateAccountSettings((raw) => (
        applyMachineAdministrationSelectionMutationToAccountSettings(raw, mutate)
    ));
}
