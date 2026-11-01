import { assertCurrentAccountKeyForProvisioning } from '@/auth/flows/assertCurrentAccountKeyForProvisioning';
import {
    deriveAccountMachineKeyFromRecoverySecret,
    sealTerminalProvisioningV3Payload,
    sealTerminalProvisioningV2Payload,
    sealTerminalProvisioningV2TokenOnlyPayload,
    sealTerminalProvisioningV3TokenOnlyPayload,
} from '@happier-dev/protocol';

import { isLegacyAuthCredentials, isTokenOnlyAuthCredentials, type AuthCredentials } from '@/auth/storage/tokenStorage';
import { decodeBase64 } from '@/encryption/base64';
import { encryptBox } from '@/encryption/libsodium';
import { getRandomBytes } from '@/platform/cryptoRandom';

export type TerminalProvisioningMode = 'v2' | 'v1' | 'block';

export function decideTerminalProvisioningMode(params: Readonly<{
    supportsV2: boolean;
    allowLegacyFallback: boolean;
}>): TerminalProvisioningMode {
    if (params.supportsV2) return 'v2';
    if (params.allowLegacyFallback) return 'v1';
    return 'block';
}

/**
 * The account content private key a terminal provisioning response seals: the data-key machine
 * key when the credentials carry one, derived from the legacy recovery secret, or absent for
 * token-only credentials.
 *
 * Shared by the manual terminal-connect flow and the desktop setup auto-approval so both seal the
 * same material; a second derivation would be a second place to get a key length wrong.
 */
export async function resolveTerminalProvisioningContentPrivateKey(
    credentials: AuthCredentials,
    options: Readonly<{ endpointUrl?: string }> = {},
): Promise<Uint8Array | null> {
    await assertCurrentAccountKeyForProvisioning(credentials, options);
    if (isTokenOnlyAuthCredentials(credentials)) return null;
    if (!isLegacyAuthCredentials(credentials)) {
        const machineKey = decodeBase64(credentials.encryption.machineKey, 'base64');
        if (machineKey.length !== 32) {
            throw new Error('Invalid dataKey credential key lengths');
        }
        return machineKey;
    }

    const secretKey = decodeBase64(credentials.secret, 'base64url');
    if (secretKey.length !== 32) {
        throw new Error(`Invalid secret key length: ${secretKey.length}, expected 32`);
    }
    return deriveAccountMachineKeyFromRecoverySecret(secretKey);
}

export function buildTerminalResponseV2(params: Readonly<{
    contentPrivateKey: Uint8Array;
    terminalEphemeralPublicKey: Uint8Array;
}>): Uint8Array {
    return sealTerminalProvisioningV2Payload({
        contentPrivateKey: params.contentPrivateKey,
        recipientPublicKey: params.terminalEphemeralPublicKey,
        randomBytes: getRandomBytes,
    });
}

export function buildTerminalResponseV3(params: Readonly<{
    contentPrivateKey: Uint8Array;
    terminalEphemeralPublicKey: Uint8Array;
    pairingSecret: Uint8Array;
    createdAtMs: number;
    expiresAtMs: number;
}>): Uint8Array {
    return sealTerminalProvisioningV3Payload({
        ...params,
        randomBytes: getRandomBytes,
    });
}

export function buildTerminalResponseV2TokenOnly(params: Readonly<{
    terminalEphemeralPublicKey: Uint8Array;
}>): Uint8Array {
    return sealTerminalProvisioningV2TokenOnlyPayload({
        recipientPublicKey: params.terminalEphemeralPublicKey,
        randomBytes: getRandomBytes,
    });
}

export function buildTerminalResponseV3TokenOnly(params: Readonly<{
    terminalEphemeralPublicKey: Uint8Array;
    pairingSecret: Uint8Array;
    createdAtMs: number;
    expiresAtMs: number;
}>): Uint8Array {
    return sealTerminalProvisioningV3TokenOnlyPayload({ ...params, randomBytes: getRandomBytes });
}

export function buildTerminalResponseV1(params: Readonly<{
    legacySecretB64Url: string;
    terminalEphemeralPublicKey: Uint8Array;
}>): Uint8Array {
    const secretBytes = decodeBase64(params.legacySecretB64Url, 'base64url');
    return new Uint8Array(encryptBox(secretBytes, params.terminalEphemeralPublicKey));
}
