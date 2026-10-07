import {
    sealTerminalProvisioningV3TokenOnlyPayload,
    sealTerminalProvisioningV3Payload,
} from '@happier-dev/protocol/crypto/terminalProvisioningV2';

import { getRandomBytes } from '@/platform/cryptoRandom';

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

export function buildTerminalTokenOnlyResponseV3(params: Readonly<{
    terminalEphemeralPublicKey: Uint8Array;
    pairingSecret: Uint8Array;
    createdAtMs: number;
    expiresAtMs: number;
}>): Uint8Array {
    return sealTerminalProvisioningV3TokenOnlyPayload({
        ...params,
        randomBytes: getRandomBytes,
    });
}
