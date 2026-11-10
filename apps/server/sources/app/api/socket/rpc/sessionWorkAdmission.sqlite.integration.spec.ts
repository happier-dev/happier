import { randomUUID } from 'node:crypto';
import { Server, type Socket } from 'socket.io';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION, MACHINE_PLAIN_DATA_KEY_MARKER,
    buildAccountStoredContentCompatibilitySocketAuthV1, encodePlainMachineStoredContent } from '@happier-dev/protocol';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { createSessionMachineAccessKeyInTx } from '@/app/accessKeys/sessionMachineAccessKeyMutations';
import { evaluateAccountStoredContentSocketCompatibility } from '@/app/clientCompatibility/accountStoredContentCompatibility';
import { removeMachineAccessGrantInTx } from '@/app/machines/machineAccess';
import { createSessionPublisherPresence } from '@/app/presence/sessionPublisherPresence';
import { getAccountSessionSocketRoom } from '@/app/api/socketRooms';
import { createAuthenticatedFakeSocket, triggerSocketHandler } from '@/app/api/testkit/socketHarness';
import { createAccountTokenForTests, createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { setEligibleMachineAccessGrantInTx } from '@/testkit/machineAccessGrant.testkit';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { resolveSessionScopedSocketBinding } from '../sessionScopedBinding';
import { registerSocketRpcHandlers } from './registerSocketRpcHandlers';
import { buildRpcMethodRoom } from './rpcMethodRoom';

const accountStoredContentCompatibility = evaluateAccountStoredContentSocketCompatibility(
    buildAccountStoredContentCompatibilitySocketAuthV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION),
).evaluation;

describe('Session work admission after Machine grant withdrawal', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-session-work-admission-', initAuth: true,
            env: { HAPPIER_SERVER_IDENTITY_ID: 'srv_session-work-admission', HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional' } });
    }, 180_000);
    afterAll(async () => { await harness?.close(); });

    // Attachments require Use; headerless filesystem transfers require Manage.
    // Both enter the real protected receiver guard after Session admission.
    it.each(['attachment', 'raw'] as const)('refuses new work on the retained publisher while preserving Stop, cancel and reads (%s)', async transferCarrier => {
        const custodian = await db.account.create({ data: { encryptionMode: 'plain' } });
        const guest = await db.account.create({ data: { encryptionMode: 'plain' } });
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: custodian.id,
            installationId: randomUUID(), active: true,
            metadata: encodePlainMachineStoredContent({ host: 'work-admission', platform: 'linux', happyCliVersion: 'test',
                homeDir: '/home/guest', happyHomeDir: '/home/guest/.happier' }),
            dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
            operationProtocolCapabilities: { requesterExecutionIsolation: { protocolVersions: [1] },
                sessionInputAdmission: { protocolVersions: [1, 2, 3] } }, operationProtocolCapabilitiesRevision: 1 } });
        expect(await inTx(tx => setEligibleMachineAccessGrantInTx(tx, { actorAccountId: custodian.id,
            machineId: machine.id, principal: { kind: 'account', accountId: guest.id }, level: transferCarrier === 'raw' ? 'admin' : 'view' })))
            .toMatchObject({ kind: 'saved' });
        const session = await db.session.create({ data: { accountId: guest.id, tag: randomUUID(),
            encryptionMode: 'plain', metadata: '{}' } });
        expect(await inTx(tx => createSessionMachineAccessKeyInTx(tx, { accountId: guest.id,
            machineId: machine.id, sessionId: session.id, data: 'opaque-session-key' }))).toMatchObject({ ok: true });
        const admitted = await resolveSessionScopedSocketBinding({ userId: guest.id, machineId: machine.id, sessionId: session.id });
        expect(admitted.ok).toBe(true);
        if (!admitted.ok) throw new Error('Publisher admission failed');

        // Only Socket.IO delivery is substituted: real tokens, grants, binding,
        // database and registered RPC admission/forwarding remain in the path.
        const emitWithAck = vi.fn(async () => ({ delivered: true }));
        const target = createAuthenticatedFakeSocket({ id: randomUUID(), data: { clientType: 'session-scoped',
            userId: guest.id, accountStoredContentCompatibility, sessionScopedBinding: admitted.binding },
            timeout: () => ({ emitWithAck }) });
        const io = new Server();
        io.sockets.sockets.set(target.id, target as unknown as Socket);
        io.sockets.adapter.rooms.set(getAccountSessionSocketRoom(guest.id, session.id), new Set([target.id]));
        const presence = createSessionPublisherPresence();
        expect(await presence.registerPublisher({ socket: target,
            binding: { accountId: guest.id, machineId: machine.id, sessionId: session.id },
            completeActivitySnapshot: { state: 'unknown', activeCount: 0 } })).toMatchObject({ status: 'registered' });
        const token = await createAccountTokenForTests(guest.id, { kind: 'account', authority: 'present_user' });
        const caller = Object.assign(createAuthenticatedFakeSocket({ id: randomUUID(), data: {
            clientType: 'user-scoped', accountStoredContentCompatibility,
        } }), { handshake: { auth: { token } } });
        registerSocketRpcHandlers({ userId: guest.id, socket: caller as unknown as Socket, io, sessionPublisherPresence: presence });
        const call = async (rpcMethod: string) => {
            const method = `${session.id}:${rpcMethod}`;
            io.sockets.adapter.rooms.set(buildRpcMethodRoom({ userId: guest.id, method }), new Set([target.id]));
            const callback = vi.fn();
            emitWithAck.mockClear();
            await triggerSocketHandler(caller, SOCKET_RPC_EVENTS.CALL, { method, params: 'sealed-work-request',
                ...(transferCarrier === 'attachment' && rpcMethod === RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT ? { transferRouting: {
                    t: 'session_attachment_upload_v1', sessionId: session.id, method: rpcMethod,
                } } : {}),
            }, callback);
            expect(callback).toHaveBeenCalledOnce();
            return callback.mock.calls[0]![0];
        };
        const workMethods = [RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT, SESSION_RPC_METHODS.EXECUTION_RUN_START, SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START,
            SESSION_RPC_METHODS.EXECUTION_RUN_SEND, SESSION_RPC_METHODS.SESSION_REVIEW_START_INLINE,
            SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_START, SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE,
            SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START_PROVIDER_SAFE_V1, SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START,
            SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_START_V2, SESSION_RPC_METHODS.EXECUTION_RUN_ACTION,
            SESSION_RPC_METHODS.SESSION_COMPACT, SESSION_RPC_METHODS.SESSION_GOAL_SET,
            SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_WAIT_RESUME_ENABLE, SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_CHECK_NOW,
            SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_CONSUME_RESET_CREDIT,
            SESSION_RPC_METHODS.SESSION_ROLLBACK, SESSION_RPC_METHODS.SESSION_CHECKPOINT_CODE_ROLLBACK,
            SESSION_RPC_METHODS.SESSION_CHECKPOINT, SESSION_RPC_METHODS.SESSION_RESTORE];
        try {
            for (const method of workMethods) {
                expect(await call(method), method).toMatchObject({ ok: true, result: { delivered: true } });
            }
            expect(await inTx(tx => removeMachineAccessGrantInTx(tx, { actorAccountId: custodian.id,
                machineId: machine.id, principal: { kind: 'account', accountId: guest.id } })))
                .toMatchObject({ kind: 'removed' });
            expect(target.connected).toBe(true);
            for (const method of workMethods) {
                expect.soft(await call(method), method).toMatchObject({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN });
                expect.soft(emitWithAck, method).not.toHaveBeenCalled();
            }
            for (const method of [SESSION_RPC_METHODS.EXECUTION_RUN_STOP, SESSION_RPC_METHODS.EXECUTION_RUN_CANCEL_TURN_V1,
                SESSION_RPC_METHODS.EXECUTION_RUN_STREAM_CANCEL, SESSION_RPC_METHODS.SESSION_INPUT_CANCEL_EXACT_TURN_V1,
                SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_WAIT_RESUME_CANCEL, SESSION_RPC_METHODS.SESSION_GOAL_CLEAR,
                SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_STOP, SESSION_RPC_METHODS.EXECUTION_RUN_GET]) {
                expect(await call(method), method).toMatchObject({ ok: true, result: { delivered: true } });
            }
            expect(await inTx(tx => setEligibleMachineAccessGrantInTx(tx, { actorAccountId: custodian.id,
                machineId: machine.id, principal: { kind: 'account', accountId: guest.id }, level: transferCarrier === 'raw' ? 'admin' : 'view' })))
                .toMatchObject({ kind: 'saved' });
            for (const method of workMethods) {
                expect(await call(method), method).toMatchObject({ ok: true, result: { delivered: true } });
            }
        } finally { io.sockets.sockets.clear(); }
    });
});
