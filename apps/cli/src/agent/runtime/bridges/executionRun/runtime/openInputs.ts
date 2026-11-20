import { AgentSessionConfigurationSnapshotV1Schema } from '@happier-dev/protocol/runtime/agentSessionV1';
import { ProviderBoundModelRefSchema } from '@happier-dev/protocol/providers/model-selection';
import { readAgentDefaultModelSelectionV1 } from '@happier-dev/protocol/providers/selection/v1';
import { ConnectedServiceBindingsV2Schema } from '@happier-dev/protocol/connect/connected-service-bindings';
import { resolveAgentStartBaselineSelectionV1 } from '@happier-dev/protocol/actions/executor/agentStartAdmission';
import { TeamCredentialProviderModelSelectionV1Schema } from '@happier-dev/protocol/teams/credentials/resourceV1';
import { buildBackendTargetKeyV2, readBackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import type { AcpConfigOptionOverridesV1, BackendTargetRefV2Input, ConnectedServiceBindingsV2, ProviderBoundModelRef, TeamCredentialProviderModelSelectionV1 } from '@happier-dev/protocol';
import type {
    AgentSessionConfigurationSnapshot,
} from '@happier-dev/plugin-sdk/agents/runtime';

import { executionRunPermissionIntentV1 as permissionMode } from '@happier-dev/protocol/actions/executionRunActionPermissionMode';
import { readDeclaredCatalogConnectedAccountServiceIds, resolveCatalogAgentConnectedAccountServiceIds } from '@/agent/catalog/registry';
import type { AgentCatalogEntry } from '@/agent/catalog/types';
import type { ConnectedServiceAppliedParentSelectionUnavailableReason } from '@/daemon/connectedServices/runs/materializeContract';
import { createExecutionRunCodedError } from '../errors';
import { projectExecutionRunChildChoiceV1 } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { areExecutionRunBackendTargetsEqual, resolveExecutionRunRuntimeBackendId } from '../backendTargets';

export type ExecutionRunAppliedParentSelection = Readonly<
    | { status: 'unavailable'; reason?: ConnectedServiceAppliedParentSelectionUnavailableReason }
    | {
        status: 'applied';
        backendTarget: BackendTargetRefV2Input;
        modelId: string | null;
        modelSelection?: ProviderBoundModelRef;
        teamCredentialModel?: TeamCredentialProviderModelSelectionV1;
        connectedServices: ConnectedServiceBindingsV2 | null;
    }
>;

export type ExecutionRunAppliedParentSelectionReader = (
    options?: Readonly<{ waitForReady?: boolean }>,
) => ExecutionRunAppliedParentSelection | Promise<ExecutionRunAppliedParentSelection>;

export type ResolvedExecutionRunChildSelection = Readonly<{
    modelId?: string;
    modelSelection?: ProviderBoundModelRef;
    teamCredentialModel?: TeamCredentialProviderModelSelectionV1;
    connectedServices?: ConnectedServiceBindingsV2 | null;
    selectionSource: 'explicit' | 'inherited' | 'independent' | 'retained';
    /** Transient model intent; lifecycle provenance remains independent. */
    modelSelectionSource?: 'explicit' | 'inherited';
    inheritedFromDifferentAgent: boolean;
}>;

/** The Account's exact per-Agent launch choice; null leaves the Agent's own default in charge. */
export function resolveExecutionRunAgentDefaultSelection(input: Readonly<{
    backendTarget: BackendTargetRefV2Input;
    accountSettings?: Readonly<{ providerDefaultModelSelectionsByAgentTargetKeyV1?: unknown }> | null;
}>): ProviderBoundModelRef | null {
    return readAgentDefaultModelSelectionV1(input.accountSettings?.providerDefaultModelSelectionsByAgentTargetKeyV1,
        input.backendTarget)?.ref ?? null;
}

export function readExecutionRunAppliedParentModelId(parent: ExecutionRunAppliedParentSelection): string | null {
    return parent.status === 'applied'
        ? parent.teamCredentialModel?.modelId ?? parent.modelSelection?.modelId ?? parent.modelId
        : null;
}

function childSelectionRefusal(code: 'execution_run_parent_selection_unavailable' | 'execution_run_child_choice_required', message: string) {
    return Object.assign(createExecutionRunCodedError(code, message), { code });
}

function projectInheritedConnectedServices(
    bindings: ConnectedServiceBindingsV2 | null,
    backendTarget: BackendTargetRefV2Input,
    sameAgent: boolean,
    agentCatalogEntry: Pick<AgentCatalogEntry, 'connectedAccountServiceIds'> | null | undefined,
): ConnectedServiceBindingsV2 | null {
    if (bindings === null) return null;
    const parsed = ConnectedServiceBindingsV2Schema.parse(bindings);
    const declaredServiceIds = sameAgent ? null : agentCatalogEntry === undefined
        ? resolveCatalogAgentConnectedAccountServiceIds(resolveExecutionRunRuntimeBackendId(backendTarget))
        : readDeclaredCatalogConnectedAccountServiceIds(agentCatalogEntry);
    const bindingsByServiceId: ConnectedServiceBindingsV2['bindingsByServiceId'] = {};
    for (const [serviceId, binding] of Object.entries(parsed.bindingsByServiceId)) {
        if (declaredServiceIds && !declaredServiceIds.includes(serviceId)) {
            if (binding.source === 'native') continue;
            throw childSelectionRefusal('execution_run_child_choice_required',
                'Choose a connected account or pool supported by the child Agent.');
        }
        bindingsByServiceId[serviceId] = binding;
    }
    const target = readBackendTargetRefV2(backendTarget);
    return resolveAgentStartBaselineSelectionV1({ targetKey: buildBackendTargetKeyV2(target),
        profileId: undefined, connectedServices: undefined,
    }, { agentTarget: target, connectedServices: { v: 2, bindingsByServiceId } }).connectedServices ?? null;
}

/** Resolves child omissions once, before credential or Provider materialization. */
export type ExecutionRunChildSelectionInput = Readonly<{
    backendTarget: BackendTargetRefV2Input;
    agentCatalogEntry?: Pick<AgentCatalogEntry, 'connectedAccountServiceIds'> | null;
    lifecycle: 'attached' | 'independent' | 'retained';
    modelId?: string;
    modelSelection?: ProviderBoundModelRef | null;
    teamCredentialModel?: TeamCredentialProviderModelSelectionV1;
    connectedServices?: ConnectedServiceBindingsV2 | null;
    connectedServicesDefaultServiceIds?: readonly string[];
    parent?: ExecutionRunAppliedParentSelection;
    childSelection?: 'agentDefault';
    agentDefaultSelection?: ProviderBoundModelRef | null;
    /** Host-resolved summary default; ordinary attached children still require applied parent custody. */
    fallbackSelection?: ProviderBoundModelRef;
}>;

/** Only omissions that inherit parent custody need to join its startup. */
export function executionRunChildSelectionNeedsAppliedParent(input: ExecutionRunChildSelectionInput): boolean {
    return input.lifecycle === 'attached' && input.childSelection !== 'agentDefault'
        && input.modelSelection !== null && !input.modelSelection?.providerConnectionId && input.teamCredentialModel === undefined
        && !((input.modelSelection !== undefined || input.modelId !== undefined) && (input.connectedServices !== undefined
            || (input.connectedServicesDefaultServiceIds?.length ?? 0) > 0));
}

export function resolveExecutionRunChildSelection(input: ExecutionRunChildSelectionInput): ResolvedExecutionRunChildSelection {
    try {
        if (input.childSelection === 'agentDefault') {
            if (input.modelId !== undefined || input.modelSelection !== undefined || input.teamCredentialModel !== undefined
                || input.connectedServices !== undefined || input.connectedServicesDefaultServiceIds !== undefined) {
                throw new Error('Account default choice conflicts with an explicit child selection');
            }
            return { ...resolveExecutionRunChildSelectionInput({ ...input, lifecycle: 'independent',
                modelSelection: input.agentDefaultSelection ?? null }), selectionSource: 'explicit', modelSelectionSource: 'explicit' };
        }
        return { ...resolveExecutionRunChildSelectionInput(input),
            modelSelectionSource: input.modelId?.trim() || input.modelSelection || input.teamCredentialModel ? 'explicit' : 'inherited' };
    } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'execution_run_child_choice_required') {
            Object.assign(error, { details: { childChoice: projectExecutionRunChildChoiceV1({
                agentTargetKey: buildBackendTargetKeyV2(readBackendTargetRefV2(input.backendTarget)),
                parentRouteCompatibility: 'incompatible',
                parentModelSelection: input.parent?.status === 'applied' ? input.parent.modelSelection ?? null : null,
            }) } });
        }
        throw error;
    }
}

function resolveExecutionRunChildSelectionInput(input: ExecutionRunChildSelectionInput): ResolvedExecutionRunChildSelection {
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
    if (!executionRunChildSelectionNeedsAppliedParent(input)) return explicit;

    const hasExplicitCredentialRoute = input.connectedServices !== undefined
        || (input.connectedServicesDefaultServiceIds?.length ?? 0) > 0;

    const parent = input.parent;
    if (!parent || parent.status !== 'applied') {
        if (!hasExplicitCredentialRoute && input.fallbackSelection) {
            return resolveExecutionRunChildSelectionInput({ ...input, lifecycle: 'independent',
                modelSelection: { ...input.fallbackSelection, modelId: modelId ?? input.fallbackSelection.modelId } });
        }
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
    const parentModelId = readExecutionRunAppliedParentModelId(parent);
    const parentModelTargetKey = parent.teamCredentialModel?.agentTargetKey ?? parent.modelSelection?.agentTargetKey;
    if ((parent.modelId !== null && parent.modelId !== parentModelId)
        || (parentModelTargetKey && !areExecutionRunBackendTargetsEqual(parentModelTargetKey, parent.backendTarget))) {
        throw childSelectionRefusal('execution_run_parent_selection_unavailable', 'The parent applied model and route are inconsistent.');
    }
    if (selection) {
        return { ...explicit,
            connectedServices: projectInheritedConnectedServices(parent.connectedServices, input.backendTarget, sameAgent, input.agentCatalogEntry),
            inheritedFromDifferentAgent: !sameAgent,
        };
    }
    if (!parentModelId && !modelId && input.fallbackSelection) {
        return resolveExecutionRunChildSelectionInput({ ...input, lifecycle: 'independent',
            modelSelection: input.fallbackSelection });
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
    const connectedServices = projectInheritedConnectedServices(parent.connectedServices, input.backendTarget, sameAgent, input.agentCatalogEntry);
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
    modelSelectionSource?: ResolvedExecutionRunChildSelection['modelSelectionSource'];
    modelSelection?: ProviderBoundModelRef | null;
    sessionConfigOptionOverrides?: AcpConfigOptionOverridesV1;
    acpSessionModeId?: string;
    permissionMode: string;
    allowedTools?: AgentSessionConfigurationSnapshot['allowedTools'];
    unlistedTools?: AgentSessionConfigurationSnapshot['unlistedTools'];
    workspaceWrites?: 'allow' | 'deny';
    nativeSandbox?: AgentSessionConfigurationSnapshot['nativeSandbox'];
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
            selectionSource: input.modelSelectionSource ?? 'inherited',
        },
        permissionIntent: {
            value: permissionMode(input.permissionMode),
            updatedAtMs: input.updatedAtMs,
        },
        ...(input.workspaceWrites !== undefined ? { workspaceWrites: input.workspaceWrites } : {}),
        ...(input.nativeSandbox !== undefined ? { nativeSandbox: input.nativeSandbox } : {}),
        ...(input.allowedTools !== undefined ? { allowedTools: input.allowedTools } : {}),
        ...(input.unlistedTools !== undefined ? { unlistedTools: input.unlistedTools } : {}),
        // Permission intent alone cannot distinguish no-tools from read-only.
        // The existing exclusive allowlist carries that ceiling to every Agent.
        ...(input.permissionMode.trim() === 'no_tools' ? { allowedTools: [], unlistedTools: 'deny' } : {}),
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
