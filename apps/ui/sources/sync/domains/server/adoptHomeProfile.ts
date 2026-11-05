import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import {
    getHomeCredentialsUnderMutationAuthority,
    completeHomeCredentialReplacement,
    removeHomeCredentialsUnderMutationAuthority,
    setHomeCredentialsWithRollbackUnderMutationAuthority,
} from '@/auth/storage/tokenStorage';
import {
    adoptHomeProfile,
    adoptHomeProfileUnderMutationAuthority,
    getServerProfileById,
    listServerProfiles,
    preflightHomeProfileAdoption,
    type ServerProfile,
} from './serverProfiles';
import { withHomeMutationAuthority, type HomeMutationAuthority } from './homeMutationLock';

type HomeProfileAdoptionInput = Parameters<typeof adoptHomeProfile>[0];

export type AdoptHomeProfileWithCredentialsInput = HomeProfileAdoptionInput & Readonly<{
    credentials: AuthCredentials;
    shouldCancel?: () => boolean;
}>;

export type HomeProfileCredentialRollbackOutcome =
    | Readonly<{ kind: 'succeeded' }>
    | Readonly<{ kind: 'not_applied'; reason: 'ownership_changed' }>
    | Readonly<{ kind: 'failed'; error: unknown }>;

/**
 * Credential persistence succeeded, but profile adoption did not and the exact
 * attempted write could not be rolled back. Callers must surface this as a
 * recoverable partial state rather than reporting a clean adoption failure.
 */
export class HomeProfileAdoptionPartialCommitError extends Error {
    readonly code = 'home_profile_adoption_partial_commit' as const;

    constructor(
        readonly adoptionError: unknown,
        readonly canonicalServerUrl: string,
        readonly serverIdentityId: string,
        readonly rollbackOutcome: Exclude<HomeProfileCredentialRollbackOutcome, { kind: 'succeeded' }>,
    ) {
        super('Home credential was stored, but profile adoption did not complete');
        this.name = 'HomeProfileAdoptionPartialCommitError';
    }
}

/**
 * Directory descriptors are discovery hints, not credential-routing authority. A credential can
 * be stored only after this exact Home has been observed through a current identity-bound Home
 * connection.
 */
export class HomeProfileAdoptionRequiresCurrentObservationError extends Error {
    readonly code = 'home_profile_adoption_requires_current_observation' as const;

    constructor(
        readonly canonicalServerUrl: string,
        readonly serverIdentityId: string,
    ) {
        super('Home credentials require a current identity-bound Home observation');
        this.name = 'HomeProfileAdoptionRequiresCurrentObservationError';
    }
}

/**
 * The profile move committed, but its credential verification or obsolete URL-scope
 * cleanup could not be completed. Callers receive the exact incomplete stage rather
 * than a clean success or an ambiguous generic failure.
 */
export class HomeProfileCanonicalUrlMigrationPartialCommitError extends Error {
    readonly code = 'home_profile_canonical_url_migration_partial_commit' as const;

    constructor(
        readonly stage: 'destination_credential_verification' | 'obsolete_credential_cleanup',
        readonly serverIdentityId: string,
        readonly fromCanonicalServerUrl: string,
        readonly toCanonicalServerUrl: string,
        readonly profile: ServerProfile,
    ) {
        super('Home canonical URL migration did not complete its credential transaction');
        this.name = 'HomeProfileCanonicalUrlMigrationPartialCommitError';
    }
}

export type HomeProfileAdoptionPartialCommitFailure =
    | HomeProfileAdoptionPartialCommitError
    | HomeProfileCanonicalUrlMigrationPartialCommitError;

export function isHomeProfileAdoptionPartialCommitFailure(
    error: unknown,
): error is HomeProfileAdoptionPartialCommitFailure {
    return error instanceof HomeProfileAdoptionPartialCommitError
        || error instanceof HomeProfileCanonicalUrlMigrationPartialCommitError;
}

/**
 * Handles the same-identity canonical URL branch inside the one credentialed-adoption
 * transaction. The profile owner decides the move (so label, aliases, groups, focus
 * pointers and unrelated Homes are preserved by construction); the credential remains
 * in its canonical identity scope, is verified through the destination URL, and only
 * obsolete URL-hash aliases are removed. Advisory descriptors cannot reach this branch:
 * the profile owner keeps their target pinned to the established URL.
 */
async function migrateExistingHomeCanonicalUrlUnderMutationAuthority(
    input: AdoptHomeProfileWithCredentialsInput,
    adoption: HomeProfileAdoptionInput,
    target: ReturnType<typeof preflightHomeProfileAdoption>,
    authority: HomeMutationAuthority,
): Promise<ServerProfile | null> {
    const identity = target.serverIdentityId;
    const existing = identity ? getServerProfileById(identity) : null;
    const fromCanonicalServerUrl = existing
        ? existing.canonicalServerUrl ?? existing.serverUrl
        : null;
    const toCanonicalServerUrl = target.canonicalServerUrl;
    if (
        !identity
        || !existing
        || existing.serverIdentityId !== identity
        || !fromCanonicalServerUrl
        || fromCanonicalServerUrl === toCanonicalServerUrl
    ) {
        return null;
    }

    // Until the profile moves, the old canonical URL is the only URL that the
    // identity owner accepts. Write the newly issued credential there; its
    // stable-identity primary key remains valid after the URL changes.
    const credentialWrite = await setHomeCredentialsWithRollbackUnderMutationAuthority(
        authority,
        fromCanonicalServerUrl,
        { serverId: identity },
        input.credentials,
    );
    if (!credentialWrite) throw new Error('Unable to store Home credentials');

    let profile: ServerProfile;
    try {
        if (input.shouldCancel?.()) throw new Error('Home credential adoption cancelled');
        profile = await adoptHomeProfileUnderMutationAuthority(adoption, authority);
    } catch (adoptionError) {
        try {
            const rollbackApplied = await credentialWrite.rollback();
            if (!rollbackApplied) {
                throw new HomeProfileAdoptionPartialCommitError(
                    adoptionError,
                    fromCanonicalServerUrl,
                    identity,
                    { kind: 'not_applied', reason: 'ownership_changed' },
                );
            }
        } catch (rollbackError) {
            if (rollbackError instanceof HomeProfileAdoptionPartialCommitError) throw rollbackError;
            throw new HomeProfileAdoptionPartialCommitError(
                adoptionError,
                fromCanonicalServerUrl,
                identity,
                { kind: 'failed', error: rollbackError },
            );
        }
        throw adoptionError;
    }
    // Revision adjudication may legitimately decline the move. The identity-keyed
    // incumbent credential remains coherent for legacy callers. A caller that
    // supplied a new destination-issued credential must not report success; undo
    // that pre-profile write before surfacing the declined migration.
    if ((profile.canonicalServerUrl ?? profile.serverUrl) !== toCanonicalServerUrl) {
        const declinedMigration = new Error('Home canonical URL migration was not applied');
        try {
            const rollbackApplied = await credentialWrite.rollback();
            if (!rollbackApplied) {
                throw new HomeProfileAdoptionPartialCommitError(
                    declinedMigration,
                    fromCanonicalServerUrl,
                    identity,
                    { kind: 'not_applied', reason: 'ownership_changed' },
                );
            }
        } catch (rollbackError) {
            if (rollbackError instanceof HomeProfileAdoptionPartialCommitError) throw rollbackError;
            throw new HomeProfileAdoptionPartialCommitError(
                declinedMigration,
                fromCanonicalServerUrl,
                identity,
                { kind: 'failed', error: rollbackError },
            );
        }
        throw declinedMigration;
    }

    const destinationCredentials = await getHomeCredentialsUnderMutationAuthority(
        authority,
        toCanonicalServerUrl,
        { serverId: identity },
    );
    if (JSON.stringify(destinationCredentials) !== JSON.stringify(input.credentials)) {
        throw new HomeProfileCanonicalUrlMigrationPartialCommitError(
            'destination_credential_verification',
            identity,
            fromCanonicalServerUrl,
            toCanonicalServerUrl,
            profile,
        );
    }

    // Cleanup targets the obsolete URL scope only. A Home that now occupies that URL
    // owns its own credentials, so the obsolete slot is left to its owner instead.
    const obsoleteUrlReassigned = listServerProfiles().some((candidate) => (
        candidate.id !== profile.id
        && ((candidate.canonicalServerUrl ?? candidate.serverUrl) === fromCanonicalServerUrl
            || candidate.serverUrl === fromCanonicalServerUrl)
    ));
    if (
        !obsoleteUrlReassigned
        && !await removeHomeCredentialsUnderMutationAuthority(authority, fromCanonicalServerUrl)
    ) {
        throw new HomeProfileCanonicalUrlMigrationPartialCommitError(
            'obsolete_credential_cleanup',
            identity,
            fromCanonicalServerUrl,
            toCanonicalServerUrl,
            profile,
        );
    }
    await completeHomeCredentialReplacement(toCanonicalServerUrl, credentialWrite.serverId, credentialWrite.previousToken, input.credentials.token);
    return profile;
}

/**
 * Non-focusing credential adoption composition. The profile owner validates the exact target
 * without mutation, credentials are written under that canonical target, and the same owner
 * revalidates before adopting the profile. A storage failure leaves profile/focus state intact;
 * a later adoption failure rolls back the exact credential write before surfacing that failure.
 */
export async function adoptHomeProfileWithCredentials(
    input: AdoptHomeProfileWithCredentialsInput,
): Promise<ServerProfile> {
    return await withHomeMutationAuthority(
        undefined,
        async (authority) => await adoptHomeProfileWithCredentialsUnderAuthority(input, authority),
    );
}

async function adoptHomeProfileWithCredentialsUnderAuthority(
    input: AdoptHomeProfileWithCredentialsInput,
    authority: HomeMutationAuthority,
): Promise<ServerProfile> {
    const adoption = {
        descriptor: input.descriptor,
        source: input.source,
        ...(input.preserveUserLabel !== undefined
            ? { preserveUserLabel: input.preserveUserLabel }
            : {}),
        ...(input.suggestedName !== undefined ? { suggestedName: input.suggestedName } : {}),
        ...(input.descriptorAuthority !== undefined
            ? { descriptorAuthority: input.descriptorAuthority }
            : {}),
    } satisfies Parameters<typeof preflightHomeProfileAdoption>[0];
    const target = preflightHomeProfileAdoption(adoption);
    if (!target.serverIdentityId) throw new Error('Credentialed Home adoption requires a stable identity');
    if (target.credentialWrite === 'requiresCurrentObservation') {
        throw new HomeProfileAdoptionRequiresCurrentObservationError(
            target.canonicalServerUrl,
            target.serverIdentityId,
        );
    }
    if (input.shouldCancel?.()) throw new Error('Home credential adoption cancelled');
    const migratedProfile = await migrateExistingHomeCanonicalUrlUnderMutationAuthority(
        input,
        adoption,
        target,
        authority,
    );
    if (migratedProfile) return migratedProfile;
    // Advisory discovery never overwrites an established credential. A signed-out
    // established Home still accepts the newly issued credential in its canonical
    // slot, while its established descriptor facts remain unchanged.
    if (target.credentialWrite === 'preserveExisting') {
        const established = await getHomeCredentialsUnderMutationAuthority(
            authority,
            target.canonicalServerUrl,
            { serverId: target.serverIdentityId },
        );
        if (established) {
            if (input.shouldCancel?.()) throw new Error('Home credential adoption cancelled');
            return await adoptHomeProfileUnderMutationAuthority(adoption, authority);
        }
    }
    const credentialWrite = await setHomeCredentialsWithRollbackUnderMutationAuthority(
        authority,
        target.canonicalServerUrl,
        { serverId: target.serverIdentityId },
        input.credentials,
    );
    if (!credentialWrite) {
        throw new Error('Unable to store Home credentials');
    }

    let profile: ServerProfile;
    try {
        if (input.shouldCancel?.()) throw new Error('Home credential adoption cancelled');
        profile = await adoptHomeProfileUnderMutationAuthority(adoption, authority);
    } catch (adoptionError) {
        let rollbackApplied: boolean;
        try {
            rollbackApplied = await credentialWrite.rollback();
        } catch (rollbackError) {
            throw new HomeProfileAdoptionPartialCommitError(
                adoptionError,
                target.canonicalServerUrl,
                target.serverIdentityId,
                { kind: 'failed', error: rollbackError },
            );
        }
        if (!rollbackApplied) {
            throw new HomeProfileAdoptionPartialCommitError(
                adoptionError,
                target.canonicalServerUrl,
                target.serverIdentityId,
                { kind: 'not_applied', reason: 'ownership_changed' },
            );
        }
        throw adoptionError;
    }
    await completeHomeCredentialReplacement(target.canonicalServerUrl, credentialWrite.serverId, credentialWrite.previousToken, input.credentials.token);
    return profile;
}
