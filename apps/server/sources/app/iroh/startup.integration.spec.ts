import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod/mini';

import type { Fastify as AppFastify } from '@/app/api/types';
import { enableAuthentication } from '@/app/api/utils/enableAuthentication';
import { registerKeyChallengeAuthRoute } from '@/app/api/routes/auth/registerKeyChallengeAuthRoute';
import { featuresRoutes } from '@/app/api/routes/features/featuresRoutes';
import { registerHomeReachabilityRoutes } from '@/app/api/routes/home/homeReachabilityRoutes';
import { auth } from '@/app/auth/auth';
import { createHomeConnectionDescriptorContinuityStoreForServer } from '@/app/features/homeConnectionDescriptorContinuity';
import { readCommittedHomeConnectionDescriptor, resetHomeConnectionDescriptorRevisionOwnerForTests } from '@/app/features/homeConnectionDescriptorPublication';
import { initializeServerIdentityCache } from '@/app/serverIdentity/serverIdentity';
import { resolveBoundServerListener } from '@/app/runtime/startupReceipt';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { db } from '@/storage/db';
import { classifyRequestIp } from '@/app/net/requestOrigin';
import { shouldDenyPublicSignupProvisioningAction } from '@/app/integrations/publicUrl/publicSignupProvisioningPolicy';
import { resolveMtlsIdentityFromForwardedHeaders } from '@/app/auth/providers/mtls/mtlsIdentity';
import { createApiRateLimitKeyGenerator } from '@/app/api/utils/apiRateLimitPolicy';
import { installHomeIrohIngress } from '@/app/api/irohIngress';
import { registerMtlsAuthRoutes } from '@/app/auth/providers/mtls/registerMtlsAuthRoutes';
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import { HomeReachabilityV1Schema } from '@happier-dev/protocol/home/governance';

import { prepareHomeIrohStartup } from './startup';
import { resetHomeIrohEndpointStateForTests, getHomeIrohEndpointState } from './homeIrohEndpoint';
import type { HomeIrohNativeLifecycle } from './homeIrohNativeLifecycle';

const ENDPOINT_ID = 'a'.repeat(64);
// Only the OS/native carrier is replaced. Startup, policy, descriptor publication,
// HTTP route registration, authentication challenge and SQLite persistence stay real.
const native: HomeIrohNativeLifecycle = {
    createEndpoint: vi.fn(async (request) => {
        await mkdir(dirname(request.keyPath), { recursive: true });
        try { await readFile(request.keyPath); }
        catch (error) {
            if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
            await writeFile(request.keyPath, new Uint8Array(32).fill(7), { mode: 0o600 });
        }
        return { endpointHandle: request.keyPath, endpointId: ENDPOINT_ID, relayMode: 'custom', capProfile: 'homeInteractive', relayUrls: request.relayUrls };
    }),
    startHomeAcceptor: vi.fn(async (request) => ({ endpointHandle: request.endpointHandle, reused: false, status: { running: true } })),
    getEndpointStatus: vi.fn(async () => ({ endpointId: ENDPOINT_ID, directAddresses: ['192.0.2.10:41000'], active: true })),
    stopHomeAcceptor: vi.fn(async () => {}),
    shutdownEndpoint: vi.fn(async () => {}),
};
vi.mock('./homeIrohNativeLifecycle', () => ({ loadHomeIrohNativeLifecycle: () => native }));

// Provenance-pinned old-reader fixture: ui-web-v0.2.19 / ui-web-v0.2.19-preview.25
// at 63829e3cd6a8f1f48b10891af0c8b2313e51ac7e; ../0.2 at c1e74e521fa2e725702ae21b472afe46a9d2d6c6,
// packages/protocol/src/features/payload/featuresResponseSchema.ts. Its z.object
// envelope contains only features/capabilities and drops unknown fields. Nested
// bodies are opaque here: this change only adds the existing descriptor member.
const oldFeaturesEnvelope = z.object({ features: z.unknown(), capabilities: z.unknown() });

describe('Home Iroh startup through real publication, HTTP and persistence', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: 'home-iroh-startup-', initAuth: true, initEncrypt: true,
            env: {
                HAPPIER_CANONICAL_SERVER_URL: 'https://home.example.test',
                HAPPIER_PUBLIC_SERVER_URL: undefined,
                HAPPIER_MANAGED_RELAY_PURPOSE: undefined,
                AUTH_ANONYMOUS_SIGNUP_ENABLED: '0',
                HAPPIER_IROH_RELAY_POLICY: 'automatic',
                HAPPIER_IROH_RELAY_URLS: 'https://relay.example.test',
            },
        });
        await initializeServerIdentityCache(process.env);
    }, 120_000);
    afterEach(async () => {
        await resetHomeIrohEndpointStateForTests();
        resetHomeConnectionDescriptorRevisionOwnerForTests();
        vi.clearAllMocks();
        await db.homeAdministrationEvent.deleteMany();
        await db.homeSettings.deleteMany();
        await db.account.deleteMany();
        harness.resetEnv();
    });
    afterAll(async () => { if (harness) await harness.close(); });

    it.each(['https://ingress.example.test', 'http://happier-agent-qa-unified-work-dev.localhost:3019'])(
        'keeps two redis-streams API replicas HTTPS-only at %s with an honest reachability reason and stable continuity', async (publicServerUrl) => {
        process.env.HAPPIER_PUBLIC_SERVER_URL = publicServerUrl;
        process.env.HAPPIER_SOCKET_ADAPTER = 'redis-streams';
        const owner = await db.account.create({ data: { publicKey: 'iroh-multi-replica-owner', encryptionMode: 'plain', homeRole: 'owner' } });
        const token = await auth.createToken(owner.id, undefined, { kind: 'account', authority: 'present_user', authenticationEvidence: [{ kind: 'home_method', methodId: 'key_challenge' }] });
        let firstDescriptor: unknown;
        let firstContinuity: unknown;
        // Each reset simulates a fresh process; both stores use the same real
        // simpleCache database. A replica-local disabled mode must not retire
        // or replace the shared HTTPS-only descriptor either.
        for (const mode of ['enabled', 'disabled']) {
            process.env.HAPPIER_HOME_IROH_MODE = mode;
            process.env.HAPPIER_SERVER_LIGHT_DATA_DIR = join(harness.baseDir, `replica-${mode}`);
            const env = { ...process.env, HAPPIER_DB_PROVIDER: 'postgres', DATABASE_URL: 'postgresql://fixture.invalid/home' };
            const continuityStore = createHomeConnectionDescriptorContinuityStoreForServer(env);
            if (!continuityStore) throw new Error('Expected shared descriptor continuity');
            const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
            const ingress = installHomeIrohIngress(app);
            app.setValidatorCompiler(validatorCompiler);
            app.setSerializerCompiler(serializerCompiler);
            enableAuthentication(app as AppFastify);
            featuresRoutes(app as AppFastify, { homeConnectionDescriptorContinuityStore: continuityStore });
            registerHomeReachabilityRoutes(app as AppFastify);
            try {
                const compose = prepareHomeIrohStartup(env);
                const origin = await app.listen({ host: '127.0.0.1', port: 0 });
                const ingressPort = await ingress.listen();
                await compose({ listener: resolveBoundServerListener(app), ingressPort, continuityStore });
                const reach = await fetch(`${origin}/v1/home/reachability/get`, {
                    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}',
                });
                expect(reach.status).toBe(200);
                expect(HomeReachabilityV1Schema.parse(await reach.json()).iroh).toMatchObject({
                    availability: 'not_available', state: 'unavailable', endpointId: null,
                    failureReason: 'iroh_multi_instance_unsupported',
                });
                const enable = await fetch(`${origin}/v1/home/reachability/iroh/set`, {
                    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'enabled' }),
                });
                expect(await enable.json()).toMatchObject({ error: 'home_iroh_not_available' });
                for (const path of ['/v1/features', '/v1/features/authenticated']) {
                    const features = await fetch(`${origin}${path}`, {
                        headers: { authorization: `Bearer ${token}` },
                    });
                    expect(features.status).toBe(200);
                    const descriptor = FeaturesResponseSchema.parse(await features.json()).homeConnectionDescriptor;
                    expect(descriptor).toMatchObject({ endpoints: [{ kind: 'https', url: publicServerUrl }] });
                    const continuity = await continuityStore.read();
                    if (firstDescriptor === undefined) {
                        firstDescriptor = descriptor;
                        firstContinuity = continuity;
                    } else {
                        expect(descriptor).toEqual(firstDescriptor);
                        expect(continuity).toEqual(firstContinuity);
                    }
                }
                expect(native.createEndpoint).not.toHaveBeenCalled();
                expect(native.startHomeAcceptor).not.toHaveBeenCalled();
            } finally {
                await app.close();
                await resetHomeIrohEndpointStateForTests();
                resetHomeConnectionDescriptorRevisionOwnerForTests();
            }
        }
    });

    it('classifies native ingress as remote across live policy changes and ignores forged proxy identity', async () => {
        process.env.HAPPIER_SERVER_LIGHT_DATA_DIR = join(harness.baseDir, 'provenance');
        process.env.HAPPIER_FEATURE_AUTH_MTLS__ENABLED = '1';
        process.env.HAPPIER_FEATURE_AUTH_MTLS__MODE = 'forwarded';
        process.env.HAPPIER_FEATURE_AUTH_MTLS__TRUST_FORWARDED_HEADERS = '1';
        process.env.HAPPIER_FEATURE_AUTH_MTLS__IDENTITY_SOURCE = 'san_email';
        process.env.HAPPIER_FEATURE_AUTH_MTLS__FORWARDED_EMAIL_HEADER = 'x-happier-client-cert-email';
        process.env.HAPPIER_FEATURE_AUTH_MTLS__RETURN_TO_ALLOW_PREFIXES = 'happier://';
        process.env.HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED = '1';
        process.env.HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY = 'optional';
        const env = { ...process.env };
        const continuityStore = createHomeConnectionDescriptorContinuityStoreForServer(env);
        const app = Fastify({ logger: false, trustProxy: true }).withTypeProvider<ZodTypeProvider>();
        const ingress = installHomeIrohIngress(app);
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        enableAuthentication(app as AppFastify);
        registerMtlsAuthRoutes(app as AppFastify);
        const rateKey = createApiRateLimitKeyGenerator({}, { strategy: 'ip-only' });
        app.get('/ingress', async (request) => {
            const identityInput = { env: process.env, headers: request.headers, request: request.raw };
            return {
                classification: classifyRequestIp(request.ip),
                denied: shouldDenyPublicSignupProvisioningAction({ env: process.env, requestIp: request.ip, methodId: 'key_challenge', mode: 'keyed' }),
                identity: resolveMtlsIdentityFromForwardedHeaders(identityInput)?.providerUserId ?? null,
                rateKey: await rateKey(request),
            };
        });
        try {
            const origin = await app.listen({ host: '127.0.0.1', port: 0 });
            const listener = resolveBoundServerListener(app);
            const ingressPort = await ingress.listen();
            await prepareHomeIrohStartup(env)({ listener, ingressPort, continuityStore });
            const target = vi.mocked(native.startHomeAcceptor).mock.calls[0]?.[0];
            if (!target) throw new Error('Expected native ingress target');
            const irohOrigin = `http://${target.targetHost}:${target.targetPort}`;
            const headers = { 'x-forwarded-for': '127.0.0.1', 'x-happier-ingress': 'loopback', 'x-happier-client-cert-email': 'alice@example.test' };
            const probe = async (url: string) => await (await fetch(`${url}/ingress`, { headers })).json();
            expect(await probe(irohOrigin)).toMatchObject({ classification: 'public', denied: false, identity: null, rateKey: 'ip:iroh' });
            process.env.HAPPIER_AUTH_PUBLIC_PROVISION_DENY_METHODS = 'key_challenge';
            process.env.HAPPIER_AUTH_PUBLIC_PROVISION_DENY_IP_CLASSES = 'public';
            process.env.HAPPIER_FEATURE_AUTH_MTLS__TRUST_FORWARDED_HEADERS = '1';
            process.env.HAPPIER_FEATURE_AUTH_MTLS__IDENTITY_SOURCE = 'san_email';
            process.env.HAPPIER_FEATURE_AUTH_MTLS__FORWARDED_EMAIL_HEADER = 'x-happier-client-cert-email';
            expect(await probe(irohOrigin)).toMatchObject({ classification: 'public', denied: true, identity: null, rateKey: 'ip:iroh' });
            const login = await fetch(`${irohOrigin}/v1/auth/mtls`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: '{}' });
            expect(login.status).toBe(401);
            expect(await login.json()).toMatchObject({ error: 'mtls-required' });
            const complete = await fetch(`${irohOrigin}/v1/auth/mtls/complete?returnTo=${encodeURIComponent('happier://mtls')}`, { headers });
            expect(complete.status).toBe(401);
            expect(await complete.json()).toMatchObject({ error: 'mtls-required' });
            expect(await db.accountIdentity.count()).toBe(0);
            expect(await probe(origin)).toMatchObject({ classification: 'private', denied: false, identity: 'alice@example.test', rateKey: 'ip:127.0.0.1' });
            delete process.env.HAPPIER_AUTH_PUBLIC_PROVISION_DENY_METHODS;
            expect(await probe(irohOrigin)).toMatchObject({ classification: 'public', denied: false, identity: null });
            expect(target.targetPort).not.toBe(listener?.port);
        } finally { await app.close(); }
    });

    it.each([
        { label: 'full PostgreSQL composition', provider: 'postgres', canonical: 'https://home.example.test', holder: false },
        { label: 'ordinary QA Home', provider: 'sqlite', canonical: 'http://home-qa.localhost:3039', holder: false },
        { label: 'declared redis-streams holder', provider: 'postgres', canonical: 'https://home.example.test', holder: true },
    ])('publishes $label and keeps its sign-in audience through a different HTTP port', async ({ provider, canonical, holder }) => {
        process.env.HAPPIER_CANONICAL_SERVER_URL = canonical;
        if (holder) {
            process.env.HAPPIER_SOCKET_ADAPTER = 'redis-streams';
            process.env.HAPPIER_HOME_IROH_HOLDER = '1';
        }
        // The full-server persistence selector uses the real simpleCache table;
        // a disposable SQLite database supplies that system boundary for this test.
        const env = { ...process.env, HAPPIER_DB_PROVIDER: provider,
            ...(provider === 'postgres' ? { DATABASE_URL: 'postgresql://fixture.invalid/home' } : {}),
        };
        const continuityStore = createHomeConnectionDescriptorContinuityStoreForServer(env);
        if (!continuityStore) throw new Error('Expected durable Home continuity');
        const compose = prepareHomeIrohStartup(env);
        const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
        const ingress = installHomeIrohIngress(app);
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        enableAuthentication(app as AppFastify);
        registerKeyChallengeAuthRoute(app as AppFastify);
        featuresRoutes(app as AppFastify, { homeConnectionDescriptorContinuityStore: continuityStore });
        registerHomeReachabilityRoutes(app as AppFastify);
        try {
            await app.listen({ host: '127.0.0.1', port: 0 });
            const listener = resolveBoundServerListener(app);
            if (!listener) throw new Error('Expected bound API listener');
            const origin = `http://127.0.0.1:${listener.port}`;
            const ingressPort = await ingress.listen();
            await compose({ listener, ingressPort, continuityStore });
            expect(native.startHomeAcceptor).toHaveBeenCalledWith({ endpointHandle: expect.any(String), targetHost: '127.0.0.1', targetPort: ingressPort });
            expect(ingressPort).not.toBe(listener.port);
            const features = await fetch(`${origin}/v1/features`);
            expect(features.status).toBe(200);
            const raw: unknown = await features.json();
            const current = FeaturesResponseSchema.parse(raw);
            expect(current.homeConnectionDescriptor).toMatchObject({ canonicalServerUrl: canonical, endpoints: [{ kind: 'iroh', endpointId: ENDPOINT_ID }] });
            expect(current.homeConnectionDescriptor?.endpoints[0]).not.toHaveProperty('directAddresses');
            const old = oldFeaturesEnvelope.parse(raw);
            expect(old).not.toHaveProperty('homeConnectionDescriptor');
            expect(FeaturesResponseSchema.parse(old).homeConnectionDescriptor).toBeUndefined();

            const challenge = await fetch(`${origin}/v1/auth/challenge`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
            expect(challenge.status).toBe(200);
            expect(await challenge.json()).toMatchObject({ audience: { origin: canonical } });
            expect(canonical).not.toBe(origin);

            const published = await readCommittedHomeConnectionDescriptor({ env, continuityStore });
            await resetHomeIrohEndpointStateForTests();
            resetHomeConnectionDescriptorRevisionOwnerForTests();
            await prepareHomeIrohStartup(env)({ listener, ingressPort, continuityStore });
            expect(await readCommittedHomeConnectionDescriptor({ env, continuityStore })).toEqual(published);
            expect(vi.mocked(native.createEndpoint).mock.calls[1]?.[0].keyPath).toBe(vi.mocked(native.createEndpoint).mock.calls[0]?.[0].keyPath);
            expect(await getHomeIrohEndpointState()).toMatchObject({ status: 'active', snapshot: { endpoint: { endpointId: ENDPOINT_ID } } });

            // Exercise the existing owner transport, not a bare setting write.
            process.env.HAPPIER_PUBLIC_SERVER_URL = 'https://ingress.example.test';
            const owner = await db.account.create({ data: { publicKey: `iroh-opt-out-${provider}`, encryptionMode: 'plain', homeRole: 'owner' } });
            const token = await auth.createToken(owner.id, undefined, { kind: 'account', authority: 'present_user', authenticationEvidence: [{ kind: 'home_method', methodId: 'key_challenge' }] });
            const optOut = await fetch(`${origin}/v1/home/reachability/iroh/set`, {
                method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'disabled' }),
            });
            expect(optOut.status).toBe(200);
            expect(await getHomeIrohEndpointState()).toMatchObject({ status: 'retired', snapshot: null });
            const retired = await readCommittedHomeConnectionDescriptor({ env: { ...env, HAPPIER_PUBLIC_SERVER_URL: process.env.HAPPIER_PUBLIC_SERVER_URL }, continuityStore });
            expect(retired?.endpoints).toEqual([{ kind: 'https', url: 'https://ingress.example.test' }]);
            expect(retired?.revision).toBeGreaterThan(published?.revision ?? 0);
            expect((await db.homeSettings.findUniqueOrThrow({ where: { id: 'home' } })).values).toMatchObject({ HAPPIER_HOME_IROH_MODE: 'disabled' });
            expect((await fetch(`${origin}/v1/auth/challenge`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(200);
        } finally { await app.close(); }
    });
});
