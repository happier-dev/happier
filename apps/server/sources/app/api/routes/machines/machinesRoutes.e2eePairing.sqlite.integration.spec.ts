import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyError, type FastifyReply, type FastifyRequest } from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Socket } from 'socket.io';
import tweetnacl from 'tweetnacl';
import { encodeBase64 } from 'privacy-kit';
import { MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1, computeContentPublicKeyFingerprint, sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol';
import { encodeBase64 as encodeProtocolBase64 } from '@happier-dev/protocol/crypto/base64';
import { signMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { auth } from '@/app/auth/auth';
import { enableAuthentication } from '@/app/api/utils/enableAuthentication';
import { registerApiRoutes } from '@/app/api/api';
import { resolveApiRateLimitPluginOptions } from '@/app/api/utils/apiRateLimitPolicy';
import { enableErrorHandlers } from '@/app/api/utils/enableErrorHandlers';
import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import { encrypt } from '../../../../../../cli/src/api/encryption';
import { createFakeSocket, getSocketHandler } from '../../testkit/socketHarness';
import { machineUpdateHandler } from '../../socket/machineUpdateHandler';
import { VERIFIED_MACHINE_INSTALLATION_ID_SOCKET_DATA_KEY } from '../../socket/machineSocketInstallationProof';

describe('E2EE CLI pairing and retained Machine discovery (real SQLite)', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-m500-pairing-', initAuth: true,
            env: { AUTH_REQUIRED_LOGIN_PROVIDERS: '', AUTH_LOGIN_ELIGIBILITY_CACHE_TTL_MS: '0' } });
    }, 180_000);
    afterAll(async () => { if (harness) await harness.close(); });

    it.each(['resource-envelope', 'legacy-account-key'] as const)('registers, discovers and publishes a %s Machine without access grants or recipient envelopes', async mode => {
        // All key material is generated in this disposable fixture, never read from an Account or daemon file.
        const content = tweetnacl.box.keyPair();
        const binding = createSignedAccountContentBinding(content.publicKey);
        const account = await db.account.create({ data: { ...binding, encryptionMode: 'e2ee' } });
        const dataKey = tweetnacl.randomBytes(32);
        const encryptionVariant = mode === 'resource-envelope' ? 'dataKey' : 'legacy';
        const envelope = mode === 'resource-envelope' ? sealEncryptedDataKeyEnvelopeV1({ dataKey,
            recipientPublicKey: content.publicKey, randomBytes: tweetnacl.randomBytes }) : null;
        const machineId = randomUUID();
        const installationId = randomUUID();
        const installation = tweetnacl.sign.keyPair();
        const contentPublicKeyFingerprint = computeContentPublicKeyFingerprint(binding.contentPublicKey);
        const metadata = encodeBase64(new Uint8Array(encrypt(dataKey, encryptionVariant, { host: 'paired-host', platform: 'linux', happyCliVersion: '0.3.0',
            homeDir: '/home/test', happyHomeDir: '/home/test/.happier' })));
        const daemonState = encodeBase64(new Uint8Array(encrypt(dataKey, encryptionVariant, { status: 'running', pid: 1000, httpPort: 4000 })));
        const token = await auth.createToken(account.id, undefined, { kind: 'account', authority: 'present_user' });
        const headers = { authorization: `Bearer ${token}`, 'x-happier-account-stored-content-protocol': '4' };
        const payload = { id: machineId, metadata, daemonState,
            dataEncryptionKey: envelope ? encodeBase64(new Uint8Array(envelope)) : null,
            contentPublicKey: encodeBase64(binding.contentPublicKey), contentPublicKeySig: encodeBase64(binding.contentPublicKeySig),
            installationId, installationPublicKey: encodeProtocolBase64(installation.publicKey, 'base64url'), contentPublicKeyFingerprint,
            installationProof: signMachineInstallationProof({ payload: { version: 1, installationId, machineId, accountId: account.id, contentPublicKeyFingerprint }, privateKey: installation.secretKey }) };
        const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
        app.register(import('@fastify/rate-limit'), resolveApiRateLimitPluginOptions(process.env));
        app.setValidatorCompiler(validatorCompiler);
        app.setSerializerCompiler(serializerCompiler);
        enableErrorHandlers(app);
        let routeError: Error | undefined;
        app.addHook('onError', async (_request: FastifyRequest, _reply: FastifyReply, error: FastifyError) => { routeError = error; });
        enableAuthentication(app);
        registerApiRoutes(app);
        await app.ready();
        try {
            // Registration is the real pairing/daemon bootstrap POST, followed by the idempotent daemon re-registration.
            for (let attempt = 0; attempt < 2; attempt++) {
                const registered = await app.inject({ method: 'POST', url: '/v1/machines', headers, payload });
                expect(registered.statusCode, routeError?.stack ?? registered.body).toBe(200);
                expect(registered.json()).toMatchObject({ machine: { id: machineId, metadata } });
            }
            expect(await db.machineAccountGrant.count({ where: { machineId } })).toBe(0);
            expect(await db.machineKeyEnvelope.count({ where: { machineId } })).toBe(0);
            // A retained/disconnected Machine must remain discoverable before daemon reactivation.
            // The shared dev Machine also predates a persisted content-key fingerprint.
            // Keep that observed null shape distinct from the current registration payload.
            await db.machine.update({ where: { id: machineId }, data: {
                active: false,
                ...(mode === 'legacy-account-key' ? { contentPublicKeyFingerprint: null } : {}),
            } });
            const list = await app.inject({ method: 'GET', url: '/v1/machines', headers });
            expect(list.statusCode, routeError?.stack ?? list.body).toBe(200);
            expect(list.json()).toContainEqual(expect.objectContaining({ id: machineId, access: expect.objectContaining({ resourceMode: 'e2ee', accessState: 'ready' }) }));
            const detail = await app.inject({ method: 'GET', url: `/v1/machines/${machineId}`, headers });
            expect(detail.statusCode, routeError?.stack ?? detail.body).toBe(200);
            expect(detail.json()).toMatchObject({ machine: { id: machineId, active: false, metadata, daemonState } });
            const reRegistered = await app.inject({ method: 'POST', url: '/v1/machines', headers, payload });
            expect(reRegistered.statusCode, routeError?.stack ?? reRegistered.body).toBe(200);
            expect(reRegistered.json()).toMatchObject({ machine: { id: machineId, metadata, daemonState } });
            const pat = await auth.createApiToken({ accountId: account.id, tokenId: randomUUID(), label: 'Pairing bootstrap' });
            const bootstrap = await app.inject({ method: 'GET', url: '/v1/machines', headers: { ...headers, authorization: `Bearer ${pat.token}` } });
            expect(bootstrap.statusCode, routeError?.stack ?? bootstrap.body).toBe(200);
            expect(bootstrap.json()).toContainEqual(expect.objectContaining({ id: machineId }));

            // The transport fixture begins after installation-proof admission; internal access/update logic and DB remain real.
            const socket = Object.assign(createFakeSocket({ data: { clientType: 'machine-scoped', machineId,
                [VERIFIED_MACHINE_INSTALLATION_ID_SOCKET_DATA_KEY]: installationId } }), { handshake: { auth: { token } } });
            machineUpdateHandler(account.id, socket as unknown as Socket, { operationSocketBatchLimits: {
                ok: true, limits: { maxItems: 200, maxSerializedBytes: 524_288 } } });
            const publish = async (event: string, body: unknown) => {
                const callback = vi.fn();
                await getSocketHandler(socket, event)(body, callback);
                return callback.mock.calls[0]?.[0];
            };
            const updatedState = encodeBase64(new Uint8Array(encrypt(dataKey, encryptionVariant, { status: 'running', pid: 1001, httpPort: 4000 })));
            const paired = await db.machine.findUniqueOrThrow({ where: { id: machineId } });
            expect(await publish('machine-update-state', { machineId, daemonState: updatedState, expectedVersion: paired.daemonStateVersion,
                expectedDataEncryptionKey: payload.dataEncryptionKey })).toMatchObject({ result: 'success', version: paired.daemonStateVersion + 1 });
            expect(await publish('machine-update-metadata', { machineId, metadata, expectedVersion: paired.metadataVersion,
                expectedDataEncryptionKey: payload.dataEncryptionKey })).toMatchObject({ result: 'success', version: paired.metadataVersion + 1 });
            expect(await publish(MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1, { machineId, capabilities: {
                sessionSpawn: { protocolVersions: [1] }, externalActionExecutionAuthorization: { protocolVersions: [1] } } })).toMatchObject({ result: 'success' });
            const persisted = await db.machine.findUniqueOrThrow({ where: { id: machineId } });
            expect(persisted).toMatchObject({ active: true, daemonState: updatedState,
                operationProtocolCapabilities: expect.objectContaining({ externalActionExecutionAuthorization: { protocolVersions: [1] } }) });
        } finally { await app.close(); }
    });
});
