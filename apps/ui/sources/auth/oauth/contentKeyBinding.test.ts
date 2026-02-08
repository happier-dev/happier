import { describe, expect, it, vi } from 'vitest';

vi.mock('@/sync/encryption/encryption', () => ({
    Encryption: {
        create: async () => ({
            contentDataKey: new Uint8Array([1, 2, 3, 4]),
        }),
    },
}));

vi.mock('@/encryption/libsodium.lib', () => ({
    default: {
        crypto_sign_seed_keypair: () => ({
            publicKey: new Uint8Array(32).fill(5),
            privateKey: new Uint8Array(64).fill(6),
        }),
        crypto_sign_detached: () => new Uint8Array(64).fill(7),
    },
}));

describe('buildContentKeyBinding', () => {
    it('returns encoded content key and signature', async () => {
        const { buildContentKeyBinding } = await import('./contentKeyBinding');
        const result = await buildContentKeyBinding(new Uint8Array(32).fill(9));

        expect(typeof result.contentPublicKey).toBe('string');
        expect(typeof result.contentPublicKeySig).toBe('string');
        expect(result.contentPublicKey.length).toBeGreaterThan(0);
        expect(result.contentPublicKeySig.length).toBeGreaterThan(0);
    });
});
