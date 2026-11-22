import { readSessionModelRefProviderConnectionId } from '@happier-dev/protocol/providers/selection/v2';
import * as React from 'react';
import type { ExecutionRunResolvedSelection } from '@happier-dev/protocol/execution/runs/requestedConfiguration';
import { parseQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';

import { useProjectedQualifiedConnectedAccountTargetPresentations, type ProjectedQualifiedConnectedAccountTarget } from '@/hooks/server/connectedServices/useProjectedQualifiedConnectedAccountTargetPresentations';
import { useHomeTeamCredentialModelCatalog } from '@/hooks/teams/useHomeTeamCredentialModelCatalog';
import { presentConnectedAccountPurposeTeamResource } from '@/sync/domains/connectedServices/qualifiedConnectedAccountTargetPresentation';
import { resolveMachineRpcTargetServerId } from '@/sync/runtime/orchestration/serverScopedRpc/resolveMachineRpcTargetServerId';

/** Display the recorded route, never infer a current Account/pool member or authorize its use. */
export function useExecutionRunSourceLabel(
    selection: ExecutionRunResolvedSelection | undefined,
    serverId: string | null | undefined,
): string | null {
    const resolvedServerId = resolveMachineRpcTargetServerId(serverId) ?? null;
    const connectionId = selection?.modelSelection ? readSessionModelRefProviderConnectionId(selection.modelSelection) : null;
    const connectedServices = !connectionId && !selection?.teamCredentialModel
        ? selection?.connectedServices
        : null;
    const targets = React.useMemo(() => {
        const targets: ProjectedQualifiedConnectedAccountTarget[] = [];
        for (const [key, value] of Object.entries(connectedServices?.bindingsByServiceId ?? {})) {
            if (value.source !== 'connected') continue;
            const service = parseQualifiedPluginContributionKey(key);
            if (!service) continue;
            targets.push({ key, target: value.selection === 'group'
                ? { kind: 'group' as const, service, groupId: value.groupId }
                : { kind: 'account' as const, account: { service, accountId: value.profileId } } });
        }
        return targets;
    }, [connectedServices]);
    const { presentationsByKey } = useProjectedQualifiedConnectedAccountTargetPresentations(resolvedServerId, targets);
    const teamModel = selection?.teamCredentialModel;
    const teamBindings = Object.values(connectedServices?.bindingsByServiceId ?? {}).filter(binding => binding.source === 'team_resource');
    const teamCatalog = useHomeTeamCredentialModelCatalog({ serverId: resolvedServerId,
        // Recorded Run labels carry Account identity, not an execution Machine.
        machineId: null,
        agentTargetKey: teamModel?.agentTargetKey,
        enabled: teamModel !== undefined || teamBindings.length > 0 });
    if (teamModel) {
        return presentConnectedAccountPurposeTeamResource({
            teamResource: { teamId: teamModel.teamId, selection: teamModel },
            teamResources: teamCatalog.resources,
            teamResourceDisplayNames: teamCatalog.displayNames,
            teamNameById: teamCatalog.teamNameById,
            serviceTitle: null,
        }).accessibilityLabel;
    }
    const teamLabels = teamBindings.map(binding => {
        const resource = teamCatalog.resources.find(resource => resource.id === binding.resourceId);
        return presentConnectedAccountPurposeTeamResource({
            teamResource: { teamId: resource?.teamId ?? '', selection: binding },
            teamResources: teamCatalog.resources,
            teamResourceDisplayNames: teamCatalog.displayNames,
            teamNameById: teamCatalog.teamNameById,
            serviceTitle: null,
        }).accessibilityLabel;
    });
    // A recorded account this Home no longer lists says nothing about the Run; the row omits it.
    const labels = [...new Set([...targets.map(target => {
        const presentation = presentationsByKey[target.key];
        return presentation?.targetMissing ? null : presentation?.accessibilityLabel;
    }), ...teamLabels].filter(Boolean))];
    return labels.join(' · ') || null;
}
