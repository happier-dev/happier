import {
    AccountEncryptionMaterialUnavailableError,
    createEncryptionFromAuthCredentials,
} from '@/auth/encryption/createEncryptionFromAuthCredentials';
import {
    areCredentialsEqual,
    isDataKeyAuthCredentials,
    isLegacyAuthCredentials,
    subscribeHomeCredentialMutations,
    type AuthCredentials,
} from '@/auth/storage/tokenStorage';
import {
    areServerProfileIdentifiersEquivalent,
    resolveServerProfileScopeIdForIdentifier,
} from '@/sync/domains/server/serverProfiles';
import { canonicalizeServerUrl } from '@/sync/domains/server/url/serverUrlCanonical';
import { parseToken } from '@/utils/auth/parseToken';

import type { Encryption } from './encryption';

type AccountEncryptionOwner = {
    serverId: string;
    serverUrl: string;
    credentials: AuthCredentials;
    material: AuthCredentials;
    encryption: Encryption | null;
    pending: Promise<Encryption>;
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
            && areCredentialsEqual(previous.material, params.credentials)) return await previous.pending;
        retireOwner(previous);
    }
    // The original custody object remains part of the witness: an equal recapture
    // cannot revive an owner after that original object's material was mutated.
    const credentials = params.credentials;
    const material: AuthCredentials | null = isDataKeyAuthCredentials(credentials)
        ? { token: credentials.token, encryption: { ...credentials.encryption } }
        : isLegacyAuthCredentials(credentials)
            ? { token: credentials.token, secret: credentials.secret }
            : null;
    if (!material) return null;
    let owner: AccountEncryptionOwner;
    // Defer construction until its pending owner has been installed, so concurrent
    // acquisitions share initialization as well as completed pure envelope work.
    const pending = Promise.resolve().then(async () => {
        try {
            const encryption = await createEncryptionFromAuthCredentials(material);
            owner.encryption = encryption;
            if (!isOwnerCurrent(owner)) {
                throw new AccountEncryptionMaterialUnavailableError('Captured Account encryption material was retired');
            }
            encryption.configureNativeCryptoWorker({ scope: {
                accountId: parseToken(material.token), serverId, generation: 0,
            } });
            encryption.bindAccountMaterialCurrentness(() => isOwnerCurrent(owner));
            return encryption;
        } catch (error) {
            retireOwner(owner);
            throw error;
        }
    });
    owner = { serverId, serverUrl, credentials, material, encryption: null, pending };
    owners.set(serverId, owner);
    return await pending;
}
