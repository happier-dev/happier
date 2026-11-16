import { readTeamCredentialProviderModelSelection, replaceProviderModelCredentialBinding } from '@/sync/domains/teams/teamCredentialProviderModelSelection';
import * as React from 'react';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { sessionModelSelectionV2TeamBindingIntent } from '@happier-dev/protocol/providers/selection/v2';
import type { TeamCredentialProviderModelSelectionV1 } from '@happier-dev/protocol/teams';
import type { WorkflowStepExecutionSelection } from '@happier-dev/protocol/workflows/workflowV1';

import { buildSessionAgentPickerDetailContent, type SessionAgentPickerSelection } from '@/components/sessions/agentPicker/buildSessionAgentPickerDetailContent';
import { findCurrentTeamCredentialProviderModel,
    resourceHasAvailableTeamCredentialProviderModel } from '@/components/sessions/teamCredentials/teamCredentialProviderModelCurrentness';
import { useTeamCredentialSelectionCoordinator } from '@/components/sessions/teamCredentials/useTeamCredentialSelectionCoordinator';
import { sanitizeNewSessionConfigOverridesForModelSelection } from '@/components/sessions/new/modules/newSessionConfigOptionOverrideSanitization';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useHomeTeamCredentialModelCatalog } from '@/hooks/teams/useHomeTeamCredentialModelCatalog';

type DetailParams = Parameters<typeof buildSessionAgentPickerDetailContent>[0];

/** An opened controlled picker consumes the same exact-Machine Team catalog as New Session. */
export function SessionAuthoringEngineDetail(props: Readonly<{
    detail: Omit<DetailParams, 'onSelectionChange'>;
    values: WorkflowStepExecutionSelection;
    onSelectionChange: (selection: SessionAgentPickerSelection, sourceFields?: Partial<WorkflowStepExecutionSelection>) => void;
}>) {
    const { detail, values, onSelectionChange } = props;
    const serverId = detail.capabilityServerId;
    const machineId = detail.selectedMachineId;
    const agentTargetKey = buildBackendTargetKeyV2(detail.backendTarget);
    const enabled = useFeatureEnabled('teams.credentialResources', { scopeKind: 'spawn', serverId });
    const catalog = useHomeTeamCredentialModelCatalog({ serverId, machineId, agentTargetKey,
        enabled: enabled && Boolean(machineId) });
    const coordinate = useTeamCredentialSelectionCoordinator(serverId);
    const current = React.useRef({ catalog, machineId, agentTargetKey, values });
    current.current = { catalog, machineId, agentTargetKey, values };
    const restored = readTeamCredentialProviderModelSelection(values);
    const selectedTeam = restored?.agentTargetKey === agentTargetKey ? restored : null;
    const selectedOtherModel = React.useRef(false);

    const chooseTeamModel = async (selection: TeamCredentialProviderModelSelectionV1) => {
        const resourceKey = `${selection.teamId}:${selection.resourceId}`;
        const isCurrent = () => current.current.machineId === machineId
            && current.current.agentTargetKey === agentTargetKey
            && current.current.catalog.resourceStatusByKey.get(resourceKey)?.kind === 'current'
            && current.current.catalog.resources.some(resource => resourceHasAvailableTeamCredentialProviderModel(resource, selection));
        const resource = catalog.resources.find(candidate => candidate.teamId === selection.teamId && candidate.id === selection.resourceId);
        if (!resource || !machineId || !isCurrent()) return;
        const outcome = await coordinate({ resource, selection, deliveryMode: selection.deliveryMode, isCurrent });
        if (outcome.kind !== 'continue') return;
        const currentResource = current.current.catalog.resources.find(candidate => candidate.teamId === selection.teamId && candidate.id === selection.resourceId);
        const model = currentResource ? findCurrentTeamCredentialProviderModel(currentResource, outcome.selection) : null;
        if (!model) return;
        const { kind: _kind, ...ref } = outcome.selection;
        const binding = sessionModelSelectionV2TeamBindingIntent({ v: 2, updatedAt: Date.now(), ref: { source: 'team_resource', ...ref } }, {
            application: model.application, executionMachineId: machineId,
        });
        selectedOtherModel.current = false;
        onSelectionChange({ ...detail.selection, modelId: selection.modelId, modelSelection: null,
            configOverrides: sanitizeNewSessionConfigOverridesForModelSelection({ providerId: agentTargetKey,
                configOptions: null, modelOptions: [], selectedModelId: selection.modelId,
                selectedModelConfigOptions: model.descriptor.modelOptions ?? [],
                selectedConfigOverrides: detail.selection.configOverrides,
            }),
        }, { modelSelection: null,
            teamCredentialBindings: replaceProviderModelCredentialBinding(current.current.values.teamCredentialBindings, binding),
            ...(outcome.consequence.visibilityRequirement === 'team_context_required' ? { primaryTeamId: selection.teamId } : {}),
        });
    };

    return buildSessionAgentPickerDetailContent({ ...detail,
        selection: selectedTeam ? { ...detail.selection, modelId: selectedTeam.modelId, modelSelection: null } : detail.selection,
        teamModels: {
            probe: catalog.probe,
            teamCredentialResources: catalog.resources, teamCredentialDisplayNames: catalog.displayNames,
            teamNameById: catalog.teamNameById, homeNameByTeamId: catalog.homeNameByTeamId,
            teamCredentialResourceStatusByKey: catalog.resourceStatusByKey,
            selectedTeamCredentialModel: selectedTeam,
            onSelectTeamCredentialModel: chooseTeamModel,
            onSelectOtherModel: () => { selectedOtherModel.current = true; },
        },
        onSelectionChange: selection => {
            const clear = selectedOtherModel.current;
            selectedOtherModel.current = false;
            onSelectionChange(selection, clear && values.teamCredentialBindings?.some(binding => binding.slot.kind === 'provider_model')
                ? { teamCredentialBindings: replaceProviderModelCredentialBinding(values.teamCredentialBindings,
                    { v: 1, slot: { kind: 'provider_model' }, resourceId: null }) }
                : selectedTeam ? { modelSelection: null } : undefined);
        },
    });
}
