import { describe, expect, it } from 'vitest';

import tweetnacl from 'tweetnacl';
import { openBoxBundle, TERMINAL_PROVISIONING_V2_PLAINTEXT_BYTES, TERMINAL_PROVISIONING_V2_VERSION_BYTE } from '@happier-dev/protocol';

import { buildTerminalResponseV1, buildTerminalResponseV2, decideTerminalProvisioningMode } from './terminalProvisioning';
import { encodeBase64 } from '@/encryption/base64';

describe('terminalProvisioning', () => {
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
});

