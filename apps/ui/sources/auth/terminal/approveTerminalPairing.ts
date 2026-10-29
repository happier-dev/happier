import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { authApproveWithTransport, type AuthApproveResult } from '@/auth/flows/approve';
import type { HomeEnrollmentTransport } from '@/auth/enrollment/homeEnrollmentTransport';
import { fetchAccountEncryptionCurrentness } from '@/sync/api/account/apiAccountEncryptionMode';
import { isRuntimeFeatureEnabled } from '@/sync/domains/features/featureDecisionInputs';
import type { AccountEncryptionCurrentnessResponse } from '@happier-dev/protocol/account/encryptionMode';
import { encodeBase64 } from '@/encryption/base64';
import { resolveProvisioningMaterial } from './resolveProvisioningMaterial';
import { buildTerminalResponseV3, buildTerminalTokenOnlyResponseV3 } from './terminalProvisioning';

/** Pairing disclosure and issuance read the persisted mode from the exact target Home. */
export async function resolveTerminalPairingCurrentness(params: Readonly<{
    target: HomeEnrollmentTransport;
    targetCredentials: AuthCredentials;
    signal?: AbortSignal;
}>): Promise<AccountEncryptionCurrentnessResponse> {
    const fetchAt = params.target.createRequest({ credentials: null });
    const currentness = await fetchAccountEncryptionCurrentness(params.targetCredentials, {
        ...(params.signal ? { signal: params.signal } : {}),
        request: async (path, init) => await fetchAt(path, { ...init, ...(params.signal ? { signal: params.signal } : {}) }, { includeAuth: false }),
    });
    return currentness;
}

export async function resolveTerminalPairingStorageMode(
    params: Parameters<typeof resolveTerminalPairingCurrentness>[0],
): Promise<'plain' | 'e2ee'> {
    return (await resolveTerminalPairingCurrentness(params)).mode;
}

export async function approveTerminalPairing(params: Readonly<{
    target: HomeEnrollmentTransport;
    requesterPublicKey: Uint8Array;
    pairingContext: Readonly<{ secret: Uint8Array; createdAtMs: number; expiresAtMs: number }>;
    targetCredentials: AuthCredentials;
    supportsTokenOnly: boolean;
    signal?: AbortSignal;
}>): Promise<AuthApproveResult> {
    params.signal?.throwIfAborted();
    const currentness = await resolveTerminalPairingCurrentness(params);
    const material = await resolveProvisioningMaterial(params.targetCredentials, currentness);
    params.signal?.throwIfAborted();
    let sealedResponse: Uint8Array;
    if (material.type === 'tokenOnly') {
        if (!params.supportsTokenOnly) {
            throw new Error('Token-only terminal pairing requires an authenticated compatible reader');
        }
        const [plaintextStorageEnabled, keylessAccountsEnabled] = await Promise.all([
            isRuntimeFeatureEnabled({
                featureId: 'encryption.plaintextStorage',
                scope: { scopeKind: 'spawn' as const, serverId: params.target.homeServerIdentityId },
                force: true,
            }),
            isRuntimeFeatureEnabled({
                featureId: 'e2ee.keylessAccounts',
                scope: { scopeKind: 'spawn' as const, serverId: params.target.homeServerIdentityId },
                force: true,
            }),
        ]);
        if (!plaintextStorageEnabled || !keylessAccountsEnabled) {
            throw new Error('Token-only terminal pairing is not permitted by the target Home policy');
        }
        sealedResponse = buildTerminalTokenOnlyResponseV3({
            terminalEphemeralPublicKey: params.requesterPublicKey,
            pairingSecret: params.pairingContext.secret,
            createdAtMs: params.pairingContext.createdAtMs,
            expiresAtMs: params.pairingContext.expiresAtMs,
        });
    } else {
        sealedResponse = buildTerminalResponseV3({
            contentPrivateKey: material.key,
            terminalEphemeralPublicKey: params.requesterPublicKey,
            pairingSecret: params.pairingContext.secret,
            createdAtMs: params.pairingContext.createdAtMs,
            expiresAtMs: params.pairingContext.expiresAtMs,
        });
    }

    params.signal?.throwIfAborted();
    return await authApproveWithTransport({
        transport: params.target,
        token: params.targetCredentials.token,
        publicKeyBase64: encodeBase64(params.requesterPublicKey),
        responseBase64: encodeBase64(sealedResponse),
        responseKind: material.type,
        signal: params.signal,
    });
}
