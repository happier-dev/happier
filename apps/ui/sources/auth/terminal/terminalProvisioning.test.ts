import { describe, expect, it } from 'vitest';

import tweetnacl from 'tweetnacl';
import { openTerminalProvisioningV3Payload } from '@happier-dev/protocol/crypto/terminalProvisioningV2';

import { buildTerminalResponseV3 } from './terminalProvisioning';

describe('terminalProvisioning', () => {
    it('buildTerminalResponseV3 authenticates the response with the QR-only secret', () => {
        const terminalSecretKey = new Uint8Array(32).fill(2);
        const terminalPublicKey = tweetnacl.box.keyPair.fromSecretKey(terminalSecretKey).publicKey;
        const contentPrivateKey = new Uint8Array(32).fill(7);
        const pairingSecret = new Uint8Array(32).fill(11);

        const payload = buildTerminalResponseV3({
            contentPrivateKey,
            terminalEphemeralPublicKey: terminalPublicKey,
            pairingSecret,
            createdAtMs: 1_000,
            expiresAtMs: 61_000,
        });

        expect(openTerminalProvisioningV3Payload({
            payload,
            recipientSecretKeyOrSeed: terminalSecretKey,
            terminalEphemeralPublicKey: terminalPublicKey,
            pairingSecret,
            createdAtMs: 1_000,
            expiresAtMs: 61_000,
            nowMs: 2_000,
        })).toEqual(contentPrivateKey);
    });
});
