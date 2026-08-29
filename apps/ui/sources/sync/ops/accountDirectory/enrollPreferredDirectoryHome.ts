import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { decryptBox } from '@/encryption/libsodium';
import sodium from '@/encryption/libsodium.lib';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { createAccountDirectoryClient, redeemHomeLoginAssertion } from '@/sync/api/accountDirectory/accountDirectoryClient';
import type { AccountDirectorySession } from '@/sync/domains/accountDirectory/accountDirectorySession';
import { adoptDirectoryHome } from './adoptDirectoryHome';

export type PreferredDirectoryHomeEnrollmentResult =
    | Readonly<{ kind: 'enrolled'; homeServerIdentityId: string }>
    | Readonly<{ kind: 'unavailable'; reason: 'directory_not_ready' | 'no_preferred_home' | 'unsupported' }>
    | Readonly<{ kind: 'failed'; error: unknown }>;

function decodeSealedHomeToken(value: string, privateKey: Uint8Array): string {
    const opened = decryptBox(decodeBase64(value, 'base64url'), privateKey);
    if (!opened) throw new Error('Home enrollment response could not be opened by this device');
    const token = new TextDecoder().decode(opened).trim();
    if (!token) throw new Error('Home enrollment response did not contain a Home token');
    return token;
}

/**
 * Delegated enrollment is Home-token-only and leaves focus/group selection untouched. A Home
 * remains usable after this returns even when its Account Service is later unavailable.
 */
export async function enrollPreferredDirectoryHome(
    session: AccountDirectorySession,
): Promise<PreferredDirectoryHomeEnrollmentResult> {
    const snapshot = session.snapshot;
    if (snapshot.status === 'unsupported') return { kind: 'unavailable', reason: 'unsupported' };
    if (snapshot.status !== 'ready') return { kind: 'unavailable', reason: 'directory_not_ready' };

    const preferredIdentity = snapshot.preferredHomeServerIdentityId
        ?? snapshot.homes.find((entry) => entry.preferred === true)?.homeServerIdentityId
        ?? null;
    if (!preferredIdentity) return { kind: 'unavailable', reason: 'no_preferred_home' };
    const entry = snapshot.homes.find((candidate) => candidate.homeServerIdentityId === preferredIdentity);
    if (!entry) return { kind: 'unavailable', reason: 'no_preferred_home' };

    try {
        const keyPair = sodium.crypto_box_keypair();
        const directoryClient = createAccountDirectoryClient(snapshot.endpoint);
        const assertion = await directoryClient.requestLoginAssertion(entry.homeServerIdentityId, {
            clientBoxPublicKeyBase64: encodeBase64(keyPair.publicKey, 'base64url'),
        });
        if (assertion.audienceHomeServerIdentityId !== entry.homeServerIdentityId) {
            throw new Error('Account Service assertion targeted a different Home');
        }
        const redemption = await redeemHomeLoginAssertion(entry.connectionDescriptor.canonicalServerUrl, assertion);
        if (
            redemption.homeServerIdentityId !== entry.homeServerIdentityId
            || redemption.expiresAtMs <= redemption.issuedAtMs
            || redemption.expiresAtMs <= Date.now()
        ) {
            throw new Error('Invalid Home enrollment response');
        }
        const token = decodeSealedHomeToken(redemption.sealedHomeTokenBase64Url, keyPair.privateKey);
        const profile = await adoptDirectoryHome(entry);
        const stored = await TokenStorage.setCredentialsForServerUrl(profile.serverUrl, { token }, {
            ...(profile.serverIdentityId ? { serverId: profile.serverIdentityId } : {}),
        });
        if (!stored) throw new Error('Unable to store Home credential');
        return { kind: 'enrolled', homeServerIdentityId: entry.homeServerIdentityId };
    } catch (error) {
        return { kind: 'failed', error };
    }
}
