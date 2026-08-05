import {
    createEphemeralTokenGenerator,
    createEphemeralTokenVerifier,
    createPersistentTokenGenerator,
    createPersistentTokenVerifier,
} from '../src/index';

async function verifyPersistentTokenRuntime(): Promise<void> {
    const generator = await createPersistentTokenGenerator({
        service: 'handy',
        seed: 'compat-probe-0',
    });
    const verifier = await createPersistentTokenVerifier({
        service: 'handy',
        publicKey: generator.publicKey,
    });
    const token = await generator.new({ user: 'runtime-user' });
    const verified = await verifier.verify(token);

    if (verified?.user !== 'runtime-user') {
        throw new Error('Persistent token did not round-trip through the runtime');
    }
}

async function verifyEphemeralTokenRuntime(): Promise<void> {
    const generator = await createEphemeralTokenGenerator({
        service: 'happier-oauth-state',
        seed: 'issue227-probe-0',
        ttl: 600_000,
    });
    const verifier = await createEphemeralTokenVerifier({
        service: 'happier-oauth-state',
        publicKey: generator.publicKey,
    });
    const token = await generator.new({ user: 'oauth-state' });
    const verified = await verifier.verify(token);

    if (verified?.user !== 'oauth-state') {
        throw new Error('Ephemeral token did not round-trip through the runtime');
    }
}

await verifyPersistentTokenRuntime();
await verifyEphemeralTokenRuntime();

console.log('Persistent and ephemeral Ed25519 JWK token flows passed');
