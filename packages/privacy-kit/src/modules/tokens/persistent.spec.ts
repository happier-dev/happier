import { describe, expect, it } from "vitest";
import {
    createPersistentTokenGenerator,
    createPersistentTokenVerifier,
    resolveLegacyBunStandardBase64PersistentTokenPublicKey,
} from "./persistent";

describe('Persistent Token Generator', () => {
    it('should create a token', async () => {
        const generator = await createPersistentTokenGenerator({
            service: 'test',
            seed: 'test'
        });
        const verifier = await createPersistentTokenVerifier({
            service: 'test',
            publicKey: generator.publicKey
        });
        const token = await generator.new({ user: 'some-user-id' });
        const result = await verifier.verify(token);
        expect(result).not.toBeNull();
        expect(result?.user).toBe('some-user-id');
        expect(result?.uuid).not.toBeNull();
    });

    it('should support extras in token', async () => {
        const generator = await createPersistentTokenGenerator({
            service: 'test',
            seed: 'test'
        });
        const verifier = await createPersistentTokenVerifier({
            service: 'test',
            publicKey: generator.publicKey
        });
        const token = await generator.new({
            user: 'some-user-id',
            extras: { role: 'admin', permissions: ['read', 'write'] }
        });
        const result = await verifier.verify(token);
        expect(result).not.toBeNull();
        expect(result?.user).toBe('some-user-id');
        expect(result?.uuid).not.toBeNull();
        expect(result?.extras).toEqual({ role: 'admin', permissions: ['read', 'write'] });
    });

    it('should fail with different service', async () => {
        const generator = await createPersistentTokenGenerator({
            service: 'test1',
            seed: 'test'
        });
        const verifier = await createPersistentTokenVerifier({
            service: 'test2',
            publicKey: generator.publicKey
        });
        const token = await generator.new({ user: 'some-user-id' });
        const result = await verifier.verify(token);
        expect(result).toBeNull();
    });

    it('should fail with different public key', async () => {
        const generator = await createPersistentTokenGenerator({
            service: 'test',
            seed: 'test'
        });
        const otherGenerator = await createPersistentTokenGenerator({
            service: 'test',
            seed: 'another-seed' // Different seed to ensure a different key pair
        });
        const verifier = await createPersistentTokenVerifier({
            service: 'test',
            publicKey: otherGenerator.publicKey // Using a different public key
        });
        const token = await generator.new({ user: 'some-user-id' });
        const result = await verifier.verify(token);
        expect(result).toBeNull();
    });

    it('should fail with invalid token string', async () => {
        const generator = await createPersistentTokenGenerator({
            service: 'test',
            seed: 'test'
        });
        const verifier = await createPersistentTokenVerifier({
            service: 'test',
            publicKey: generator.publicKey
        });
        const result = await verifier.verify('invalid-token-string');
        expect(result).toBeNull();
    });

    it('should handle token without user', async () => {
        const generator = await createPersistentTokenGenerator({
            service: 'test',
            seed: 'test'
        });
        const verifier = await createPersistentTokenVerifier({
            service: 'test',
            publicKey: generator.publicKey
        });
        const token = await generator.new({ extras: { sessionId: 'abc123' } });
        const result = await verifier.verify(token);
        expect(result).not.toBeNull();
        expect(result?.user).toBeNull();
        expect(result?.uuid).not.toBeNull();
        expect(result?.extras).toEqual({ sessionId: 'abc123' });
    });

    it('resolves the first public key accepted by the legacy Bun standard-Base64 private JWK import', async () => {
        const incompatibleSeed = 'legacy-rule-Persistent-0';
        const compatibleSeed = 'legacy-rule-Persistent-21';
        const expectedGenerator = await createPersistentTokenGenerator({
            service: 'handy',
            seed: compatibleSeed,
        });

        const resolved = await resolveLegacyBunStandardBase64PersistentTokenPublicKey({
            service: 'handy',
            seedCandidates: [incompatibleSeed, compatibleSeed],
        });

        expect(resolved).not.toBeNull();
        expect(resolved?.candidateIndex).toBe(1);
        expect(resolved?.publicKey).toEqual(expectedGenerator.publicKey);
    });

    it('returns null when no seed matches the legacy Bun standard-Base64 private JWK import', async () => {
        const resolved = await resolveLegacyBunStandardBase64PersistentTokenPublicKey({
            service: 'handy',
            seedCandidates: ['legacy-rule-Persistent-0'],
        });

        expect(resolved).toBeNull();
    });
});
