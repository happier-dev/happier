import * as React from 'react';
import type { CapabilityId} from '@happier-dev/protocol/capabilities';
import type { MachineAdministrationTargetV1 } from '@happier-dev/protocol/account/settings/machineAdministrationSelectionsV1';
import { useMachineCapabilitiesCache } from '@/hooks/server/useMachineCapabilitiesCache';
import type { FreshMachineAdministrationExecutionTargetV1 } from '@/sync/domains/machines/administration/useTargetSelection';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { serverAccountScopedResourceKey } from '@/sync/domains/scope/serverAccountScope';
import { MARKETPLACE_CAPABILITY_ID, readInstalledPlugins } from './pluginMarketplaceModel';

export const MARKETPLACE_CAPABILITY_REQUEST: Readonly<{ requests: { id: CapabilityId }[] }> = Object.freeze({ requests: [{ id: MARKETPLACE_CAPABILITY_ID }] });

/** The one demanded exact-Machine detail read. Selection/preferences remain with the caller. */
export function usePluginMachineDetails(params: Readonly<{
    selectedTarget: MachineAdministrationTargetV1 | null;
    executionTarget: FreshMachineAdministrationExecutionTargetV1 | null;
    enabled: boolean;
}>) {
    const { selectedTarget, executionTarget } = params;
    const { binding } = useServerCredentialAccountScopeBinding(selectedTarget?.serverIdentityId ?? null);
    const selectedMachineScopeKey = selectedTarget && binding?.isCurrent()
        ? serverAccountScopedResourceKey(binding.scope, 'plugin-machine', selectedTarget.serverIdentityId, selectedTarget.machineId) : null;
    const daemonTransportOnline = executionTarget !== null && binding?.isCurrent() === true;
    // These inputs already cause a render. Derive the current key from the last
    // committed observation instead of scheduling another render while rendering.
    const committedFreshness = React.useRef({ scopeKey: selectedMachineScopeKey,
        online: daemonTransportOnline, reconnectSequence: 0 });
    const previous = committedFreshness.current;
    const freshness = previous.scopeKey === selectedMachineScopeKey && previous.online === daemonTransportOnline
        ? previous : { scopeKey: selectedMachineScopeKey, online: daemonTransportOnline,
            reconnectSequence: previous.scopeKey !== selectedMachineScopeKey ? 0
                : !previous.online && daemonTransportOnline ? previous.reconnectSequence + 1 : previous.reconnectSequence };
    React.useLayoutEffect(() => { committedFreshness.current = freshness; }, [freshness]);
    const daemonCacheFreshnessKey = `${executionTarget?.machine.daemonStateVersion ?? 0}:${freshness.reconnectSequence}`;
    const machineCapabilities = useMachineCapabilitiesCache({
        machineId: binding ? selectedTarget?.machineId ?? null : null,
        serverId: executionTarget?.serverId ?? binding?.serverId ?? null,
        accountLifetime: binding ?? undefined,
        cacheKeySalt: daemonCacheFreshnessKey,
        enabled: params.enabled && daemonTransportOnline,
        request: MARKETPLACE_CAPABILITY_REQUEST,
    });
    // Generic cache presenters may explicitly refresh while passive. This
    // demanded Plugin reader instead retires its user continuation when parked.
    const currentDemand = React.useRef({ enabled: params.enabled && daemonTransportOnline, selectedMachineScopeKey,
        refresh: machineCapabilities.refresh });
    currentDemand.current = { enabled: params.enabled && daemonTransportOnline, selectedMachineScopeKey,
        refresh: machineCapabilities.refresh };
    const refreshCurrent = React.useCallback<typeof machineCapabilities.refresh>(next => {
        if (currentDemand.current.selectedMachineScopeKey !== selectedMachineScopeKey
            || !binding?.isCurrent()) return;
        currentDemand.current.refresh(next);
    }, [selectedMachineScopeKey, binding]);
    const refreshOnDemand = React.useCallback<typeof machineCapabilities.refresh>(next => {
        if (currentDemand.current.enabled) refreshCurrent(next);
    }, [refreshCurrent]);
    const installedPlugins = React.useMemo(() => readInstalledPlugins(machineCapabilities.state), [machineCapabilities.state]);
    return { selectedMachineScopeKey, daemonTransportOnline, daemonCacheFreshnessKey,
        // An admitted mutation may settle while passive; its ordinary refresh uses this same exact target.
        machineCapabilities: { ...machineCapabilities, refresh: refreshCurrent }, refreshOnDemand,
        installedPlugins, capabilitiesAccountId: binding?.scope.accountId };
}
