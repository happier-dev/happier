import * as React from 'react';
import { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 } from '@/sync/domains/machines/administration/selectionPreferences';
import { useScopedPluginSettingsDaemonTargetBinding } from '@/sync/domains/machines/administration/scopedPluginSettingsTarget';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';

import { usePluginMachineDetails } from './usePluginMachineDetails';
import { readDevelopmentPlugins } from './pluginMarketplaceModel';
export { MARKETPLACE_CAPABILITY_REQUEST } from './usePluginMachineDetails';

/**
 * The machine the Plugins surfaces administer and its marketplace capability snapshot: the one
 * reader shared with explicit Store Machine detail. Administration supplies its preference-bound
 * target; the extracted reader owns the cache/reconnect lifecycle without selecting a Machine.
 */
export function usePluginsAdministrationTarget(params: Readonly<{ enabled?: boolean; projectionRefreshKey?: number }> = {}) {
    // The one administration-target owner. It supplies the selection, the exact Settings/Secrets
    // record target, and the single currentness fence every asynchronous write re-checks.
    const administration = useScopedPluginSettingsDaemonTargetBinding(
        MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.plugins,
    );
    const executionTarget = administration.executionTarget;
    const details = usePluginMachineDetails({ selectedTarget: administration.selection.selectedTarget,
        executionTarget, enabled: params.enabled !== false });
    const daemonMergedProjection = useDaemonMergedProjectionInputs({
        machineId: executionTarget?.machine.id,
        serverId: executionTarget?.serverId,
        enabled: params.enabled !== false && params.projectionRefreshKey !== undefined && executionTarget !== null,
        refreshKey: `${params.projectionRefreshKey ?? 0}:${details.daemonCacheFreshnessKey}`,
        // Plugins administration presents every plugin's Actions, Resources, settings and contribution kinds.
        sections: 'complete',
    });
    const state = details.machineCapabilities.state;
    const hasCapabilitySnapshot = (state.status === 'loaded' || state.status === 'loading' || state.status === 'error')
        && state.snapshot !== undefined;
    const developmentPlugins = React.useMemo(() => readDevelopmentPlugins(state, details.installedPlugins),
        [state, details.installedPlugins]);
    // Retain display facts for one exact Account/Machine; admission always uses current native readiness.
    const retained = React.useRef({ scopeKey: details.selectedMachineScopeKey,
        installedPlugins: details.installedPlugins, developmentPlugins, projectionInputs: daemonMergedProjection.inputs });
    if (retained.current.scopeKey !== details.selectedMachineScopeKey) {
        retained.current = { scopeKey: details.selectedMachineScopeKey,
            installedPlugins: hasCapabilitySnapshot ? details.installedPlugins : [],
            developmentPlugins: hasCapabilitySnapshot ? developmentPlugins : [],
            projectionInputs: daemonMergedProjection.inputs };
    } else {
        retained.current = { scopeKey: details.selectedMachineScopeKey,
            installedPlugins: hasCapabilitySnapshot ? details.installedPlugins : retained.current.installedPlugins,
            developmentPlugins: hasCapabilitySnapshot ? developmentPlugins : retained.current.developmentPlugins,
            projectionInputs: daemonMergedProjection.inputs ?? retained.current.projectionInputs };
    }
    return {
        administration,
        executionTarget,
        ...details,
        hasCapabilitySnapshot,
        installedPlugins: retained.current.installedPlugins,
        developmentPlugins: retained.current.developmentPlugins,
        daemonMergedProjection,
        projectionInputs: retained.current.projectionInputs,
    };
}
