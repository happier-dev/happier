import * as React from 'react';
import { resolveAgentConnectedAccountPurposeDefaults } from '@happier-dev/protocol/account/settings/connected-services';
import type { MachineAdministrationTargetV1 } from '@happier-dev/protocol/account/settings/machineAdministrationSelectionsV1';

import { AGENT_IDS } from '@/agents/catalog/catalog';
import { getResolvedAgentCatalogEntries } from '@/agents/backendCatalog/agentCatalogProjection';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { useAppShellPluginUiProjection } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { useActiveServerAccountScope } from '@/sync/store/hooks';
import { useSettingsValues } from '@/sync/store/settingsReadHooks';
import { useMachineAdministrationTargetSelection, type MachineAdministrationTargetSelectionV1 } from '@/sync/domains/machines/administration/useTargetSelection';
import { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 } from '@/sync/domains/machines/administration/selectionPreferences';
import { CONNECTED_ACCOUNT_PROJECTION_SECTIONS, PLUGIN_UI_SECTIONS } from '@/sync/domains/plugins/ui/projectionSections';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { selectActiveServerAccountScopeForServer } from '@/sync/domains/scope/activeServerAccountScope';
import { useConnectedAccountCatalog } from '@/sync/store/settings/useConnectedAccountCatalog';
import type { ConnectedAccountCatalogValueSnapshot } from '@/sync/store/settings/connectedAccountCatalogSnapshot';

import type { ConnectedServicesIndexAgentUse } from './buildConnectedServicesIndexModel';

type Options = Readonly<{
    agents: 'load' | 'cached';
    targetSelection?: MachineAdministrationTargetSelectionV1;
    initialMachineTarget?: MachineAdministrationTargetV1 | null;
}>;

const selectPurposeBindings = (snapshot: ConnectedAccountCatalogValueSnapshot<'purposes'>) => snapshot.value;

/** Agent declarations and their selected Machine, without joining the Account service inventory. */
export function useConnectedServicesAgents(options: Options) {
    const presented = useLayoutPresentationActive();
    const scope = useActiveServerAccountScope();
    const appShellProjection = useAppShellPluginUiProjection();
    // AppShell's Account union has no selected Machine in a cold multi-Machine scope.
    const acquire = presented && options.agents === 'load';
    const defaultTargetSelection = useMachineAdministrationTargetSelection(MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.connectedAccounts, {
        enabled: acquire && options.targetSelection === undefined,
        ...(options.initialMachineTarget !== undefined ? { initialTarget: options.initialMachineTarget } : {}),
    });
    const targetSelection = options.targetSelection ?? defaultTargetSelection;
    const sourceTarget = acquire && targetSelection.selectedTargetServerMatchesActiveAccount && targetSelection.canExecute
        ? targetSelection.selectedTarget : null;
    const projectionMachineId = appShellProjection.accountLifetime?.isCurrent()
        && areServerAccountScopesEqual(appShellProjection.accountLifetime.scope, scope)
        && selectActiveServerAccountScopeForServer(scope, appShellProjection.serverId)
        ? appShellProjection.machineId : null;
    const catalogMachineId = sourceTarget?.machineId ?? null;
    // Migration needs already admitted declarations, not merely a catalog acquisition target.
    const sourceMachineId = options.agents === 'load' ? projectionMachineId : null;
    const daemonAgentProjection = useDaemonMergedProjectionInputs({
        machineId: options.agents === 'load' ? catalogMachineId : projectionMachineId,
        serverId: options.agents === 'load' ? sourceTarget?.serverIdentityId : appShellProjection.serverId,
        enabled: presented && Boolean(options.agents === 'load' ? catalogMachineId : projectionMachineId),
        load: options.agents === 'load',
        // Presented Connect surfaces also offer the source's setup UI and Actions.
        // Discover those from the same selected Machine, including Machine-only plugins.
        sections: options.agents === 'load' ? ['agentsById', ...PLUGIN_UI_SECTIONS]
            : ['agentsById', ...CONNECTED_ACCOUNT_PROJECTION_SECTIONS],
    });
    const agentEntries = React.useMemo(() => getResolvedAgentCatalogEntries({
        enabledAgentIds: AGENT_IDS,
        mergedProviderProjectionById: daemonAgentProjection.inputs?.mergedProviderProjectionById ?? null,
        mergedBackendProjectionById: daemonAgentProjection.inputs?.mergedBackendProjectionById ?? null,
    }), [daemonAgentProjection.inputs?.mergedBackendProjectionById, daemonAgentProjection.inputs?.mergedProviderProjectionById]);
    const agentsKnown = agentEntries.some(agent => agent.identity !== null);
    return { presented, scope, targetSelection, sourceMachineId, appShellProjection, daemonAgentProjection, agentEntries, agentsKnown };
}

/** Saved defaults and their declared Agent consumers; account health and quota are not inputs. */
export function useConnectedServicesAgentUses(options: Options) {
    const agents = useConnectedServicesAgents(options);
    const purposeBindings = useConnectedAccountCatalog('purposes', agents.scope,
        { sourceMachineId: agents.sourceMachineId, enabled: agents.presented }, selectPurposeBindings);
    const settings = useSettingsValues([
        'connectedServicesDefaultAuthByAgentIdV1',
        'connectedServicesAdditionalDefaultAuthByAgentIdV1',
    ]);
    const { agentEntries, agentsKnown } = agents;
    const agentUses = React.useMemo((): readonly ConnectedServicesIndexAgentUse[] | null => {
        if (!agentsKnown) return null;
        return agentEntries.filter(agent => agent.connectedAccounts.length > 0).map(agent => ({
            agentId: agent.agentId,
            title: agent.title,
            services: agent.connectedAccounts.map(declaration => declaration.service),
            defaults: agent.identity && purposeBindings ? resolveAgentConnectedAccountPurposeDefaults({
                settings, purposeBindings, agentId: agent.agentId, consumer: agent.identity, declarations: agent.connectedAccounts,
            }).flatMap(entry => entry.target ? [entry.target] : []) : [],
        }));
    }, [agentEntries, agentsKnown, purposeBindings, settings]);
    return { ...agents, agentUses };
}
