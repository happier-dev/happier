import type {
    SessionTeamCredentialBindingIntentListV1,
    SessionTeamCredentialBindingIntentV1,
    TeamCredentialProviderModelSelectionV1,
} from '@happier-dev/protocol/teams';
import type { SessionModelSelectionV1 } from '@happier-dev/protocol/providers/model-selection';

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
    modelSelection?: SessionModelSelectionV1 | null;
    teamCredentialBindings?: SessionTeamCredentialBindingIntentListV1;
}> | null | undefined): TeamCredentialProviderModelSelectionV1 | null {
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

/** Replace this slot without dropping Connected Service credential intents. */
export function replaceProviderModelCredentialBinding(
    bindings: SessionTeamCredentialBindingIntentListV1 | undefined,
    binding: (SessionTeamCredentialBindingIntentV1 & Readonly<{ slot: Readonly<{ kind: 'provider_model' }> }>) | null,
): SessionTeamCredentialBindingIntentListV1 {
    const retained = (bindings ?? []).filter(candidate => candidate.slot.kind !== 'provider_model');
    return binding ? [...retained, binding] : retained;
}
