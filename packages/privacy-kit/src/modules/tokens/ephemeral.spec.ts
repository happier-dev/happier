import { describe, expect, it } from "vitest";
import { createEphemeralTokenGenerator, createEphemeralTokenVerifier } from "./ephemeral";

describe('Ephemeral Token Generator', () => {
    it('should create a token', async () => {
        const generator = await createEphemeralTokenGenerator({
            service: 'test',
            seed: 'test',
            ttl: 1000
        });
        const verifier = await createEphemeralTokenVerifier({
            service: 'test',
            publicKey: generator.publicKey
        });
        const token = await generator.new({ user: 'some-user-id' });
        const result = await verifier.verify(token);
        expect(result).not.toBeNull();
        expect(result?.user).toBe('some-user-id');
        expect(result?.uuid).not.toBeNull();
    });

    it('should expire after ttl', async () => {
        const generator = await createEphemeralTokenGenerator({
            service: 'test',
            seed: 'test',
            ttl: 1 // 1 millisecond
        });
        const verifier = await createEphemeralTokenVerifier({
            service: 'test',
            publicKey: generator.publicKey
        });
        const token = await generator.new({ user: 'some-user-id' });
        await new Promise(resolve => setTimeout(resolve, 10)); // Wait for token to expire
        const result = await verifier.verify(token);
        expect(result).toBeNull();
    });

    it('should fail with different service', async () => {
        const generator = await createEphemeralTokenGenerator({
            service: 'test1',
            seed: 'test',
            ttl: 1000
        });
        const verifier = await createEphemeralTokenVerifier({
            service: 'test2',
            publicKey: generator.publicKey
        });
        const token = await generator.new({ user: 'some-user-id' });
        const result = await verifier.verify(token);
        expect(result).toBeNull();
    });

    it('should fail with different public key', async () => {
        const generator = await createEphemeralTokenGenerator({
            service: 'test',
            seed: 'test',
            ttl: 1000
        });
        const otherGenerator = await createEphemeralTokenGenerator({
            service: 'test',
            seed: 'another-seed', // Different seed to ensure a different key pair
            ttl: 1000
        });
        const verifier = await createEphemeralTokenVerifier({
            service: 'test',
            publicKey: otherGenerator.publicKey // Using a different public key
        });
        const token = await generator.new({ user: 'some-user-id' });
        const result = await verifier.verify(token);
        expect(result).toBeNull();
    });

    it('should fail with invalid token string', async () => {
        const generator = await createEphemeralTokenGenerator({
            service: 'test',
            seed: 'test',
            ttl: 1000
        });
        const verifier = await createEphemeralTokenVerifier({
            service: 'test',
            publicKey: generator.publicKey
        });
        const result = await verifier.verify('invalid-token-string');
        expect(result).toBeNull();
    });
});