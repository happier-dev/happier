import { MachineAdministrationTargetsV1Schema, type MachineAdministrationTargetsV1, type MachineAdministrationTargetV1 } from '@happier-dev/protocol/account/settings/machineAdministrationSelectionsV1';
import { getPluginMachineExecutionOriginRef, type PluginMachineExecutionOriginV1 } from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';

import { getSyncSingleton } from '@/sync/runtime/getSyncSingleton';
import type { AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';
import { areAccountSettingsScopesEqual } from '@/sync/domains/settings/scope/accountSettingsScope';
import { storage } from '@/sync/domains/state/storageStore';
import { clearMachineAdministrationTargetObservation, readMachineAdministrationTargetObservation, rememberMachineAdministrationTargetObservation } from '@/sync/domains/state/machineAdministrationUiState';

/** The declared Settings Action commits one explicit choice through this device-local owner. */
export function persistMachineAdministrationTargetSelection(params: Readonly<{
    selectionKey: string;
    target: MachineAdministrationTargetV1 | null;
    expectedSettingsScope: AccountSettingsScope;
}>): boolean {
    const current = storage.getState();
    if (!areAccountSettingsScopesEqual(params.expectedSettingsScope, current.settingsScope)) return false;
    const targets = current.settings.machineAdministrationTargetsLocalV1;
    const next = params.target === null
        ? clearMachineAdministrationTargetPreference(targets, params.selectionKey)
        : setMachineAdministrationTargetPreference(targets, params.selectionKey, params.target);
    if (params.target === null && params.selectionKey !== MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.managedMachines) {
        clearMachineAdministrationTargetObservation(params.expectedSettingsScope, params.selectionKey);
    }
    getSyncSingleton().applySettings({ machineAdministrationTargetsLocalV1: next }, {
        expectedSettingsScope: params.expectedSettingsScope, source: 'ui',
    });
    return true;
}

export function readMachineAdministrationTargetSelection(scope: AccountSettingsScope, selectionKey: string):
    Readonly<{ available: true; target: MachineAdministrationTargetV1 | null }> | Readonly<{ available: false }> {
    const current = storage.getState();
    return areAccountSettingsScopesEqual(scope, current.settingsScope)
        ? { available: true, target: readMachineAdministrationTargetPreference(current.settings.machineAdministrationTargetsLocalV1, selectionKey) }
        : { available: false };
}

/** Admit fresh operation custody, but remember only the answering device's Machine. */
export async function persistPluginMachineExecutionOriginSelection(params: Readonly<{
    pluginId: string;
    origin: PluginMachineExecutionOriginV1 | null;
    expectedSettingsScope: AccountSettingsScope | null;
    isOriginCurrent: (origin: PluginMachineExecutionOriginV1) => boolean;
    isInvocationCurrent?: () => boolean;
}>): Promise<Readonly<{ status: 'applied' | 'unavailable' }>> {
    const current = () => areAccountSettingsScopesEqual(params.expectedSettingsScope, storage.getState().settingsScope)
        && params.expectedSettingsScope !== null
        && (params.isInvocationCurrent?.() ?? true)
        && (params.origin === null || (getPluginMachineExecutionOriginRef(params.origin).pluginId === params.pluginId
            && params.isOriginCurrent(params.origin)));
    if (!current()) return { status: 'unavailable' };
    const selections = storage.getState().settings.machineAdministrationTargetsLocalV1;
    const next = params.origin === null ? clearPluginMachineExecutionOriginPreference(selections, params.pluginId)
        : setPluginMachineExecutionOriginPreference(selections, params.pluginId, params.origin);
    getSyncSingleton().applySettings({ machineAdministrationTargetsLocalV1: next }, {
        expectedSettingsScope: params.expectedSettingsScope,
    });
    return { status: 'applied' };
}

export const MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 = Object.freeze({
    plugins: 'plugins.home',
    agents: 'agents',
    sourceControl: 'sourceControl.settings',
    mcpServers: 'mcpServers.settings',
    relayDrift: 'server.relayDrift',
    externalSessions: 'externalSessions.settings',
    connectedAccounts: 'connectedAccounts.settings',
    memory: 'memory.settings',
    pets: 'pets.settings',
    providers: 'providers.settings',
    actions: 'actions.settings',
    managedMachines: 'machines.managed',
} as const);

export function readMachineAdministrationTargetPreference(
    current: MachineAdministrationTargetsV1,
    key: string,
): MachineAdministrationTargetV1 | null {
    return current[key] ?? null;
}

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
    current: MachineAdministrationTargetsV1,
    pluginId: string,
    origin: PluginMachineExecutionOriginV1,
): MachineAdministrationTargetsV1 {
    if (getPluginMachineExecutionOriginRef(origin).pluginId !== pluginId) {
        throw new Error('Plugin execution origin must belong to the selected plugin');
    }
    return setMachineAdministrationTargetPreference(current, pluginRunOnSelectionKey(pluginId), {
        serverIdentityId: origin.serverIdentityId,
        machineId: getPluginMachineExecutionOriginRef(origin).machineId,
    });
}

export function clearPluginMachineExecutionOriginPreference(
    current: MachineAdministrationTargetsV1,
    pluginId: string,
): MachineAdministrationTargetsV1 {
    return clearMachineAdministrationTargetPreference(current, pluginRunOnSelectionKey(pluginId));
}

function pluginRunOnSelectionKey(pluginId: string): string {
    return `plugin.runOn:${pluginId}`;
}

export function readPluginMachineExecutionTargetPreference(
    targets: MachineAdministrationTargetsV1,
    pluginId: string,
): MachineAdministrationTargetV1 | null {
    return targets[pluginRunOnSelectionKey(pluginId)] ?? null;
}

/** Scoped local Settings are the only preference authority; retired Account pins are inert. */
export function readCurrentPluginMachineExecutionTargetPreference(pluginId: string): MachineAdministrationTargetV1 | null {
    return readPluginMachineExecutionTargetPreference(storage.getState().settings.machineAdministrationTargetsLocalV1, pluginId);
}

/** A device/Account/Home navigation observation, never explicit placement intent. */
export function readPluginMachineExecutionLastUsedTarget(
    scope: AccountSettingsScope | null,
    pluginId: string,
): MachineAdministrationTargetV1 | null {
    return readMachineAdministrationTargetObservation(scope, `plugin.lastRunOn:${pluginId}`);
}

export function rememberPluginMachineExecutionOriginUse(pluginId: string, origin: PluginMachineExecutionOriginV1, scope: AccountSettingsScope): void {
    const state = storage.getState();
    if (!areAccountSettingsScopesEqual(scope, state.settingsScope)) return;
    rememberMachineAdministrationTargetObservation(scope, `plugin.lastRunOn:${pluginId}`, { serverIdentityId: origin.serverIdentityId,
        machineId: getPluginMachineExecutionOriginRef(origin).machineId });
}
