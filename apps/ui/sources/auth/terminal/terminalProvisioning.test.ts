vi.mock('@/sync/http/client', () => ({ serverFetch: async () => new Response(JSON.stringify({ mode: 'plain', updatedAt: 1 }), { status: 200 }) }));
import { describe, expect, it, vi } from 'vitest';

import tweetnacl from 'tweetnacl';
import {
    openBoxBundle,
    openTerminalProvisioningV3Payload,
    openTerminalProvisioningV3Response,
    TERMINAL_PROVISIONING_V2_PLAINTEXT_BYTES,
    TERMINAL_PROVISIONING_V2_VERSION_BYTE,
} from '@happier-dev/protocol';

import {
    buildTerminalResponseV1,
    buildTerminalResponseV2,
    buildTerminalResponseV3,
    buildTerminalResponseV3TokenOnly,
    resolveTerminalProvisioningContentPrivateKey,
    decideTerminalProvisioningMode,
} from './terminalProvisioning';
import { encodeBase64 } from '@/encryption/base64';

describe('terminalProvisioning', () => {
    it('pairs token-only credentials without inventing a content key', async () => {
        expect(await resolveTerminalProvisioningContentPrivateKey({ token: 'plain-token' })).toBeNull();
        const secretKey = new Uint8Array(32).fill(3);
        const publicKey = tweetnacl.box.keyPair.fromSecretKey(secretKey).publicKey;
        const pairingSecret = new Uint8Array(32).fill(4);
        const payload = buildTerminalResponseV3TokenOnly({
            terminalEphemeralPublicKey: publicKey, pairingSecret, createdAtMs: 1_000, expiresAtMs: 61_000,
        });
        expect(openTerminalProvisioningV3Response({
            payload, recipientSecretKeyOrSeed: secretKey, terminalEphemeralPublicKey: publicKey,
            pairingSecret, createdAtMs: 1_000, expiresAtMs: 61_000, nowMs: 2_000,
        })).toEqual({ type: 'tokenOnly' });
    });
    it('decides v2 when supported', () => {
        expect(decideTerminalProvisioningMode({ supportsV2: true, allowLegacyFallback: false })).toBe('v2');
    });

    it('decides v1 only when v2 unsupported and fallback enabled', () => {
        expect(decideTerminalProvisioningMode({ supportsV2: false, allowLegacyFallback: true })).toBe('v1');
        expect(decideTerminalProvisioningMode({ supportsV2: false, allowLegacyFallback: false })).toBe('block');
    });

    it('buildTerminalResponseV2 seals version + content private key', () => {
        const terminalSecretKey = new Uint8Array(32).fill(2);
        const terminalPublicKey = tweetnacl.box.keyPair.fromSecretKey(terminalSecretKey).publicKey;
        const contentPrivateKey = new Uint8Array(32).fill(7);

        const sealed = buildTerminalResponseV2({
            contentPrivateKey,
            terminalEphemeralPublicKey: terminalPublicKey,
        });

        const opened = openBoxBundle({ bundle: sealed, recipientSecretKeyOrSeed: terminalSecretKey });
        expect(opened).not.toBeNull();
        expect(opened!.length).toBe(TERMINAL_PROVISIONING_V2_PLAINTEXT_BYTES);
        expect(opened![0]).toBe(TERMINAL_PROVISIONING_V2_VERSION_BYTE);
        expect(Array.from(opened!.slice(1))).toEqual(Array.from(contentPrivateKey));
    });

    it('buildTerminalResponseV1 seals the legacy secret bytes', () => {
        const terminalSecretKey = new Uint8Array(32).fill(3);
        const terminalPublicKey = tweetnacl.box.keyPair.fromSecretKey(terminalSecretKey).publicKey;
        const legacySecretBytes = new Uint8Array(32).fill(9);
        const legacySecretB64Url = encodeBase64(legacySecretBytes, 'base64url');

        const sealed = buildTerminalResponseV1({
            legacySecretB64Url,
            terminalEphemeralPublicKey: terminalPublicKey,
        });

        const opened = openBoxBundle({ bundle: sealed, recipientSecretKeyOrSeed: terminalSecretKey });
        expect(opened).not.toBeNull();
        expect(Array.from(opened!)).toEqual(Array.from(legacySecretBytes));
    });

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

        expect(
            openTerminalProvisioningV3Payload({
                payload,
                recipientSecretKeyOrSeed: terminalSecretKey,
                terminalEphemeralPublicKey: terminalPublicKey,
                pairingSecret,
                createdAtMs: 1_000,
                expiresAtMs: 61_000,
                nowMs: 2_000,
            }),
        ).toEqual(contentPrivateKey);
    });
});
