import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Server } from 'socket.io';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { decodeBase64 } from 'privacy-kit';
import tweetnacl from 'tweetnacl';
import { MACHINE_PLAIN_DATA_KEY_MARKER, encodePlainMachineStoredContent } from '@happier-dev/protocol';
import { bindExternalActionExecutionAuthorizationHttpPathV1, ExternalActionHttpErrorSchema, ExternalActionResponseEnvelopeV1Schema } from '@happier-dev/protocol/actions';
import type { Fastify as AppFastify } from '@/app/api/types';
import { enableAuthentication } from '@/app/api/utils/enableAuthentication';
import { createExternalActionDaemonDispatcher } from '@/app/api/socket/externalActionDispatcher';
import { auth } from '@/app/auth/auth';
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
])('preserves $reason and its remedy from retained admission through the public Action result ($entry)', async diagnostic => {
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
            expect(body.execution).toMatchObject({ ok: false, errorCode: 'target_unavailable', details });
        }
        expect(forwarded).toBe(diagnostic.entry === 'offline during delivery');
    } finally { await instance.close(); }
});
