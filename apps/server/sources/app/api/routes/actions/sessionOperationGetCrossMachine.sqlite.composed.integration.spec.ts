import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import type { Socket } from 'socket.io';
import nacl from 'tweetnacl';
import { decodeBase64 } from 'privacy-kit';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { buildAccountStoredContentCompatibilitySocketAuthV1, CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
    encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol';
import { ACTION_OPERATION_GET_ACTION_ID_V1, ACTION_OPERATION_LIST_ACTION_ID_V1 } from '@happier-dev/protocol/actions/operations/actionIdsV1';
import { ACTION_OPERATION_RPC_METHODS_V2 } from '@happier-dev/protocol/actions/operations/methodsV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SessionActionRpcOriginV1Schema, SOCKET_RPC_EVENTS, type SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import { sealExternalActionRequesterAccountContextV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';

import { createExternalActionDaemonDispatcher, resolveCurrentSessionMachineFromServer } from '@/app/api/socket/externalActionDispatcher';
import { registerSocketRpcHandlers } from '@/app/api/socket/rpc/registerSocketRpcHandlers';
import { createAuthenticatedFakeSocket, createSocketRoomDiscoveryHarness, triggerSocketHandler } from '@/app/api/testkit/socketHarness';
import type { Fastify as AppFastify } from '@/app/api/types';
import { enableAuthentication } from '@/app/api/utils/enableAuthentication';
import { auth } from '@/app/auth/auth';
import { evaluateAccountStoredContentSocketCompatibility } from '@/app/clientCompatibility/accountStoredContentCompatibility';
import { createSessionPublisherPresence } from '@/app/presence/sessionPublisherPresence';
import { getOrCreateServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createExternalActionSourceMachineRpcExecution,
    prepareExternalActionRequesterAccountAuthorizationResult } from '../../../../../../cli/src/api/externalActionExecutionAuthorization';
import { createHostActionOperationRuntime } from '../../../../../../cli/src/daemon/actionOperations/createHostActionOperationRuntime';
import { installAxiosFastifyAdapter } from '../../../../../../cli/src/testkit/http/axiosAdapter';
import { registerExternalActionRoutes } from './registerExternalActionRoutes';

let harness: LightSqliteHarness;
beforeAll(async () => {
    harness = await createLightSqliteHarness({ tempDirPrefix: 'session-operation-get-', initAuth: true, initEncrypt: true,
        env: { AUTH_REQUIRED_LOGIN_PROVIDERS: '', HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
            HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: 'true' } });
}, 120_000);
afterAll(async () => { await harness?.close(); });

async function createInstalledAccount() {
    const account = await db.account.create({ data: { encryptionMode: 'plain' } });
    const keys = nacl.sign.keyPair();
    const machine = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: account.id, active: true,
        metadata: encodePlainMachineStoredContent({ host: 'test', platform: 'linux', happyCliVersion: 'test',
            homeDir: '/home/test', happyHomeDir: '/home/test/.happier' }),
        dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER),
        installationId: crypto.randomUUID(), installationPublicKey: new Uint8Array(keys.publicKey),
        operationProtocolCapabilitiesRevision: 1,
        operationProtocolCapabilities: { externalActionExecutionAuthorization: { protocolVersions: [1] } },
    } });
    return { account, keys, machineId: machine.id, installationId: machine.installationId! };
}

it('lets an installed Team Session read its requester’s accepted operation on another Machine', async () => {
    const homeId = await getOrCreateServerIdentityId();
    const serverHttpBaseUrl = 'http://session-operation-get.test';
    const owner = await createInstalledAccount();
    const member = await createInstalledAccount();
    const peer = await createInstalledAccount();
    const outsider = await createInstalledAccount();
    const { machineId, installationId } = owner;
    const team = await db.team.create({ data: { name: 'Session operation readers' } });
    await db.teamMembership.createMany({ data: [member, peer].map(person => ({
        teamId: team.id, accountId: person.account.id, role: 'member',
    })) });
    const grant = await db.machineGrant.create({ data: { principalKind: 'team', teamId: team.id,
        machineId, accessLevel: 'admin', createdByAccountId: owner.account.id } });

    const presence = createSessionPublisherPresence();
    const publisherRooms = new Map<string, ReturnType<typeof createAuthenticatedFakeSocket>>();
    const createSession = async (person: typeof member) => {
        const session = await db.session.create({ data: { accountId: person.account.id, tag: crypto.randomUUID(),
            metadata: JSON.stringify({ t: 'plain', v: {} }), encryptionMode: 'plain' } });
        await db.accessKey.create({ data: { accountId: person.account.id, machineId: person.machineId,
            sessionId: session.id, data: 'opaque-session-key' } });
        const publisher = createAuthenticatedFakeSocket({ id: session.id,
            data: { clientType: 'session-scoped', userId: person.account.id, machineId: person.machineId, sessionId: session.id } });
        expect(await presence.registerPublisher({ socket: publisher,
            binding: { accountId: person.account.id, machineId: person.machineId, sessionId: session.id },
            completeActivitySnapshot: { state: 'active', activeCount: 1 } })).toMatchObject({ status: 'registered' });
        publisherRooms.set(`session:${session.id}:${person.account.id}`, publisher);
        return session.id;
    };
    const sessionId = await createSession(member);
    const secondSessionId = await createSession(member);
    const peerSessionId = await createSession(peer);
    const outsiderSessionId = await createSession(outsider);

    const compatibility = evaluateAccountStoredContentSocketCompatibility(
        buildAccountStoredContentCompatibilitySocketAuthV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION)).evaluation;
    const target = { kind: 'machine' as const, machineId };
    const address = { serverId: homeId, machineId };
    const operations = createHostActionOperationRuntime({ machineId, custodyBinding: { serverId: homeId, installationId },
        resolveAccountId: async () => owner.account.id });
    const startAction = 'machines.reachability.inspect';
    const startMethod = RPC_METHODS.MACHINES_REACHABILITY_INSPECT;
    const getMethod = ACTION_OPERATION_RPC_METHODS_V2.get;
    let operationId: string | undefined;
    // Socket.IO is the transport boundary. Both the host operation and Home's routing use their real owners.
    const receiver = createAuthenticatedFakeSocket({ id: 'operation-target-machine', data: {
        clientType: 'machine-scoped', userId: owner.account.id, machineId,
        verifiedMachineInstallationId: installationId, accountStoredContentCompatibility: compatibility,
    }, timeout: () => ({ emitWithAck: async (_event: string, packet: SocketRpcRequestPayload) => {
        const rpcContext = { machineAdmission: packet.machineAdmission, sessionActionOrigin: packet.sessionActionOrigin };
        if (packet.method === `${machineId}:${startMethod}`) {
            return operations.observeExecution({ actionId: startAction, input: address, rpcContext,
                sessionId: packet.sessionActionOrigin?.caller.sessionId, actionRequestId: packet.requestId, response: 'terminal',
                execute: async () => ({ ok: true, result: {} }),
                onOperation: operation => { operationId = operation.operationId; } });
        }
        expect(packet.method).toBe(`${machineId}:${getMethod}`);
        return operations.handlers.getV2(packet.params, rpcContext);
    } }) });
    const io = createSocketRoomDiscoveryHarness(async room => {
        const publisher = publisherRooms.get(room);
        if (publisher) return [publisher];
        return room === receiver.id || [startMethod, getMethod].some(method => room === `rpc:${owner.account.id}:${machineId}:${method}`)
            ? [receiver] : [];
    });
    const connect = async (person: typeof member, kind: 'account' | 'terminal') => {
        const authority = kind === 'account' ? 'present_user' : 'account_automation';
        const token = await auth.createToken(person.account.id, undefined, { kind, authority });
        const caller = Object.assign(createAuthenticatedFakeSocket({ id: `operation-reader-${person.account.id}`, data: {
            clientType: 'user-scoped', userId: person.account.id, authTokenKind: kind,
            authAuthority: authority, tokenEpoch: person.account.tokenEpoch, accountStoredContentCompatibility: compatibility,
        } }), { handshake: { auth: { token } } });
        registerSocketRpcHandlers({ userId: person.account.id, socket: caller as unknown as Socket, io, sessionPublisherPresence: presence });
        return { ...person, token, caller };
    };
    const requester = await connect(member, 'terminal');
    const teammate = await connect(peer, 'terminal');
    const ungranted = await connect(outsider, 'terminal');
    const custodian = await connect(owner, 'account');

    const app = Fastify({ logger: false }) as unknown as AppFastify;
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    enableAuthentication(app);
    app.resolveCurrentSessionMachine = request => resolveCurrentSessionMachineFromServer({ io, presence, ...request });
    registerExternalActionRoutes(app, { dispatch: createExternalActionDaemonDispatcher({ io, sessionPublisherPresence: presence }) });
    const restoreHttp = installAxiosFastifyAdapter({ app, origin: serverHttpBaseUrl });

    const mint = (source: typeof requester, sourceSessionId: string, actionId: string, input: object) => {
        const requestId = crypto.randomUUID();
        const sessionActionOrigin = SessionActionRpcOriginV1Schema.parse({ v: 1,
            caller: { kind: 'session', sessionId: sourceSessionId, starterDepth: 0, turnDepth: 1 },
            sourceTurnId: 'reachability-turn', callerPermissionMode: 'read-only', requestId,
            causalPermissionAuthority: { kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'read-only' } });
        return prepareExternalActionRequesterAccountAuthorizationResult({
            actionId, input, requestId, target, machineId, sourceMachineId: source.machineId,
            accountId: source.account.id, tokenEpochHint: source.account.tokenEpoch, accountEncryptionMode: 'plain',
            token: source.token, sessionActionOrigin, serverId: homeId, serverIdentityId: homeId, serverHttpBaseUrl,
            installationId: source.installationId, privateKey: source.keys.secretKey,
        });
    };
    const call = async (source: typeof requester, request: object) => {
        const callback = vi.fn();
        await triggerSocketHandler(source.caller, SOCKET_RPC_EVENTS.CALL, request, callback);
        return callback.mock.calls[0]?.[0] as unknown;
    };
    const invoke = async (source: typeof requester, prepared: Awaited<ReturnType<typeof mint>>, methodName: string, params: unknown) => {
        if (!('authorization' in prepared)) return prepared;
        const authorization = sealExternalActionRequesterAccountContextV1({ authorization: prepared.authorization,
            credentials: { token: source.token }, purpose: { kind: 'machine_rpc', method: methodName, params },
            installationPublicKey: owner.keys.publicKey, randomBytes: nacl.randomBytes });
        const method = `${machineId}:${methodName}`;
        const { actionId, requestId } = authorization.binding;
        const execution = createExternalActionSourceMachineRpcExecution({ authorization, effectActionId: actionId, target,
            sourceMachineId: source.machineId, sourceInstallationId: source.installationId, method, requestId, params,
            privateKey: source.keys.secretKey });
        if (!execution) throw new Error('Missing signed Session RPC');
        return call(source, { method, requestId, params, externalActionExecution: execution });
    };
    const expectMintRefusal = (result: Awaited<ReturnType<typeof mint>>) => {
        expect('authorization' in result ? { admitted: true } : result).toMatchObject({
            ok: false, phase: 'mint', code: 'target_unavailable',
            failureCause: { phase: 'session.authorization.mint', httpStatus: 409, errorCode: 'target_unavailable' },
        });
    };

    try {
        expect(await invoke(requester, await mint(requester, sessionId, startAction, address), startMethod, address))
            .toMatchObject({ ok: true });
        if (!operationId) throw new Error('No accepted reachability operation');
        const acceptedOperationId = operationId;
        const read = async (source: typeof requester, sourceSessionId: string, id = acceptedOperationId) =>
            invoke(source, await mint(source, sourceSessionId, ACTION_OPERATION_GET_ACTION_ID_V1,
                { ...address, operationId: id }), getMethod, { operationId: id });
        const ownOperation = { ok: true, result: { kind: 'found', operation: {
            operationId: acceptedOperationId, state: 'succeeded', scope: { accountId: member.account.id, machineId, sessionId },
        } } };
        expect(await read(requester, sessionId)).toMatchObject(ownOperation);
        expect(await read(requester, secondSessionId)).toMatchObject(ownOperation);

        const notFound = { ok: true, result: { kind: 'not_found' } };
        expect(await read(teammate, peerSessionId)).toEqual(notFound);
        expect(await read(teammate, peerSessionId, crypto.randomUUID())).toEqual(notFound);
        expectMintRefusal(await mint(ungranted, outsiderSessionId, ACTION_OPERATION_GET_ACTION_ID_V1,
            { ...address, operationId: acceptedOperationId }));
        const nonGet = await mint(requester, sessionId, ACTION_OPERATION_LIST_ACTION_ID_V1, address);
        expect('authorization' in nonGet ? { admitted: true } : nonGet).toMatchObject({
            ok: false, phase: 'mint', code: 'target_unavailable', failureCause: { httpStatus: 409 },
        });

        const custodianGet = (id: string) => call(custodian, { method: `${machineId}:${getMethod}`,
            requestId: crypto.randomUUID(), params: { operationId: id } });
        expect(await custodianGet(acceptedOperationId)).toEqual(notFound);
        expect(await call(custodian, { method: `${machineId}:${startMethod}`,
            requestId: crypto.randomUUID(), params: address })).toMatchObject({ ok: true });
        if (!operationId || operationId === acceptedOperationId) throw new Error('No accepted custodian operation');
        expect(await custodianGet(operationId)).toMatchObject({ ok: true, result: { kind: 'found', operation: {
            operationId, state: 'succeeded', scope: { accountId: owner.account.id, machineId },
        } } });

        await db.machineGrant.delete({ where: { id: grant.id } });
        expectMintRefusal(await mint(requester, sessionId, ACTION_OPERATION_GET_ACTION_ID_V1,
            { ...address, operationId: acceptedOperationId }));
    } finally {
        restoreHttp();
        await app.close();
    }
});
