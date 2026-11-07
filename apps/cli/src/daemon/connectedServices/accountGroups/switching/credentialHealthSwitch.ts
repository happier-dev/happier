import type { ConnectedServiceCredentialRevisionV1 } from '@happier-dev/protocol';
import type {
    ConnectedServiceAuthGroupSwitchCoordinator,
    ConnectedServiceAuthGroupSwitchState,
    ConnectedServiceAuthGroupSwitchResult,
} from './ConnectedServiceAuthGroupSwitchCoordinator';

export type CredentialHealthSwitchInput<TServiceIdentity> = Readonly<{
    serviceId: TServiceIdentity;
    groupId: string;
    profileId: string;
    credentialRevision: ConnectedServiceCredentialRevisionV1;
}>;

/** Health is already persisted; reuse failure rotation without latching another auth cooldown. */
export async function switchAfterCredentialHealth<TServiceIdentity>(input: CredentialHealthSwitchInput<TServiceIdentity>, deps: Readonly<{
    loadState(input: CredentialHealthSwitchInput<TServiceIdentity>): Promise<ConnectedServiceAuthGroupSwitchState<TServiceIdentity>>;
    coordinator: Pick<ConnectedServiceAuthGroupSwitchCoordinator<TServiceIdentity>, 'switchAfterClassifiedFailure'>;
}>): Promise<ConnectedServiceAuthGroupSwitchResult> {
    const state = await deps.loadState(input);
    if (state.activeProfileId !== input.profileId
        || state.credentialRevision !== input.credentialRevision
        || state.memberStatesByProfileId.get(input.profileId)?.credentialHealthStatus !== 'needs_reauth') {
        return { status: 'stale_context', generation: state.generation };
    }
    return await deps.coordinator.switchAfterClassifiedFailure({
        serviceId: input.serviceId,
        groupId: input.groupId,
        reason: 'auth_expired',
        observedProfileId: input.profileId,
        expectedFailureSource: {
            profileId: input.profileId,
            credentialRevision: input.credentialRevision,
            groupGeneration: state.generation,
            credentialHealthStatus: 'needs_reauth',
        },
    });
}
