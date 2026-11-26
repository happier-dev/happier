import * as React from 'react';

import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { CAPABILITIES_REQUEST_MACHINE_DETAILS } from '@/capabilities/requests';
import { getInstallablesRegistryEntries, INSTALLABLES_PROJECTION_SECTIONS } from '@/capabilities/installablesRegistry';
import { summarizeInstallables, type InstallablesSummary } from '@/capabilities/installablesSummary';
import { useMachineCapabilitiesCache } from '@/hooks/server/useMachineCapabilitiesCache';
import { useServerCredentialAccountScopeBindings } from '@/sync/domains/scope/useServerCredentialAccountScopes';

const UNKNOWN: InstallablesSummary = { status: 'unknown' };
const LOADING: InstallablesSummary = { status: 'loading' };

/**
 * What the Tools page already read for this machine, counted, for the Machine page's Tools row. It observes the same
 * Account-qualified capabilities cache and daemon-merged registry the Tools page fills and never asks the machine
 * (`enabled: false`, `load: false`): a registry or inventory that was not observed is `unknown`, not an empty tool list,
 * and one still being read is `loading`, so the row can wait for its count instead of drawing it late.
 */
export function useMachineToolsSummary(params: Readonly<{ serverId: string; machineId: string }>): InstallablesSummary {
    const { serverId, machineId } = params;
    const accountBindings = useServerCredentialAccountScopeBindings([serverId]);
    const accountLifetime = accountBindings.values().next().value ?? null;
    const { state } = useMachineCapabilitiesCache({
        machineId: accountLifetime?.isCurrent() ? machineId : null,
        serverId: accountLifetime?.scope.serverId ?? serverId,
        accountLifetime: accountLifetime ?? undefined,
        enabled: false,
        request: CAPABILITIES_REQUEST_MACHINE_DETAILS,
    });
    const projection = useDaemonMergedProjectionInputs({ accountLifetime, machineId, serverId, enabled: true, load: false,
        sections: INSTALLABLES_PROJECTION_SECTIONS });
    const pluginProjection = projection.inputs?.pluginProjectionV2 ?? null;
    // Without a current Account the registry reader waits for one that may never come: nothing is being read for it.
    const registryLoading = projection.phase === 'loading' && accountLifetime?.isCurrent() === true;
    return React.useMemo(() => {
        if (!pluginProjection) return registryLoading ? LOADING : UNKNOWN;
        return summarizeInstallables(getInstallablesRegistryEntries({ pluginProjection }), state);
    }, [pluginProjection, registryLoading, state]);
}
