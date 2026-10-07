import { MachineAdministrationSelectionsV1Schema, MachineAdministrationTargetsV1Schema, type MachineAdministrationTargetsV1, type MachineAdministrationSelectionsV1, type MachineAdministrationTargetV1 } from '@happier-dev/protocol/account/settings/machineAdministrationSelectionsV1';
import type { PluginMachineExecutionOriginV1 } from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';

import { getSyncSingleton } from '@/sync/runtime/getSyncSingleton';
import type { OneShotAccountSettingsMutationResult } from '@/sync/engine/settings/syncSettings';
import type { AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';

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
 * Builds one device-local named-entry proposal. Validation remains domain-owned.
 */
export function setMachineAdministrationTargetPreference(
    current: MachineAdministrationTargetsV1,
    key: string,
    target: MachineAdministrationTargetV1,
): MachineAdministrationTargetsV1 {
    return MachineAdministrationTargetsV1Schema.parse({
        ...current,
        [key]: target,
    });
}

export function clearMachineAdministrationTargetPreference(
    current: MachineAdministrationTargetsV1,
    key: string,
): MachineAdministrationTargetsV1 {
    const targets = { ...current };
    delete targets[key];
    return MachineAdministrationTargetsV1Schema.parse(targets);
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
    expectedSettingsScope: AccountSettingsScope | null,
    expectedSettingsVersion: number,
    mutate: (current: MachineAdministrationSelectionsV1) => MachineAdministrationSelectionsV1,
): Promise<OneShotAccountSettingsMutationResult<void>> {
    return await getSyncSingleton().mutateAccountSettingsOnce({
        expectedSettingsScope,
        expectedSettingsVersion,
        mutate: (raw) => ({
            settings: applyMachineAdministrationSelectionMutationToAccountSettings(raw, mutate),
            value: undefined,
        }),
    });
}
