import * as React from 'react';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { usePluginAccountUiProjectionInputs } from '@/sync/domains/plugins/availability/projection';
import {
    createInstalledPluginUiProjectionPublication,
    createPluginUiProjectionUnionPublication,
    projectPluginUiProjectionAvailability,
} from '@/sync/domains/plugins/ui/projectionUnion';
import {
    usePluginUiProjectionCurrentness,
    type PluginUiProjectionCurrentness,
} from '@/sync/domains/plugins/ui/usePluginUiProjectionCurrentness';

export { PLUGIN_SEARCH_SECTIONS } from '@/sync/domains/plugins/ui/usePluginUiProjectionCurrentness';

export function useScopedPluginUiProjection(params: Readonly<{
    machineId?: string | null;
    serverId?: string | null;
    enabled?: boolean;
    includeConnectedAccountPurposes?: boolean;
    sections?: readonly string[];
}>): PluginUiProjectionCurrentness {
    const machine = usePluginUiProjectionCurrentness(params);
    const enabled = params.enabled !== false;
    const serverId = params.serverId?.trim() || null;
    // Machine currentness already resolves its exact Home. A machine-less
    // surface borrows the same credential owner, never the AppShell fleet.
    const { binding } = useServerCredentialAccountScopeBinding(enabled && !machine.machineId ? serverId : null);
    const accountLifetime = enabled ? machine.machineId ? machine.accountLifetime
        : serverId ? binding : captureActiveServerAccountScopeLifetime() : null;
    const availability = usePluginAccountUiProjectionInputs(accountLifetime?.scope ?? null, { enabled });
    const hostBundledUiEnabled = useFeatureEnabled('plugins.ui.reactNativeBundles', {
        scopeKind: 'spawn', serverId: accountLifetime?.scope.serverId ?? serverId,
    });
    const accountUiProjection = hostBundledUiEnabled ? availability?.accountUiProjection ?? null : null;
    const [machineUnion] = React.useState(createPluginUiProjectionUnionPublication);
    const [accountMerge] = React.useState(createInstalledPluginUiProjectionPublication);
    // Stamp the exact Machine's retained/current rows before introducing an
    // independently current Account catalog. The aggregate interaction bit
    // cannot turn an offline Machine contribution into executable authority.
    const stampedMachine = machineUnion.publish(accountUiProjection && machine.machineId ? [{
        machineId: machine.machineId, serverId: machine.serverId,
        projection: machine.pluginUiProjection, phase: machine.phase,
        interactionEnabled: machine.interactionEnabled, unavailableReasonCode: machine.unavailableReasonCode,
    }] : []);
    const pluginUiProjection = accountMerge.publish(accountUiProjection ? [accountUiProjection] : [],
        accountUiProjection ? stampedMachine.pluginUiProjection : machine.pluginUiProjection);
    const { phase, interactionEnabled, unavailableReasonCode } = projectPluginUiProjectionAvailability(machine, accountUiProjection);
    return React.useMemo(() => ({ ...machine, pluginUiProjection, accountLifetime, phase, interactionEnabled, unavailableReasonCode }),
        [accountLifetime, interactionEnabled, machine, phase, pluginUiProjection, unavailableReasonCode]);
}
