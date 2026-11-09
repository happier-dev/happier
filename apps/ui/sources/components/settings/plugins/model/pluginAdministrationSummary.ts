import * as React from 'react';

import {
    getLatestMachineCapabilityCacheState,
    subscribeLatestMachineCapabilityCacheState,
    type MachineCapabilitiesCacheState,
} from '@/hooks/server/useMachineCapabilitiesCache';
import {
    MARKETPLACE_CAPABILITY_ID,
    readInstalledPlugins,
    readPendingPluginChanges,
} from './pluginMarketplaceModel';
import { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 } from '@/sync/domains/machines/administration/selectionPreferences';
import { useMachineAdministrationTargetSelection } from '@/sync/domains/machines/administration/useTargetSelection';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';

const UNKNOWN_SUMMARY = { known: false, awaitingDecision: 0, userInstalled: 0 } as const;

export type PluginAdministrationSummary = Readonly<{
    /** Whether the plugins machine has answered at all; nothing below is claimed without it. */
    known: boolean;
    /** Changes waiting for the person's decision (a change already applying is not). */
    awaitingDecision: number;
    /** Plugins the person installed (bundled ones are always there). */
    userInstalled: number;
}>;

export function summarizePluginAdministration(state: MachineCapabilitiesCacheState | null): PluginAdministrationSummary {
    const snapshot = state && (state.status === 'loaded' || state.status === 'loading' || state.status === 'error')
        ? state.snapshot
        : null;
    if (!snapshot || !snapshot.response.results[MARKETPLACE_CAPABILITY_ID]?.ok) return UNKNOWN_SUMMARY;
    return {
        known: true,
        awaitingDecision: readPendingPluginChanges(state!).filter((change) => change.kind !== 'applying').length,
        userInstalled: readInstalledPlugins(state!).filter((plugin) => plugin.source.kind !== 'bundled').length,
    };
}

const noopSubscribe = () => () => {};

/**
 * The Plugins page's latest answer for its machine, read from the capabilities cache owner without
 * asking the machine: whatever freshness generation the page last asked under (it bumps one on a
 * transport reconnect). Nothing is known until the page has asked in this launch.
 */
export function usePluginAdministrationSummary(): PluginAdministrationSummary {
    const selection = useMachineAdministrationTargetSelection(MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.plugins);
    const target = selection.resolveExecutionTarget();
    const machineId = target?.machine.id ?? null;
    const serverId = target?.serverId ?? null;
    const { binding } = useServerCredentialAccountScopeBinding(serverId);
    const accountId = binding?.scope.accountId;
    const subscribe = React.useCallback(
        (listener: () => void) => (machineId
            ? subscribeLatestMachineCapabilityCacheState(machineId, serverId, MARKETPLACE_CAPABILITY_ID, listener, accountId)
            : noopSubscribe()),
        [machineId, serverId, accountId],
    );
    const getState = React.useCallback(
        () => (machineId && binding?.isCurrent() ? getLatestMachineCapabilityCacheState(machineId, serverId, MARKETPLACE_CAPABILITY_ID, accountId) : null),
        [machineId, serverId, accountId, binding],
    );
    const state = React.useSyncExternalStore(subscribe, getState, getState);
    return React.useMemo(() => (state ? summarizePluginAdministration(state) : UNKNOWN_SUMMARY), [state]);
}
