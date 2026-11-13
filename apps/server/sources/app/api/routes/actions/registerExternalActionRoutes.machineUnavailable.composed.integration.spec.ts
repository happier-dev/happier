import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Server } from 'socket.io';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { decodeBase64 } from 'privacy-kit';
import tweetnacl from 'tweetnacl';
import { MACHINE_PLAIN_DATA_KEY_MARKER, encodePlainMachineStoredContent } from '@happier-dev/protocol';
import { createExternalActionDaemonDispatchResponseV1, prepareExternalActionResponseEnvelopeV1, bindExternalActionExecutionAuthorizationHttpPathV1, ExternalActionHttpErrorSchema, ExternalActionResponseEnvelopeV1Schema } from '@happier-dev/protocol/actions';
import type { Fastify as AppFastify } from '@/app/api/types';
import { enableAuthentication } from '@/app/api/utils/enableAuthentication';
import { createExternalActionDaemonDispatcher } from '@/app/api/socket/externalActionDispatcher';
import { auth } from '@/app/auth/auth';
import { createAuthenticatedFakeSocket } from '../../testkit/socketHarness';
import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { registerExternalActionRoutes } from './registerExternalActionRoutes';

let harness: LightSqliteHarness;
const homeId = 'srv_machineUnavailableHome';
beforeAll(async () => {
    harness = await createLightSqliteHarness({ tempDirPrefix: 'machine-unavailable-', initAuth: true,
        env: { HAPPIER_SERVER_IDENTITY_ID: homeId, AUTH_REQUIRED_LOGIN_PROVIDERS: '',
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
            HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: 'true' } });
}, 120_000);
afterAll(async () => { if (harness) await harness.close(); });

it.each([
    { entry: 'retained offline', installationId: 'retained-installation', reason: 'machine_offline', requiredFact: 'machine_online', remedy: 'reconnect_machine' },
    { entry: 'retained without installation', installationId: null, reason: 'machine_installation_missing', requiredFact: 'machine_installation', remedy: 'register_machine' },
    { entry: 'offline during delivery', installationId: 'retained-installation', reason: 'machine_offline', requiredFact: 'machine_online', remedy: 'reconnect_machine' },
    { entry: 'authorization mint without installation', installationId: null, reason: 'machine_installation_missing', requiredFact: 'machine_installation', remedy: 'register_machine' },
])('returns a typed refusal for an unavailable Machine ($entry)', async diagnostic => {
    const account = await db.account.create({ data: { encryptionMode: 'plain' } });
    // The retained Machine exists before this Home HTTP ingress is started.
    const machine = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: account.id,
        metadata: encodePlainMachineStoredContent({ host: 'guest', platform: 'linux', happyCliVersion: 'test',
            homeDir: '/home/guest', happyHomeDir: '/home/guest/.happier' }),
        dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64'),
        installationId: diagnostic.installationId, installationPublicKey: tweetnacl.sign.keyPair().publicKey,
        active: diagnostic.entry === 'offline during delivery',
        operationProtocolCapabilitiesRevision: 1,
        operationProtocolCapabilities: { externalActionExecutionAuthorization: { protocolVersions: [1] } } } });
    const token = await auth.createToken(account.id, undefined, { kind: 'account', authority: 'present_user' });
    const instance = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>() as unknown as AppFastify;
    instance.setValidatorCompiler(validatorCompiler);
    instance.setSerializerCompiler(serializerCompiler);
    enableAuthentication(instance);
    let forwarded = false;
    registerExternalActionRoutes(instance, { dispatch: createExternalActionDaemonDispatcher({ io: {} as Server,
        // Genuine daemon transport boundary; all Home policy and storage stay real.
        forwardRpc: async call => {
            forwarded = true;
            await db.machine.update({ where: { id: machine.id }, data: { active: false } });
            if (!call.targetGuard) throw new Error('Daemon transport requires the admitted target guard');
            await call.targetGuard.filterTargets([]);
            return { ok: false, error: 'RPC_METHOD_NOT_AVAILABLE' };
        } }) });
    try {
        const envelope = { v: 1, target: { kind: 'machine', machineId: machine.id },
            input: { serverId: homeId, machineId: machine.id } };
        const mint = diagnostic.entry === 'authorization mint without installation';
        const response = await instance.inject({ method: 'POST',
            url: mint ? bindExternalActionExecutionAuthorizationHttpPathV1('machines.services.list') : '/v1/actions/machines.services.list',
            headers: { authorization: `Bearer ${token}` },
            payload: mint ? { v: 1, machineId: machine.id, envelope } : envelope });
        const details = { reason: diagnostic.reason, requiredFact: diagnostic.requiredFact, remedy: diagnostic.remedy };
        expect(response.statusCode, response.body).toBe(mint ? 409 : 200);
        if (mint) {
            expect(ExternalActionHttpErrorSchema.parse(response.json()))
                .toMatchObject({ code: 'target_unavailable', diagnostic: details });
        } else {
            const body = ExternalActionResponseEnvelopeV1Schema.parse(response.json());
            expect(body.execution, JSON.stringify(body)).toMatchObject({ ok: false, errorCode: 'target_unavailable',
                ...(diagnostic.entry === 'offline during delivery' ? {} : { details }) });
        }
        expect(forwarded).toBe(diagnostic.entry === 'offline during delivery');
    } finally { await instance.close(); }
});


it.each((['action.operations.list', 'action.operations.get', 'action.operations.cancel'] as const)
    .flatMap(actionId => [true, false].map(active => ({ actionId, active }))))(
    'delivers retained $actionId through the exact connected installation with persisted active=$active', async ({ actionId, active }) => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const installationId = crypto.randomUUID();
        const machine = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: account.id,
            metadata: encodePlainMachineStoredContent({ host: 'retained-worker', platform: 'linux' }),
            dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64'),
            installationId, installationPublicKey: tweetnacl.sign.keyPair().publicKey, active,
            operationProtocolCapabilitiesRevision: 1,
            operationProtocolCapabilities: { externalActionExecutionAuthorization: { protocolVersions: [1] } } } });
        const token = await auth.createToken(account.id, undefined, { kind: 'account', authority: 'present_user' });
        const instance = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>() as unknown as AppFastify;
        instance.setValidatorCompiler(validatorCompiler);
        instance.setSerializerCompiler(serializerCompiler);
        enableAuthentication(instance);
        const envelope = { v: 1 as const, requestId: crypto.randomUUID(),
            target: { kind: 'machine' as const, machineId: machine.id },
            input: { serverId: homeId, machineId: machine.id,
                ...(actionId === 'action.operations.list' ? {} : { operationId: crypto.randomUUID() }) } };
        const daemon = createAuthenticatedFakeSocket({ id: 'retained-worker-daemon', data: {
            clientType: 'machine-scoped', userId: account.id, machineId: machine.id,
            verifiedMachineInstallationId: installationId } });
        let effects = 0;
        registerExternalActionRoutes(instance, { dispatch: createExternalActionDaemonDispatcher({ io: {} as Server,
            // The external daemon transport is the only substituted boundary. Home
            // admission, minting and the exact-installation delivery guard stay real.
            forwardRpc: async call => {
                if (!call.targetGuard) throw new Error('Expected exact daemon target guard');
                expect(await call.targetGuard.filterTargets([daemon])).toEqual([daemon]);
                const delivered = await call.targetGuard.runOperation({ target: daemon,
                    readLatestTarget: async () => daemon,
                    operation: async () => {
                        effects++;
                        return { ok: true as const, result: createExternalActionDaemonDispatchResponseV1(
                            prepareExternalActionResponseEnvelopeV1({ v: 1, actionId, requestId: envelope.requestId,
                                execution: { ok: true, result: { accepted: true } } })) };
                    } });
                return delivered.status === 'current' ? delivered.value : { ok: false, error: 'RPC_METHOD_NOT_AVAILABLE' };
            } }) });
        try {
            const response = await instance.inject({ method: 'POST', url: `/v1/actions/${actionId}`,
                headers: { authorization: `Bearer ${token}` }, payload: envelope });
            expect(response.statusCode, response.body).toBe(200);
            expect(ExternalActionResponseEnvelopeV1Schema.parse(response.json()).execution, response.body)
                .toMatchObject({ ok: true, result: { accepted: true } });
            expect(effects).toBe(1);
        } finally { await instance.close(); }
    },
);
