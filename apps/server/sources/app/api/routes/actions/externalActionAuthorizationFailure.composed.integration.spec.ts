import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Server } from 'socket.io';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { decodeBase64 } from 'privacy-kit';
import tweetnacl from 'tweetnacl';
import { MACHINE_PLAIN_DATA_KEY_MARKER, encodePlainMachineStoredContent } from '@happier-dev/protocol';
import { ExternalActionResponseEnvelopeV1Schema } from '@happier-dev/protocol/actions';
import { ExternalActionHttpErrorSchema } from '@happier-dev/protocol/actions/externalActionHttpError';
import type { Fastify as AppFastify } from '@/app/api/types';
import { enableAuthentication } from '@/app/api/utils/enableAuthentication';
import { createSocketRoomDiscoveryHarness } from '@/app/api/testkit/socketHarness';
import { createExternalActionDaemonDispatcher } from '@/app/api/socket/externalActionDispatcher';
import { auth } from '@/app/auth/auth';
import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { registerExternalActionRoutes } from './registerExternalActionRoutes';

let harness: LightSqliteHarness;
const homeId = 'srv_authorizationFailureHome';
beforeAll(async () => {
    harness = await createLightSqliteHarness({ tempDirPrefix: 'authorization-failure-', initAuth: true,
        env: { HAPPIER_SERVER_IDENTITY_ID: homeId, AUTH_REQUIRED_LOGIN_PROVIDERS: '',
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
            HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: 'true' } });
}, 120_000);
afterAll(async () => { if (harness) await harness.close(); });

it.each([
    ['invalid_token', 400, { error: 'invalid_request', code: 'invalid_token' }],
    ['credential_scope_denied', 400, { error: 'invalid_request', code: 'credential_scope_denied' }],
    ['invalid_envelope', 400, { error: 'invalid_request', code: 'invalid_envelope' }],
] as const)('keeps a daemon %s refusal separate from the requester credential', async (errorCode, status, payload) => {
    const account = await db.account.create({ data: { encryptionMode: 'plain' } });
    const machine = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: account.id,
        metadata: encodePlainMachineStoredContent({ host: 'guest', platform: 'linux', happyCliVersion: 'test',
            homeDir: '/home/guest', happyHomeDir: '/home/guest/.happier' }),
        dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64'),
        installationId: 'daemon-refusal-installation', installationPublicKey: tweetnacl.sign.keyPair().publicKey,
        active: true, operationProtocolCapabilitiesRevision: 1,
        operationProtocolCapabilities: { externalActionExecutionAuthorization: { protocolVersions: [1] } } } });
    const token = await auth.createToken(account.id, undefined, { kind: 'account', authority: 'present_user' });
    const instance = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>() as unknown as AppFastify;
    instance.setValidatorCompiler(validatorCompiler);
    instance.setSerializerCompiler(serializerCompiler);
    enableAuthentication(instance);
    let forwarded = false;
    registerExternalActionRoutes(instance, { dispatch: createExternalActionDaemonDispatcher({
        io: createSocketRoomDiscoveryHarness(async () => []),
        // Only the daemon transport is substituted; Home bearer admission,
        // authorization minting, relay parsing and HTTP projection stay real.
        forwardRpc: async () => { forwarded = true; return { ok: true,
            result: { kind: 'invalid_request', errorCode } }; },
    }) });
    const request = { method: 'POST' as const, url: '/v1/actions/machines.services.list',
        payload: { v: 1, target: { kind: 'machine', machineId: machine.id },
            input: { serverId: homeId, machineId: machine.id } } };
    try {
        const response = await instance.inject({ ...request, headers: { authorization: `Bearer ${token}` } });
        expect(forwarded).toBe(true);
        expect(response.statusCode, response.body).toBe(status);
        expect(ExternalActionHttpErrorSchema.parse(response.json())).toEqual(payload);
        // Only an actually rejected requester credential may produce 401.
        forwarded = false;
        const rejected = await instance.inject({ ...request, headers: { authorization: 'Bearer invalid-requester-token' } });
        expect(rejected.statusCode).toBe(401);
        expect(forwarded).toBe(false);
    } finally { await instance.close(); }
});

it('retains an execution authorization exception as an unadmitted failure without inventing machine unavailability', async () => {
    const account = await db.account.create({ data: { encryptionMode: 'plain' } });
    const machine = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: account.id,
        metadata: encodePlainMachineStoredContent({ host: 'guest', platform: 'linux', happyCliVersion: 'test',
            homeDir: '/home/guest', happyHomeDir: '/home/guest/.happier' }),
        dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64'),
        installationId: 'authorization-exception-installation', installationPublicKey: tweetnacl.sign.keyPair().publicKey,
        active: true, operationProtocolCapabilitiesRevision: 1,
        operationProtocolCapabilities: { externalActionExecutionAuthorization: { protocolVersions: [1] } } } });
    const token = await auth.createToken(account.id, undefined, { kind: 'account', authority: 'present_user' });
    const instance = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>() as unknown as AppFastify;
    instance.setValidatorCompiler(validatorCompiler);
    instance.setSerializerCompiler(serializerCompiler);
    enableAuthentication(instance);
    let forwarded = false;
    registerExternalActionRoutes(instance, { dispatch: createExternalActionDaemonDispatcher({ io: {} as Server,
        forwardRpc: async () => { forwarded = true; return { ok: false, error: 'RPC_METHOD_NOT_AVAILABLE' }; } }) });
    // Genuine persistence boundary: the default Home mint reads Machine custody here.
    // Admission uses its real transaction delegate; no authorization logic is replaced.
    const findMachine = db.machine.findUnique.bind(db.machine);
    const custodyRead = vi.spyOn(db.machine, 'findUnique').mockImplementation(args => {
        if (args.select?.accountId && args.select.installationId && Object.keys(args.select).length === 2) {
            throw new Error('PRIVATE_MINT_CAUSE');
        }
        return findMachine(args);
    });
    try {
        const response = await instance.inject({ method: 'POST', url: '/v1/actions/machines.services.list',
            headers: { authorization: `Bearer ${token}` }, payload: { v: 1,
                target: { kind: 'machine', machineId: machine.id }, input: { serverId: homeId, machineId: machine.id } } });
        expect(response.statusCode, response.body).toBe(200);
        expect(ExternalActionResponseEnvelopeV1Schema.parse(response.json()).execution).toMatchObject({
            ok: false, errorCode: 'action_not_admitted', failureCause: {
                phase: 'execution_authorization', errorClass: 'Error', errorCode: null, httpStatus: null,
            },
        });
        expect(response.body).not.toMatch(/PRIVATE_MINT_CAUSE|machine_offline|reconnect_machine|target_unavailable/);
        expect(forwarded).toBe(false);
    } finally { custodyRead.mockRestore(); await instance.close(); }
});
