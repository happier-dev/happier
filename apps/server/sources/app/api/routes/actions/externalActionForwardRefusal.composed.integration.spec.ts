import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { Server } from 'socket.io';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { decodeBase64 } from 'privacy-kit';
import tweetnacl from 'tweetnacl';
import { MACHINE_PLAIN_DATA_KEY_MARKER, encodePlainMachineStoredContent } from '@happier-dev/protocol';
import { projectExternalActionMachineRuntimeDemandV1 } from '@happier-dev/protocol/actions/actionSpecs';
import { ExternalActionHttpErrorSchema, sealExternalActionRequestV2, ExternalActionResponseEnvelopeV1Schema } from '@happier-dev/protocol/actions';
import type { Fastify as AppFastify } from '@/app/api/types';
import { enableAuthentication } from '@/app/api/utils/enableAuthentication';
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
    ['plain', 'RPC_METHOD_NOT_AVAILABLE'], ['plain', 'RPC_FORBIDDEN'],
    ['e2ee', 'RPC_METHOD_NOT_AVAILABLE'], ['e2ee', 'RPC_FORBIDDEN'],
    ['plain', 'target_unavailable'], ['e2ee', 'target_unavailable'],
] as const)(
    'retains %s typed daemon transport refusal %s and settles with one forward', async (mode, errorCode) => {
    const account = await db.account.create({ data: { encryptionMode: mode, publicKey: mode === 'plain' ? null : crypto.randomUUID() } });
    const machineId = crypto.randomUUID();
    await db.machine.create({ data: { id: machineId, accountId: account.id,
        metadata: mode === 'e2ee' ? 'opaque' : encodePlainMachineStoredContent({ host: 'refusal', platform: 'linux', happyCliVersion: 'test',
            homeDir: '/home/refusal', happyHomeDir: '/home/refusal/.happier' }),
        dataEncryptionKey: mode === 'plain' ? decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64') : null,
        installationId: 'refusal-installation', installationPublicKey: tweetnacl.sign.keyPair().publicKey,
        active: true, operationProtocolCapabilitiesRevision: 1,
        operationProtocolCapabilities: { externalActionExecutionAuthorization: { protocolVersions: [1] } } } });
    const token = await auth.createToken(account.id, undefined, { kind: 'account', authority: 'present_user' });
    const instance = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>() as unknown as AppFastify;
    instance.setValidatorCompiler(validatorCompiler);
    instance.setSerializerCompiler(serializerCompiler);
    enableAuthentication(instance);
    const failureCause = { phase: 'rpc.forward', errorClass: 'RpcError' as const, errorCode, httpStatus: null };
    // Only daemon RPC transport is substituted; admission, mint, persistence and HTTP projection are real.
    const forwardRpc = vi.fn(async () => ({ ok: false as const, errorCode,
        error: 'PRIVATE_DAEMON_MESSAGE', failureCause }));
    const io = new Server(instance.server);
    registerExternalActionRoutes(instance, { dispatch: createExternalActionDaemonDispatcher({ io, forwardRpc }) });
    const requestId = crypto.randomUUID();
    const input = { serverId: homeId, machineId };
    const payload = mode === 'plain'
        ? { v: 1, requestId, target: { kind: 'machine', machineId }, input }
        : sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1,
            binding: { serverIdentityId: homeId, accountId: account.id,
                authentication: { kind: 'account', tokenEpoch: account.tokenEpoch },
                actionId: 'machines.services.list', requestId, target: { kind: 'machine', machineId } },
            material: { type: 'dataKey', machineKey: new Uint8Array(32).fill(9) }, randomBytes: length => new Uint8Array(length).fill(4), input });
    try {
        const response = await instance.inject({ method: 'POST', url: '/v1/actions/machines.services.list',
            headers: { authorization: `Bearer ${token}` }, payload });
        // In particular FORBIDDEN must settle without another forward.
        expect(forwardRpc, response.body).toHaveBeenCalledTimes(1);
        if (mode === 'plain') {
            expect(response.statusCode, response.body).toBe(200);
            expect(ExternalActionResponseEnvelopeV1Schema.parse(response.json())).toMatchObject({ requestId,
                execution: { ok: false, errorCode, failureCause } });
        } else {
            expect(response.statusCode, response.body).toBe(errorCode === 'target_unavailable' ? 409 : 400);
            expect(ExternalActionHttpErrorSchema.parse(response.json())).toMatchObject({ requestId, code: errorCode, failureCause });
        }
        expect(response.body).not.toContain('PRIVATE_DAEMON_MESSAGE');
    } finally { await io.close(); await instance.close(); }
});
