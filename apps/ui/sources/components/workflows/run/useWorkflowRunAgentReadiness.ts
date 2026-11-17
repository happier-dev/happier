import { readSessionModelSelectionProviderConnectionId } from '@happier-dev/protocol/providers/selection/v2';
import * as React from 'react';
import type { WorkflowDefinitionV1 } from '@happier-dev/protocol/workflows/workflowV1';
import type { WorkflowMaterializedLeafV1 } from '@happier-dev/protocol/workflows/workflowDefinitionV1';
import { walkWorkflowBlocks } from '@happier-dev/protocol/workflows/workflowDefinitionEditV1';
import { resolveWorkflowStepSelectionV1, type WorkflowResolvedStepSelectionV1 } from '@happier-dev/protocol/workflows/workflowStepSelectionV1';
import { findMachineAgentForBackendTarget } from '@/agents/machineAgents/machineAgentCatalog';
import { projectMachineAgentForCredential } from '@/agents/machineAgents/machineAgentModel';
import { useMachineAgentsByMachine, type MachineAgentsSnapshot } from '@/agents/machineAgents/useMachineAgents';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { describeAgentReadinessCause } from '@/components/sessions/model/sessionReadinessPresentation';

/** Consume held availability for concrete new conversations; admission still owns unknown selections. */
export function useWorkflowRunAgentReadiness(params: Readonly<{
    definition?: WorkflowDefinitionV1;
    materializedLeaves?: readonly WorkflowMaterializedLeafV1[];
    machineId?: string | null;
    serverId?: string | null;
    enabled: boolean;
}>): string | null {
    const presented = useLayoutPresentationActive();
    const activeServer = useActiveServerSnapshot(!params.serverId);
    const serverId = params.serverId ?? activeServer.serverId;
    const selections = React.useMemo(() => {
        const candidates: readonly WorkflowResolvedStepSelectionV1[] = params.materializedLeaves !== undefined
            ? params.materializedLeaves.filter(leaf => leaf.kind === 'step').map(leaf => leaf.selection)
            : walkWorkflowBlocks(params.definition?.blocks ?? []).flatMap(block => block.kind === 'step'
                ? [resolveWorkflowStepSelectionV1({ defaults: params.definition!.defaults,
                    step: block.execution, purpose: 'authoring' }).selection] : []);
        return candidates.filter(selection => selection.agentTarget
            && (selection.conversation === undefined || selection.conversation.kind === 'fresh'
                || selection.conversation.kind === 'shared_run'));
    }, [params.definition, params.materializedLeaves]);
    const machineIds = React.useMemo(() => params.enabled && presented && params.machineId && selections.length > 0
        ? [params.machineId] : [], [params.enabled, params.machineId, presented, selections]);
    const selectCause = React.useCallback((snapshot: MachineAgentsSnapshot): string | null => {
        for (const selection of selections) {
            if (!selection.agentTarget) continue;
            const held = findMachineAgentForBackendTarget(snapshot.agents, selection.agentTarget);
            if (!held || held.stale) continue;
            // A Provider or Team route has not been admitted here. Let the credential owner retain
            // known installation facts while reporting its unread authentication as unknown.
            const unreadRoute = (selection.modelSelection ? readSessionModelSelectionProviderConnectionId(selection.modelSelection) : null) != null
                || Object.values(selection.connectedServices?.bindingsByServiceId ?? {})
                    .some(binding => binding.source === 'team_resource');
            const agent = selection.connectedServices === undefined && !unreadRoute ? held
                : projectMachineAgentForCredential(held, {
                    credentialBindings: selection.connectedServices ?? null,
                    credentialBindingsReady: !unreadRoute,
                    groupOptionsByServiceId: Object.fromEntries(held.signIn.connectedServices
                        .map(service => [service.serviceId, service.groups ?? []])),
                });
            if (agent && (agent.state === 'needsSignIn' || agent.state === 'notInstalled' || agent.state === 'unsupported')) {
                return describeAgentReadinessCause({ title: agent.title, state: agent.state });
            }
        }
        return null;
    }, [selections]);
    // This is the same inventory Home reads. Mounting Start never refreshes or probes it.
    const causes = useMachineAgentsByMachine({ serverId, machineIds, load: false }, selectCause);
    return params.machineId ? causes.get(params.machineId) ?? null : null;
}
