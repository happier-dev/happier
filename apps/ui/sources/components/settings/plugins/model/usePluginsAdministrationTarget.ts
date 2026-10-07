import * as React from 'react';

import { useMachineCapabilitiesCache } from '@/hooks/server/useMachineCapabilitiesCache';
import { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 } from '@/sync/domains/machines/administration/selectionPreferences';
import { useScopedPluginSettingsDaemonTargetBinding } from '@/sync/domains/machines/administration/scopedPluginSettingsTarget';

import { MARKETPLACE_CAPABILITY_ID } from './pluginMarketplaceModel';

/** The marketplace capability read: which plugins a machine has installed, and their state. */
export const MARKETPLACE_CAPABILITY_REQUEST = Object.freeze({ requests: [{ id: MARKETPLACE_CAPABILITY_ID }] });

/**
 * The machine the Plugins surfaces administer and its marketplace capability snapshot: the one
 * reader of which plugins are installed there. The Plugins page and the Plugins column both read it,
 * so they list and count the same plugins on the same machine; the snapshot is the shared machine
 * capability cache, keyed by that machine, so a second reader asks the daemon nothing new.
 */
export function usePluginsAdministrationTarget() {
    // The one administration-target owner. It supplies the selection, the exact Settings/Secrets
    // record target, and the single currentness fence every asynchronous write re-checks.
    const administration = useScopedPluginSettingsDaemonTargetBinding(
        MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.plugins,
    );
    const executionTarget = administration.executionTarget;
    const selectedTarget = administration.selection.selectedTarget;
    /**
     * This is a cache identity only. It deliberately uses the portable target, so an offline exact
     * selection retains its own last-known snapshot without falling back to the active server or
     * another machine.
     */
    const selectedMachineScopeKey = selectedTarget
        ? `${selectedTarget.serverIdentityId}:${selectedTarget.machineId}`
        : null;
    const daemonTransportOnline = executionTarget !== null;
    const [daemonReconnectFreshness, setDaemonReconnectFreshness] = React.useState(() => ({
        scopeKey: selectedMachineScopeKey,
        isOnline: daemonTransportOnline,
        reconnectSequence: 0,
    }));
    if (
        daemonReconnectFreshness.scopeKey !== selectedMachineScopeKey
        || daemonReconnectFreshness.isOnline !== daemonTransportOnline
    ) {
        setDaemonReconnectFreshness({
            scopeKey: selectedMachineScopeKey,
            isOnline: daemonTransportOnline,
            reconnectSequence: daemonReconnectFreshness.scopeKey !== selectedMachineScopeKey
                ? 0
                : !daemonReconnectFreshness.isOnline && daemonTransportOnline
                    ? daemonReconnectFreshness.reconnectSequence + 1
                    : daemonReconnectFreshness.reconnectSequence,
        });
    }
    const daemonCacheFreshnessKey = `${executionTarget?.machine.daemonStateVersion ?? 0}:${daemonReconnectFreshness.reconnectSequence}`;
    const machineCapabilities = useMachineCapabilitiesCache({
        machineId: executionTarget?.machine.id ?? null,
        serverId: executionTarget?.serverId ?? null,
        cacheKeySalt: daemonCacheFreshnessKey,
        enabled: executionTarget !== null,
        request: MARKETPLACE_CAPABILITY_REQUEST,
    });
    return {
        administration,
        executionTarget,
        selectedMachineScopeKey,
        daemonTransportOnline,
        daemonCacheFreshnessKey,
        machineCapabilities,
    };
}
