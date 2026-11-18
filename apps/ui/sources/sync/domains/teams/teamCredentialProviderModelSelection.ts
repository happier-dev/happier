import type {
    SessionTeamCredentialBindingIntentListV1,
    SessionTeamCredentialBindingIntentV1,
    TeamCredentialProviderModelSelectionV1,
} from '@happier-dev/protocol/teams';
import type { AgentExecutionTargetV1 } from '@happier-dev/protocol/agents/executionTargetV1';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import type { SessionModelRef, SessionModelSelection } from '@happier-dev/protocol/providers/selection/v2';

export type AssignedProviderModelCredentialBinding = Extract<
    SessionTeamCredentialBindingIntentV1,
    Readonly<{ resourceId: string }>
> & Readonly<{ slot: Readonly<{ kind: 'provider_model' }> }>;

/** Read the one assigned Provider-model intent without reinterpreting a clear/null intent. */
export function findAssignedProviderModelCredentialBinding(
    bindings: SessionTeamCredentialBindingIntentListV1 | null | undefined,
): AssignedProviderModelCredentialBinding | null {
    return bindings?.find((binding): binding is AssignedProviderModelCredentialBinding => (
        binding.slot.kind === 'provider_model' && binding.resourceId !== null
    )) ?? null;
}

/** Restore the authored source; the catalog separately owns whether it can execute. */
export function readTeamCredentialProviderModelSelection(input: Readonly<{
    modelSelection?: SessionModelSelection | null;
    teamCredentialBindings?: SessionTeamCredentialBindingIntentListV1;
}> | null | undefined): TeamCredentialProviderModelSelectionV1 | null {
    if (input?.modelSelection?.v === 2) {
        if (input.modelSelection.ref.source !== 'team_resource') return null;
        const { source: _source, ...ref } = input.modelSelection.ref;
        return { kind: 'team_credential_provider_model', ...ref };
    }
    const binding = findAssignedProviderModelCredentialBinding(input?.teamCredentialBindings);
    const legacyRef = input?.modelSelection?.ref;
    const ref = legacyRef ?? binding?.providerModelSelection;
    if (!binding?.teamId || !ref || (legacyRef && legacyRef.providerConnectionId !== null)) return null;
    return {
        kind: 'team_credential_provider_model', teamId: binding.teamId, resourceId: binding.resourceId,
        expectedResourceRevision: binding.expectedResourceRevision, deliveryMode: binding.deliveryMode,
        agentTargetKey: ref.agentTargetKey, modelId: ref.modelId,
        ...(binding.nativeDelivery ? { nativeDelivery: binding.nativeDelivery } : {}),
    };
}

/** Restore the effective model reference for readers of an authored Agent selection. */
export function readAuthoredSessionModelRef(input: Readonly<{
    agentTarget?: AgentExecutionTargetV1;
    modelSelection?: SessionModelSelection | null;
    teamCredentialBindings?: SessionTeamCredentialBindingIntentListV1;
}>): SessionModelRef | undefined {
    const modelRef = input.modelSelection?.ref;
    if (input.modelSelection?.v === 2 || !input.agentTarget) return modelRef;
    const teamModel = readTeamCredentialProviderModelSelection(input);
    if (!teamModel || teamModel.agentTargetKey !== buildBackendTargetKeyV2(input.agentTarget)) return modelRef;
    const { kind: _kind, ...teamRef } = teamModel;
    return { source: 'team_resource', ...teamRef };
}

/** Replace this slot without dropping Connected Service credential intents. */
export function replaceProviderModelCredentialBinding(
    bindings: SessionTeamCredentialBindingIntentListV1 | undefined,
    binding: (SessionTeamCredentialBindingIntentV1 & Readonly<{ slot: Readonly<{ kind: 'provider_model' }> }>) | null,
): SessionTeamCredentialBindingIntentListV1 {
    const retained = (bindings ?? []).filter(candidate => candidate.slot.kind !== 'provider_model');
    return binding ? [...retained, binding] : retained;
}
