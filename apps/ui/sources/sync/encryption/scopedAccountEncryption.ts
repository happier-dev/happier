import {
    AccountEncryptionMaterialUnavailableError,
    createEncryptionFromAuthCredentials,
} from '@/auth/encryption/createEncryptionFromAuthCredentials';
import {
    areCredentialsEqual,
    isDataKeyAuthCredentials,
    isLegacyAuthCredentials,
    readAccountE2eeCustody,
    subscribeHomeCredentialMutations,
    type AuthCredentials,
} from '@/auth/storage/tokenStorage';
import {
    areServerProfileIdentifiersEquivalent,
    getServerProfileById,
    resolveServerProfileScopeIdForIdentifier,
} from '@/sync/domains/server/serverProfiles';
import { canonicalizeServerUrl } from '@/sync/domains/server/url/serverUrlCanonical';
import { parseToken } from '@/utils/auth/parseToken';
import { createCapturedServerReadTransport } from '@/sync/runtime/orchestration/serverScopedRpc/capturedServerReadTransport';
import { bindAccountEncryptionObservation, captureAccountEncryptionObservationForHome,
    matchesAccountEncryptionObservationCredentials } from '@/sync/http/accountEncryptionObservationBinding';
import { resolveCurrentAccountScopedCryptoMaterialSnapshot } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';
import { sameAccountEncryptionIdentity, type AccountEncryptionIdentity } from '@happier-dev/sync-client';

import type { Encryption } from './encryption';

type AccountEncryptionOwner = {
    serverId: string;
    serverUrl: string;
    credentials: AuthCredentials;
    material: AuthCredentials;
    identity: AccountEncryptionIdentity | null;
    encryption: Encryption | null;
    pending: Promise<Encryption | null>;
    identityInvalidated: boolean;
    checkingIdentity: Promise<Encryption | null> | null;
    readIdentity: (() => Promise<AccountEncryptionIdentity>) | null;
    unsubscribeMode: () => void;
};

// Retain the Account's existing Encryption owner, not a second envelope/key cache.
// Every Machine/Session read still admits its own fresh row and access identity.
const owners = new Map<string, AccountEncryptionOwner>();

function isOwnerCurrent(owner: AccountEncryptionOwner): boolean {
    return owners.get(owner.serverId) === owner
        && areCredentialsEqual(owner.material, owner.credentials);
}

function retireOwner(owner: AccountEncryptionOwner): void {
    if (owners.get(owner.serverId) === owner) owners.delete(owner.serverId);
    owner.unsubscribeMode();
    owner.encryption?.retireAccountMaterial();
}

subscribeHomeCredentialMutations(event => {
    for (const owner of owners.values()) {
        if (!areServerProfileIdentifiersEquivalent(owner.serverId, event.serverId)) continue;
        if (event.kind === 'credentials_set' && event.credentials
            && isOwnerCurrent(owner) && areCredentialsEqual(owner.material, event.credentials)) continue;
        retireOwner(owner);
    }
});

/** Read material already admitted for this Home without acquiring another read. */
export function readScopedAccountEncryption(serverId: string): Encryption | null {
    const owner = owners.get(resolveServerProfileScopeIdForIdentifier(serverId));
    return owner && isOwnerCurrent(owner) ? owner.encryption : null;
}

/** One current Account material owner per Home, shared by mounted and finite readers. */
export async function resolveScopedAccountEncryption(params: Readonly<{
    serverId: string;
    serverUrl: string;
    credentials: AuthCredentials;
}>): Promise<Encryption | null> {
    const serverId = resolveServerProfileScopeIdForIdentifier(params.serverId);
    const serverUrl = canonicalizeServerUrl(params.serverUrl);
    const previous = owners.get(serverId);
    if (previous) {
        if (previous.serverUrl === serverUrl && isOwnerCurrent(previous)
            && areCredentialsEqual(previous.material, params.credentials)) {
            if (previous.checkingIdentity) return await previous.checkingIdentity;
            if (!previous.identityInvalidated) return await previous.pending;
            previous.checkingIdentity = previous.pending.then(async encryption => {
                previous.identityInvalidated = false;
                if (!previous.readIdentity) throw new AccountEncryptionMaterialUnavailableError();
                const identity = await previous.readIdentity();
                if (!isOwnerCurrent(previous)) {
                    throw new AccountEncryptionMaterialUnavailableError('Captured Account encryption material was retired');
                }
                if (!previous.identity || !sameAccountEncryptionIdentity(identity, previous.identity)) {
                    retireOwner(previous);
                    return await resolveScopedAccountEncryption(params);
                }
                return encryption;
            }).catch(error => {
                // Failure withdraws this resolve, not already admitted material.
                // A later demand may retry through the same canonical reader.
                previous.identityInvalidated = true;
                throw error;
            }).finally(() => { previous.checkingIdentity = null; });
            return await previous.checkingIdentity;
        }
        retireOwner(previous);
    }
    // The original custody object remains part of the witness: an equal recapture
    // cannot revive an owner after that original object's material was mutated.
    const credentials = params.credentials;
    // Custody is part of the credential witness, so the snapshot carries it too.
    const custody = readAccountE2eeCustody(credentials) === 'historical' ? { custody: 'historical' as const } : {};
    const material: AuthCredentials | null = isDataKeyAuthCredentials(credentials)
        ? { token: credentials.token, encryption: { ...credentials.encryption }, ...custody }
        : isLegacyAuthCredentials(credentials)
            ? { token: credentials.token, secret: credentials.secret, ...custody }
            : null;
    if (!material) return null;
    let owner: AccountEncryptionOwner;
    // Defer construction until its pending owner has been installed, so concurrent
    // acquisitions share initialization as well as completed pure envelope work.
    const pending = Promise.resolve().then(async () => {
        try {
            // Load after owner installation: the canonical identity reader also reaches Sync.
            const { fetchAccountEncryptionIdentity, subscribeAccountEncryptionModeCacheInvalidation } =
                await import('@/sync/api/account/apiAccountEncryptionMode');
            if (!isOwnerCurrent(owner)) {
                throw new AccountEncryptionMaterialUnavailableError('Captured Account encryption material was retired');
            }
            owner.unsubscribeMode = subscribeAccountEncryptionModeCacheInvalidation(event => {
                // Observation withdrawal is not a persisted-identity change. Compare
                // the publisher's admitted value without another identity read.
                if (event.reason === 'transport-withdrawal') return;
                if (event.observation) {
                    if (!matchesAccountEncryptionObservationCredentials(event.observation, owner.material)) return;
                    const identity = event.observation.peek();
                    if (identity && owner.identity) {
                        if (!sameAccountEncryptionIdentity(identity, owner.identity)) retireOwner(owner);
                        else owner.identityInvalidated = false;
                    } else {
                        owner.identityInvalidated = true;
                    }
                    return;
                }
                // A feed/migration invalidation has no admitted identity value.
                // Re-admit on demand; invalidation alone cannot retire material.
                owner.identityInvalidated = true;
            }, serverId);
            owner.readIdentity = async () => {
                // The material can outlive a socket holder. Each demanded identity
                // read captures the current observation for this exact Home.
                const observation = captureAccountEncryptionObservationForHome({ serverId, endpointUrl: serverUrl, credentials: material });
                const transport = createCapturedServerReadTransport({ serverId, credentials: material,
                    profile: getServerProfileById(serverId) ?? { serverUrl }, accountEncryptionObservation: observation });
                const request = bindAccountEncryptionObservation((path: string, init?: RequestInit) =>
                    transport.read(path, init, { includeAuth: false, retry: 'none' }, async response =>
                        new Response(await response.arrayBuffer(), { status: response.status,
                            statusText: response.statusText, headers: response.headers })), observation);
                return await fetchAccountEncryptionIdentity(material, { request, usage: 'identity' });
            };
            const identity = await owner.readIdentity();
            if (!isOwnerCurrent(owner)) {
                throw new AccountEncryptionMaterialUnavailableError('Captured Account encryption material was retired');
            }
            owner.identity = identity;
            if (identity.mode === 'plain') return null;
            if (!resolveCurrentAccountScopedCryptoMaterialSnapshot({ credentials: material, accountCurrentness: identity })) {
                throw new AccountEncryptionMaterialUnavailableError('Account material does not match the persisted key binding');
            }
            const encryption = await createEncryptionFromAuthCredentials(material);
            if (!isOwnerCurrent(owner)) {
                encryption.retireAccountMaterial();
                throw new AccountEncryptionMaterialUnavailableError('Captured Account encryption material was retired');
            }
            encryption.configureNativeCryptoWorker({ scope: {
                accountId: parseToken(material.token), serverId, generation: 0,
            } });
            encryption.bindAccountMaterialCurrentness(() => isOwnerCurrent(owner) && owner.identity?.mode === 'e2ee');
            owner.encryption = encryption;
            return encryption;
        } catch (error) {
            // No material has been published by a failed initialization. Drop
            // only that unopened slot so the next resolve can try again.
            if (owners.get(owner.serverId) === owner) owners.delete(owner.serverId);
            owner.unsubscribeMode();
            throw error;
        }
    });
    owner = { serverId, serverUrl, credentials, material, identity: null, encryption: null, pending,
        identityInvalidated: false, checkingIdentity: null, readIdentity: null, unsubscribeMode: () => {} };
    owners.set(serverId, owner);
    return await pending;
}
