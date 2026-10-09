import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Server, Socket } from 'socket.io';
import nacl from 'tweetnacl';
import { MACHINE_PLAIN_DATA_KEY_MARKER, decodeBase64, encodePlainMachineStoredContent } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { computeExternalActionRequestEnvelopeDigestV1, createExternalActionDaemonDispatchResponseV1,
    prepareExternalActionResponseEnvelopeV1, signExternalActionMachineRpcRequestV1 } from '@happier-dev/protocol/actions';
import { db } from '@/storage/db';
import { auth } from '@/app/auth/auth';
import { getOrCreateServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createAuthenticatedFakeSocket, triggerSocketHandler } from '../testkit/socketHarness';
import { currentAccountStoredContentCompatibilitySocketAuth } from '../testkit/accountStoredContentCompatibility';
import { evaluateAccountStoredContentSocketCompatibility } from '@/app/clientCompatibility/accountStoredContentCompatibility';
import { registerSocketRpcHandlers } from './rpc/registerSocketRpcHandlers';
import { createExternalActionDaemonDispatcher, EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1 } from './externalActionDispatcher';

describe('requester handoff placement and exact signed ingress', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-fx14-handoff-',
        initAuth: true, env: { AUTH_REQUIRED_LOGIN_PROVIDERS: '', AUTH_LOGIN_ELIGIBILITY_CACHE_TTL_MS: '0' } }); }, 180_000);
    afterAll(async () => { if (harness) await harness.close(); });

    it('admits an own Session on a shared source, rechecks both installations and refuses unsigned or stale effects', async () => {
        const alice = await db.account.create({ data: { encryptionMode: 'plain' } });
        const bob = await db.account.create({ data: { encryptionMode: 'plain' } });
        const keys = nacl.sign.keyPair();
        const machineData = { metadata: encodePlainMachineStoredContent({ host: 'shared', platform: 'linux', happyCliVersion: 'test',
            homeDir: '/home/shared', happyHomeDir: '/home/shared/.happier' }), active: true,
            dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64'),
            operationProtocolCapabilitiesRevision: 1, operationProtocolCapabilities: { externalActionExecutionAuthorization: { protocolVersions: [1] } } };
        const source = await db.machine.create({ data: { ...machineData, id: randomUUID(), accountId: alice.id,
            installationId: randomUUID(), installationPublicKey: keys.publicKey } });
        const target = await db.machine.create({ data: { ...machineData, id: randomUUID(), accountId: bob.id,
            installationId: randomUUID(), installationPublicKey: nacl.sign.keyPair().publicKey } });
        const grant = { machineId: source.id, accountId: bob.id, accessLevel: 'view' as const, createdByAccountId: alice.id };
        await db.machineAccountGrant.create({ data: grant });
        const session = await db.session.create({ data: { accountId: bob.id, tag: randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
        await db.accessKey.create({ data: { accountId: bob.id, sessionId: session.id, machineId: source.id, data: 'opaque' } });
        const envelope = { v: 1 as const, requestId: randomUUID(), target: { kind: 'machine' as const, machineId: source.id },
            handoffAdmission: { sessionId: session.id, sourceMachineId: source.id, targetMachineId: target.id },
            input: { sessionId: session.id, sourceMachineId: source.id, targetMachineId: target.id } };
        const principal = { accountId: bob.id, authority: 'present_user' as const,
            authentication: { kind: 'account' as const, tokenEpoch: bob.tokenEpoch } };
        const authorization = await auth.mintExternalActionExecutionAuthorization({ accountId: bob.id, authentication: principal.authentication,
            serverIdentityId: await getOrCreateServerIdentityId(), machineId: source.id, actionId: 'session.handoff',
            requestId: envelope.requestId, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
            target: envelope.target, handoffAdmission: { ...envelope.handoffAdmission,
                sourceInstallationId: source.installationId!, targetInstallationId: target.installationId! } }, { input: envelope.input });
        const compatibility = evaluateAccountStoredContentSocketCompatibility(currentAccountStoredContentCompatibilitySocketAuth).evaluation;
        const effect = vi.fn(async (_event: string, payload: unknown) => {
            const method = (payload as { method: string }).method;
            return method.endsWith(EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1)
                ? createExternalActionDaemonDispatchResponseV1(prepareExternalActionResponseEnvelopeV1({ v: 1,
                    actionId: 'session.handoff', requestId: envelope.requestId, execution: { ok: true, result: { handoffId: 'accepted' } } }))
                : { accepted: true };
        });
        const daemon = { id: 'fx14-source', data: { clientType: 'machine-scoped', userId: alice.id,
            machineId: source.id, verifiedMachineInstallationId: source.installationId, accountStoredContentCompatibility: compatibility },
            timeout: () => ({ emitWithAck: effect }) };
        let duringLatest: (() => Promise<unknown>) | undefined;
        const read = async (room: string) => {
            if (room === daemon.id && duringLatest) { const mutate = duringLatest; duringLatest = undefined; await mutate(); }
            return room === daemon.id || room.startsWith(`rpc:${alice.id}:${source.id}:`) ? [daemon] : [];
        };
        const io = { in: (room: string) => ({ timeout: () => ({ fetchSockets: () => read(room) }), fetchSockets: () => read(room) }) } as unknown as Server;
        const dispatch = createExternalActionDaemonDispatcher({ io });
        const relay = (alreadyAdmitted = true) => dispatch({ actionId: 'session.handoff', envelope, principal,
            ...(alreadyAdmitted ? { executionAuthorization: authorization } : {}) });
        expect(await relay()).toMatchObject({ kind: 'response', prepared: { response: { execution: { ok: true } } } });
        expect(await relay(false)).toMatchObject({ kind: 'response', prepared: { response: { execution: { ok: true } } } });
        const method = `${source.id}:${RPC_METHODS.DAEMON_SESSION_HANDOFF_START_V3}`;
        const params = 'sealed-own-session';
        const execution = { v: 1 as const, authorization, effectActionId: 'session.handoff', target: envelope.target,
            installationId: source.installationId!, machineSignature: signExternalActionMachineRpcRequestV1({
                authorizationToken: authorization.token, effectActionId: 'session.handoff', target: envelope.target,
                installationId: source.installationId!, event: SOCKET_RPC_EVENTS.CALL, method,
                requestId: envelope.requestId, params, privateKey: keys.secretKey }) };
        const caller = createAuthenticatedFakeSocket({ id: 'fx14-caller', data: { clientType: 'user-scoped', accountStoredContentCompatibility: compatibility } });
        registerSocketRpcHandlers({ userId: bob.id, socket: caller as unknown as Socket, io });
        const call = async (signed = true) => {
            const callback = vi.fn();
            await triggerSocketHandler(caller, SOCKET_RPC_EVENTS.CALL, { method, params, requestId: envelope.requestId,
                ...(signed ? { externalActionExecution: execution } : {}) }, callback);
            return callback;
        };
        expect(await call()).toHaveBeenCalledWith({ ok: true, result: { accepted: true } });
        effect.mockClear();
        expect(await call(false)).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
        expect(effect).not.toHaveBeenCalled();
        for (const machine of [source, target]) {
            duringLatest = () => db.machine.update({ where: { id: machine.id }, data: { installationId: randomUUID() } });
            expect(await relay()).toMatchObject({ kind: 'placement_error' });
            expect(effect).not.toHaveBeenCalled();
            await db.machine.update({ where: { id: machine.id }, data: { installationId: machine.installationId } });
            duringLatest = () => db.machine.update({ where: { id: machine.id }, data: { installationId: randomUUID() } });
            expect(await call()).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
            expect(effect).not.toHaveBeenCalled();
            await db.machine.update({ where: { id: machine.id }, data: { installationId: machine.installationId } });
        }
        await db.session.update({ where: { id: session.id }, data: { accountId: alice.id } });
        expect(await relay()).toMatchObject({ kind: 'placement_error' });
        expect(await call()).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
        expect(effect).not.toHaveBeenCalled();
        await db.session.update({ where: { id: session.id }, data: { accountId: bob.id } });
        duringLatest = () => db.machineAccountGrant.delete({ where: { machineId_accountId: { machineId: source.id, accountId: bob.id } } });
        expect(await call()).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
        expect(effect).not.toHaveBeenCalled();
        expect(await relay()).toMatchObject({ kind: 'placement_error' });
        await db.machineAccountGrant.create({ data: grant });
        await db.machine.update({ where: { id: source.id }, data: { active: false } });
        expect(await relay()).toMatchObject({ kind: 'placement_error' });
        expect(await call()).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
        expect(effect).not.toHaveBeenCalled();
    });
});
