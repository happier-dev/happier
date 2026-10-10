import { AgentSessionConfigurationSnapshotV1Schema } from '@happier-dev/protocol/runtime/agentSessionV1';
import { ProviderBoundModelRefSchema } from '@happier-dev/protocol/providers/model-selection';
import { ConnectedServiceBindingsV2Schema } from '@happier-dev/protocol/connect/connected-service-bindings';
import { TeamCredentialProviderModelSelectionV1Schema } from '@happier-dev/protocol/teams/credentials/resourceV1';
import { buildBackendTargetKeyV2, readBackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import type { AcpConfigOptionOverridesV1, BackendTargetRefV2Input, ConnectedServiceBindingsV2, ProviderBoundModelRef, TeamCredentialProviderModelSelectionV1 } from '@happier-dev/protocol';
import type {
    AgentSessionConfigurationSnapshot,
} from '@happier-dev/plugin-sdk/agents/runtime';

import { permissionMode } from '@/agent/executionRuns/policy/permissionMode';
import { resolveCatalogAgentConnectedAccountServiceIds } from '@/agent/catalog/registry';
import { createExecutionRunCodedError } from '../errors';
import { areExecutionRunBackendTargetsEqual, resolveExecutionRunRuntimeBackendId } from '../backendTargets';

export type ExecutionRunAppliedParentSelection = Readonly<
    | { status: 'unavailable' }
    | {
        status: 'applied';
        backendTarget: BackendTargetRefV2Input;
        modelId: string | null;
        modelSelection?: ProviderBoundModelRef;
        teamCredentialModel?: TeamCredentialProviderModelSelectionV1;
        connectedServices: ConnectedServiceBindingsV2 | null;
    }
>;

export type ResolvedExecutionRunChildSelection = Readonly<{
    modelId?: string;
    modelSelection?: ProviderBoundModelRef;
    teamCredentialModel?: TeamCredentialProviderModelSelectionV1;
    connectedServices?: ConnectedServiceBindingsV2 | null;
    selectionSource: 'explicit' | 'inherited' | 'independent' | 'retained';
    inheritedFromDifferentAgent: boolean;
}>;

function childSelectionRefusal(code: 'execution_run_parent_selection_unavailable' | 'execution_run_child_choice_required', message: string) {
    return Object.assign(createExecutionRunCodedError(code, message), { code });
}

function projectInheritedConnectedServices(
    bindings: ConnectedServiceBindingsV2 | null,
    backendTarget: BackendTargetRefV2Input,
    sameAgent: boolean,
): ConnectedServiceBindingsV2 | null {
    if (bindings === null) return null;
    const parsed = ConnectedServiceBindingsV2Schema.parse(bindings);
    const declaredServiceIds = sameAgent ? null : resolveCatalogAgentConnectedAccountServiceIds(
        resolveExecutionRunRuntimeBackendId(backendTarget),
    );
    const bindingsByServiceId: ConnectedServiceBindingsV2['bindingsByServiceId'] = {};
    for (const [serviceId, binding] of Object.entries(parsed.bindingsByServiceId)) {
        if (declaredServiceIds && !declaredServiceIds.includes(serviceId)) {
            if (binding.source === 'native') continue;
            throw childSelectionRefusal('execution_run_child_choice_required',
                'Choose a connected account or pool supported by the child Agent.');
        }
        if (binding.source === 'team_resource' && binding.deliveryMode === 'direct') {
            throw childSelectionRefusal('execution_run_child_choice_required',
                'Choose a child credential route; direct Team credential custody cannot be inherited.');
        }
        bindingsByServiceId[serviceId] = binding.source === 'connected' && binding.selection === 'group'
            ? { source: 'connected', selection: 'group', groupId: binding.groupId }
            : binding;
    }
    return { v: 2, bindingsByServiceId };
}

/** Resolves child omissions once, before credential or Provider materialization. */
export function resolveExecutionRunChildSelection(input: Readonly<{
    backendTarget: BackendTargetRefV2Input;
    lifecycle: 'attached' | 'independent' | 'retained';
    modelId?: string;
    modelSelection?: ProviderBoundModelRef | null;
    teamCredentialModel?: TeamCredentialProviderModelSelectionV1;
    connectedServices?: ConnectedServiceBindingsV2 | null;
    connectedServicesDefaultServiceIds?: readonly string[];
    parent?: ExecutionRunAppliedParentSelection;
}>): ResolvedExecutionRunChildSelection {
    const { modelSelection: selection, modelId } = resolveExecutionRunModelInput(input);
    const teamCredentialModel = input.teamCredentialModel
        ? TeamCredentialProviderModelSelectionV1Schema.parse(input.teamCredentialModel)
        : undefined;
    if (teamCredentialModel) {
        if (input.modelSelection !== undefined) throw new Error('Execution-run has conflicting Provider and Team model selections');
        if (!areExecutionRunBackendTargetsEqual(teamCredentialModel.agentTargetKey, input.backendTarget)) {
            throw new Error('Execution-run model selection does not target its backend');
        }
        if (modelId !== undefined && modelId !== teamCredentialModel.modelId) {
            throw new Error('Execution-run model selection does not match modelId');
        }
    }
    const explicit: ResolvedExecutionRunChildSelection = {
        ...(teamCredentialModel || modelId ? { modelId: teamCredentialModel?.modelId ?? modelId } : {}),
        ...(selection ? { modelSelection: selection } : {}),
        ...(teamCredentialModel ? { teamCredentialModel } : {}),
        ...(input.connectedServices !== undefined ? {
            connectedServices: input.connectedServices === null ? null : ConnectedServiceBindingsV2Schema.parse(input.connectedServices),
        } : {}),
        selectionSource: input.lifecycle === 'attached' ? 'explicit' : input.lifecycle,
        inheritedFromDifferentAgent: false,
    };
    if (input.lifecycle !== 'attached' || input.modelSelection === null || selection || teamCredentialModel) return explicit;

    const hasExplicitCredentialRoute = input.connectedServices !== undefined
        || (input.connectedServicesDefaultServiceIds?.length ?? 0) > 0;

    const parent = input.parent;
    if (!parent || parent.status !== 'applied') {
        if (hasExplicitCredentialRoute && modelId !== undefined) return explicit;
        throw childSelectionRefusal('execution_run_parent_selection_unavailable',
            'The parent applied model and route are unavailable. Choose an explicit child model and route.');
    }
    const sameAgent = areExecutionRunBackendTargetsEqual(parent.backendTarget, input.backendTarget);
    // Explicit native/account choices replace the parent's credential route.
    if (hasExplicitCredentialRoute) {
        if (!sameAgent && !modelId) {
            throw childSelectionRefusal('execution_run_child_choice_required',
                'Choose a native model supported by the child Agent.');
        }
        const resolvedModelId = modelId ?? (sameAgent ? parent.modelId : null);
        return {
            ...explicit,
            ...(resolvedModelId ? { modelId: resolvedModelId } : {}),
        };
    }
    if (parent.modelSelection && parent.teamCredentialModel) {
        throw childSelectionRefusal('execution_run_parent_selection_unavailable', 'The parent applied route is inconsistent.');
    }
    const parentModelId = parent.teamCredentialModel?.modelId ?? parent.modelSelection?.modelId ?? parent.modelId;
    const parentModelTargetKey = parent.teamCredentialModel?.agentTargetKey ?? parent.modelSelection?.agentTargetKey;
    if ((parent.modelId !== null && parent.modelId !== parentModelId)
        || (parentModelTargetKey && !areExecutionRunBackendTargetsEqual(parentModelTargetKey, parent.backendTarget))) {
        throw childSelectionRefusal('execution_run_parent_selection_unavailable', 'The parent applied model and route are inconsistent.');
    }
    const inheritedTeam = parent.teamCredentialModel
        ? TeamCredentialProviderModelSelectionV1Schema.parse(parent.teamCredentialModel)
        : undefined;
    if (inheritedTeam?.deliveryMode === 'direct') {
        throw childSelectionRefusal('execution_run_child_choice_required',
            'Choose a child credential route; direct Team credential custody cannot be inherited.');
    }
    const inheritedProvider = parent.modelSelection ? ProviderBoundModelRefSchema.parse(parent.modelSelection) : undefined;
    if (!sameAgent && !inheritedTeam && !inheritedProvider?.providerConnectionId && !modelId) {
        throw childSelectionRefusal('execution_run_child_choice_required',
            'Choose a model and credential route supported by the child Agent.');
    }
    const resolvedModelId = modelId ?? parentModelId ?? undefined;
    const agentTargetKey = sameAgent && parentModelTargetKey
        ? parentModelTargetKey
        : buildBackendTargetKeyV2(readBackendTargetRefV2(input.backendTarget));
    const connectedServices = projectInheritedConnectedServices(parent.connectedServices, input.backendTarget, sameAgent);
    return {
        ...(resolvedModelId ? { modelId: resolvedModelId } : {}),
        ...(inheritedTeam ? { teamCredentialModel: { ...inheritedTeam, agentTargetKey, modelId: resolvedModelId ?? inheritedTeam.modelId } } : {}),
        ...(!inheritedTeam && resolvedModelId ? {
            modelSelection: { agentTargetKey, providerConnectionId: inheritedProvider?.providerConnectionId ?? null, modelId: resolvedModelId },
        } : {}),
        connectedServices,
        selectionSource: modelId ? 'explicit' : 'inherited',
        inheritedFromDifferentAgent: !sameAgent,
    };
}

function resolveExecutionRunModelInput(input: Readonly<{
    backendTarget: BackendTargetRefV2Input;
    modelId?: string;
    modelSelection?: ProviderBoundModelRef | null;
}>): Readonly<{ modelSelection?: ProviderBoundModelRef; modelId?: string }> {
    const modelSelection = input.modelSelection ? ProviderBoundModelRefSchema.parse(input.modelSelection) : undefined;
    if (modelSelection && !areExecutionRunBackendTargetsEqual(modelSelection.agentTargetKey, input.backendTarget)) {
        throw new Error('Execution-run model selection does not target its backend');
    }
    const modelId = input.modelId?.trim() || undefined;
    if (modelSelection && modelId !== undefined && modelId !== modelSelection.modelId) {
        throw new Error('Execution-run model selection does not match modelId');
    }
    return { ...(modelSelection ? { modelSelection } : {}), ...(modelSelection || modelId ? { modelId: modelSelection?.modelId ?? modelId } : {}) };
}

export function buildExecutionRunConfiguration(input: Readonly<{
    backendTarget: BackendTargetRefV2Input;
    modelId?: string;
    modelSelection?: ProviderBoundModelRef | null;
    sessionConfigOptionOverrides?: AcpConfigOptionOverridesV1;
    acpSessionModeId?: string;
    permissionMode: string;
    workspaceWrites?: 'allow' | 'deny';
    updatedAtMs: number;
}>): Readonly<{
    modelSelection?: ProviderBoundModelRef;
    configuration: AgentSessionConfigurationSnapshot;
}> {
    const { modelSelection, modelId } = resolveExecutionRunModelInput(input);
    const selectedModelId = modelId ?? null;
    const configuration = AgentSessionConfigurationSnapshotV1Schema.parse({
        mode: {
            value: input.acpSessionModeId ?? null,
            updatedAtMs: input.acpSessionModeId === undefined ? 0 : input.updatedAtMs,
        },
        model: {
            value: selectedModelId,
            updatedAtMs: selectedModelId === null ? 0 : input.updatedAtMs,
        },
        permissionIntent: {
            value: permissionMode(input.permissionMode),
            updatedAtMs: input.updatedAtMs,
        },
        ...(input.workspaceWrites !== undefined ? { workspaceWrites: input.workspaceWrites } : {}),
        options: Object.fromEntries(
            Object.entries(
                input.sessionConfigOptionOverrides?.overrides ?? {},
            ).map(([id, option]) => [
                id,
                { value: option.value, updatedAtMs: option.updatedAt },
            ]),
        ),
    });
    return Object.freeze({
        ...(modelSelection ? { modelSelection } : {}),
        configuration,
    });
}
