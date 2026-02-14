import {
    sealTerminalProvisioningV2Payload,
} from '@happier-dev/protocol';

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

export function buildTerminalResponseV1(params: Readonly<{
    legacySecretB64Url: string;
    terminalEphemeralPublicKey: Uint8Array;
}>): Uint8Array {
    const secretBytes = decodeBase64(params.legacySecretB64Url, 'base64url');
    return new Uint8Array(encryptBox(secretBytes, params.terminalEphemeralPublicKey));
}
