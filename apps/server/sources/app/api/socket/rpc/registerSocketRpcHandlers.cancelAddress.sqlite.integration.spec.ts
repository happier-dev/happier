import { randomUUID } from 'node:crypto';
import nacl from 'tweetnacl';
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest';
import type { Socket } from 'socket.io';
import { CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
    buildAccountStoredContentCompatibilitySocketAuthV1, decodeBase64 } from '@happier-dev/protocol';
import { MACHINE_PLAIN_DATA_KEY_MARKER, encodePlainMachineStoredContent } from '@happier-dev/protocol/machines/machineStoredContent';
import { ACTION_OPERATION_RPC_METHODS_V1 } from '@happier-dev/protocol/actions/operations/v1';
import { ExternalActionExecutionAuthorizationV1Schema, ExternalActionMachineRpcExecutionV1Schema,
    bindExternalActionExecutionAuthorizationHttpPathV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { signExternalActionMachineRpcRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { SOCKET_RPC_EVENTS, type SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { auth } from '@/app/auth/auth';
import { evaluateAccountStoredContentSocketCompatibility } from '@/app/clientCompatibility/accountStoredContentCompatibility';
import { createAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { registerExternalActionRoutes } from '@/app/api/routes/actions/registerExternalActionRoutes';
import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createAuthenticatedFakeSocket, createSocketRoomDiscoveryHarness, triggerSocketHandler } from '../../testkit/socketHarness';
import { registerSocketRpcHandlers } from './registerSocketRpcHandlers';

describe('signed cancellation original Address through the Home relay', () => {
    const serverId = `srv_${'c'.repeat(32)}`;
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-cancel-address-relay-',
            initAuth: true, initEncrypt: true, env: { HAPPIER_SERVER_IDENTITY_ID: serverId,
                AUTH_REQUIRED_LOGIN_PROVIDERS: '', HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: 'true',
                HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional' } });
    }, 180_000);
    afterAll(async () => { if (harness) await harness.close(); });

    it('retains the reviewed cancel envelope only for the current requester Account on a shared Machine', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const actor = await db.account.create({ data: { encryptionMode: 'plain' } });
        const installationKey = nacl.sign.keyPair();
        const installationId = randomUUID();
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id, active: true,
            installationId, installationPublicKey: new Uint8Array(installationKey.publicKey),
            metadata: encodePlainMachineStoredContent({ host: 'cancel-worker', platform: 'linux', happyCliVersion: 'test',
                homeDir: '/worker', happyHomeDir: '/worker/.happier' }),
            dataEncryptionKey: new Uint8Array(decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64')) } });
        await db.machineGrant.create({ data: { principalKind: 'account', machineId: machine.id, accountId: actor.id,
            accessLevel: 'view', createdByAccountId: owner.id } });
        const accountToken = await auth.createToken(actor.id, undefined, { kind: 'account', authority: 'present_user' });
        const app = createAuthenticatedTestApp({ authentication: 'real' });
        registerExternalActionRoutes(app, { dispatch: async () => ({ kind: 'placement_error', code: 'target_unavailable' }) });
        onTestFinished(() => app.close());
        await app.ready();
        const target = { kind: 'machine' as const, machineId: machine.id };
        const address = { serverId, machineId: machine.id, operationId: 'reviewed-operation' };
        const envelope = { v: 1 as const, requestId: randomUUID(), target, input: address };
        const minted = await app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1('action.operations.cancel'),
            headers: { authorization: `Bearer ${accountToken}` }, payload: { v: 1, machineId: machine.id, envelope } });
        const mintRefusal: unknown = minted.statusCode === 200 ? null : minted.json();
        const mintError = mintRefusal && typeof mintRefusal === 'object' && 'error' in mintRefusal
            && typeof mintRefusal.error === 'string' && /^[a-z_]+$/u.test(mintRefusal.error) ? mintRefusal.error : 'unclassified';
        expect(minted.statusCode, `Home cancellation admission: ${mintError}`).toBe(200);
        const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(minted.json());
        const method = `${machine.id}:${ACTION_OPERATION_RPC_METHODS_V1.cancel}`;
        const forwarded: SocketRpcRequestPayload[] = [];
        // Only the receiving daemon is the network boundary. Home root minting,
        // signature verification, requester/installation currentness and relay stay real.
        const effect = vi.fn(async (_event: string, payload: SocketRpcRequestPayload) => {
            forwarded.push(payload);
            return { kind: 'requested' };
        });
        const compatibility = evaluateAccountStoredContentSocketCompatibility(
            buildAccountStoredContentCompatibilitySocketAuthV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION)).evaluation;
        const daemon = createAuthenticatedFakeSocket({ id: 'cancel-daemon', data: { clientType: 'machine-scoped',
            userId: owner.id, machineId: machine.id, verifiedMachineInstallationId: installationId,
            accountStoredContentCompatibility: compatibility }, timeout: () => ({ emitWithAck: effect }) });
        const io = createSocketRoomDiscoveryHarness(async room => room === daemon.id || room === `rpc:${owner.id}:${method}` ? [daemon] : []);
        const caller = Object.assign(createAuthenticatedFakeSocket({ id: 'cancel-requester', data: {
            clientType: 'user-scoped', authTokenKind: 'account', authAuthority: 'present_user',
            accountStoredContentCompatibility: compatibility } }), { handshake: { auth: { token: accountToken } } });
        registerSocketRpcHandlers({ userId: actor.id, socket: caller as unknown as Socket, io });
        const call = async (operationId: string, options: Readonly<{
            effectActionId?: 'action.operations.cancel' | 'action.operations.get';
            originalActionEnvelope?: typeof envelope;
        }> = {}) => {
            const params = { operationId };
            const requestId = randomUUID();
            const effectActionId = options.effectActionId ?? 'action.operations.cancel';
            const execution = ExternalActionMachineRpcExecutionV1Schema.parse({ v: 1, authorization,
                effectActionId, target, installationId,
                machineSignature: signExternalActionMachineRpcRequestV1({ authorizationToken: authorization.token,
                    effectActionId, target, installationId,
                    event: SOCKET_RPC_EVENTS.CALL, method, requestId, params, privateKey: installationKey.secretKey }) });
            const callback = vi.fn();
            await triggerSocketHandler(caller, SOCKET_RPC_EVENTS.CALL, { method, params, requestId,
                externalActionExecution: execution, originalActionEnvelope: options.originalActionEnvelope ?? envelope }, callback);
            return callback;
        };
        expect(await call(address.operationId, { effectActionId: 'action.operations.get' })).toHaveBeenCalledWith(
            expect.objectContaining({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN }));
        expect(await call(address.operationId, { originalActionEnvelope: { ...envelope,
            input: { ...address, operationId: 'substituted-review' } } })).toHaveBeenCalledWith(
            expect.objectContaining({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN }));
        expect(effect).not.toHaveBeenCalled();
        expect(await call(address.operationId)).toHaveBeenCalledWith({ ok: true, result: { kind: 'requested' } });
        expect(forwarded).toHaveLength(1);
        expect(forwarded[0]?.machineAdmission?.actorAccountId).toBe(actor.id);
        expect(forwarded[0]?.originalActionEnvelope).toEqual(envelope);
        await db.machineGrant.delete({ where: { principalKind: 'account', machineId_accountId: { machineId: machine.id, accountId: actor.id } } });
        expect(await call(address.operationId)).toHaveBeenCalledWith(expect.objectContaining({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN }));
        expect(forwarded).toHaveLength(1);
    });
});
