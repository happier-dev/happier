import { randomUUID } from 'node:crypto';
import { copyFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Server, type Socket } from 'socket.io';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MACHINE_PLAIN_DATA_KEY_MARKER, encodePlainMachineStoredContent } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SessionTransferRpcMethodV1Schema, SessionTransferRoutingV1Schema } from '@happier-dev/protocol/socketRpc';
import { resolveMachineRpcRoutePolicy } from '@happier-dev/protocol/machines/peer/mediation/rpc/routePolicyV1';
import { createTransferSessionLifecycle, TransferSessionStore } from '@happier-dev/transfers/node';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { setEligibleMachineAccessGrantInTx } from '@/testkit/machineAccessGrant.testkit';
import { createSessionMachineAccessKeyInTx } from '@/app/accessKeys/sessionMachineAccessKeyMutations';
import { removeMachineAccessGrantInTx } from '@/app/machines/machineAccess';
import * as machineAccess from '@/app/machines/machineAccess';
import { createProtectedRawSessionTargetGuard } from './protectedRawSessionTargetGuard';
import { forwardRpcCall } from './forwardRpcCall';
import { buildRpcMethodRoom } from './rpcMethodRoom';

describe('Session attachment execution custody (real SQLite)', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-attachment-access-' });
    }, 180_000);
    afterAll(async () => { await harness?.close(); });

    it('forwards only the admitted requester’s own Session attachments and refuses withdrawn or unrelated custody', async () => {
        const custodian = await db.account.create({ data: { encryptionMode: 'plain' } });
        const requester = await db.account.create({ data: { encryptionMode: 'plain' } });
        const session = await db.session.create({ data: { accountId: requester.id, tag: randomUUID(),
            encryptionMode: 'plain', metadata: '{}' } });
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: custodian.id,
            installationId: randomUUID(), metadata: encodePlainMachineStoredContent({ host: 'host', platform: 'linux',
                happyCliVersion: 'test', homeDir: '/home/custodian', happyHomeDir: '/home/custodian/.happier' }),
            dataEncryptionKey: new Uint8Array(Buffer.from(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64')),
            operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1, 2] },
                requesterExecutionIsolation: { protocolVersions: [1] } }, operationProtocolCapabilitiesRevision: 1 } });
        await inTx(tx => setEligibleMachineAccessGrantInTx(tx, { actorAccountId: custodian.id, machineId: machine.id,
            principal: { kind: 'account', accountId: requester.id }, level: 'view' }));
        expect(await inTx(tx => createSessionMachineAccessKeyInTx(tx, { accountId: requester.id, machineId: machine.id,
            sessionId: session.id, data: 'opaque-session-key' }))).toMatchObject({ ok: true });
        // Only the Socket.IO transport is substituted. Binding, Use grant,
        // admission and the refusal envelope run through their real owners.
        let receiveTransfer: ((method: string) => Promise<void>) | undefined;
        const emitWithAck = vi.fn(async (_event: string, request: unknown) => {
            if (receiveTransfer) {
                if (!request || typeof request !== 'object' || !('method' in request) || typeof request.method !== 'string')
                    throw new Error('Missing forwarded method');
                await receiveTransfer(request.method.slice(request.method.indexOf(':') + 1));
            }
            return 'native-session-attachment-result';
        });
        const target = { id: randomUUID(), connected: true, data: { clientType: 'session-scoped', userId: requester.id,
            sessionScopedBinding: { sessionId: session.id, machineId: machine.id, proof: 'machine-access-key' } },
            timeout: () => ({ emitWithAck }) };
        const io = new Server();
        io.sockets.sockets.set(target.id, target as unknown as Socket);
        const invoke = (rpcMethod: string, actorAccountId = requester.id, sessionId = session.id, attachment = true) => {
            const method = `${sessionId}:${rpcMethod}`;
            const transferRouting = attachment && SessionTransferRpcMethodV1Schema.safeParse(rpcMethod).success
                ? SessionTransferRoutingV1Schema.parse({ method: rpcMethod, sessionId,
                    t: resolveMachineRpcRoutePolicy(rpcMethod).ephemeralRunnerAuthority === 'submitAgentInput'
                        ? 'session_attachment_upload_v1' : 'session_attachment_download_v1' }) : undefined;
            const guard = createProtectedRawSessionTargetGuard({ method, actorAccountId,
                targetUserId: requester.id, callerSocket: { data: { clientType: 'user-scoped' } },
                callerAuthority: 'present_user', knownSessionSource: false, transferRouting });
            if (!guard) throw new Error('Expected protected Session RPC');
            io.sockets.adapter.rooms.set(buildRpcMethodRoom({ userId: requester.id, method }), new Set([target.id]));
            return forwardRpcCall({ io, targetUserId: requester.id, method,
                callerSocketId: 'browser', callParams: 'sealed-attachment-input', transferRouting, ...guard });
        };
        try {
            // ATTACH-CUSTODY replaces ATTACH-ACCESS's refusal once the exact
            // Session receiver spends this receipt in native attachment custody.
            for (const rpcMethod of SessionTransferRpcMethodV1Schema.options) {
                expect(await invoke(rpcMethod)).toMatchObject({ ok: true, result: 'native-session-attachment-result' });
                expect(emitWithAck.mock.lastCall?.[1]).toMatchObject({ machineAdmission: {
                    actorAccountId: requester.id, custodianAccountId: custodian.id, machineId: machine.id,
                    installationId: machine.installationId, role: 'use', encryptionMode: 'plain',
                } });
            }
            // Transparent instrumentation: the real grant evaluator still runs.
            const grantEvaluations = vi.spyOn(machineAccess, 'projectActiveMachineAdmissionFromFacts');
            const store = new TransferSessionStore({ tempRoot: join(harness.baseDir, 'upload-store'), ttlMs: 60_000 });
            const lifecycle = createTransferSessionLifecycle({ store, chunkSizeBytes: 1 });
            const destination = join(harness.baseDir, 'attachment.txt');
            let uploadId = '';
            let nextIndex = 0;
            receiveTransfer = async method => {
                if (method === RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT) {
                    const upload = await lifecycle.openUploadTransferSession({ target: {
                        destPath: destination, destDisplayPath: 'attachment.txt', expectedSizeBytes: 5, overwrite: false,
                        finalizeUpload: async ({ tempPath, sizeBytes }) => {
                            await copyFile(tempPath, destination);
                            return { success: true, path: 'attachment.txt', sizeBytes };
                        },
                    } });
                    uploadId = upload.uploadId;
                    nextIndex = 0;
                } else if (method === RPC_METHODS.DAEMON_TRANSFER_UPLOAD_CHUNK) {
                    expect(await lifecycle.writeUploadTransferChunk({ uploadId, index: nextIndex++, contentBase64: 'eA==' }))
                        .toMatchObject({ success: true });
                } else if (method === RPC_METHODS.DAEMON_TRANSFER_UPLOAD_FINALIZE) {
                    expect(await lifecycle.finalizeUploadTransferSession({ uploadId })).toMatchObject({ success: true });
                } else if (method === RPC_METHODS.DAEMON_TRANSFER_UPLOAD_ABORT) {
                    await lifecycle.abortUploadTransferSession({ uploadId });
                    expect(store.getUploadSession(uploadId)).toBeNull();
                }
            };
            try {
                expect(await invoke(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT)).toMatchObject({ ok: true });
                for (let chunk = 0; chunk < 5; chunk += 1) {
                    expect(await invoke(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_CHUNK)).toMatchObject({ ok: true });
                }
                expect(await invoke(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_FINALIZE)).toMatchObject({ ok: true });
                expect(await readFile(destination, 'utf8')).toBe('xxxxx');
                expect(store.getUploadSession(uploadId)).toBeNull();
                expect(grantEvaluations).toHaveBeenCalledTimes(1);
                // Both transfers are admitted before withdrawal. One finishes;
                // the other can always abort, including an idempotent repeat.
                expect(await invoke(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT)).toMatchObject({ ok: true });
                const abortUploadId = uploadId;
                expect(store.getUploadSession(abortUploadId)).not.toBeNull();
                expect(await invoke(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT)).toMatchObject({ ok: true });
                await inTx(tx => removeMachineAccessGrantInTx(tx, { actorAccountId: custodian.id, machineId: machine.id,
                    principal: { kind: 'account', accountId: requester.id } }));
                for (let chunk = 0; chunk < 5; chunk += 1) {
                    expect(await invoke(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_CHUNK)).toMatchObject({ ok: true });
                }
                expect(await invoke(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_FINALIZE)).toMatchObject({ ok: true });
                expect(store.getUploadSession(uploadId)).toBeNull();
                expect(await readFile(destination, 'utf8')).toBe('xxxxx');
                uploadId = abortUploadId;
                expect(await invoke(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_ABORT)).toMatchObject({ ok: true });
                expect(await invoke(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_ABORT)).toMatchObject({ ok: true });
                expect(grantEvaluations).toHaveBeenCalledTimes(3);
            } finally { receiveTransfer = undefined; grantEvaluations.mockRestore(); await store.dispose(); }
            await inTx(tx => setEligibleMachineAccessGrantInTx(tx, { actorAccountId: custodian.id, machineId: machine.id,
                principal: { kind: 'account', accountId: requester.id }, level: 'view' }));
            emitWithAck.mockClear();
            const otherMember = await db.account.create({ data: { encryptionMode: 'plain' } });
            await inTx(tx => setEligibleMachineAccessGrantInTx(tx, { actorAccountId: custodian.id, machineId: machine.id,
                principal: { kind: 'account', accountId: otherMember.id }, level: 'view' }));
            expect(await invoke(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT, otherMember.id))
                .toMatchObject({ ok: false, errorCode: 'RPC_FORBIDDEN' });
            expect(await invoke(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT, requester.id, randomUUID()))
                .toMatchObject({ ok: false, errorCode: 'RPC_FORBIDDEN' });
            const unboundSession = await db.session.create({ data: { accountId: requester.id, tag: randomUUID(),
                encryptionMode: 'plain', metadata: '{}' } });
            target.data.sessionScopedBinding.sessionId = unboundSession.id;
            expect(await invoke(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT, requester.id, unboundSession.id))
                .toMatchObject({ ok: false, errorCode: 'RPC_FORBIDDEN' });
            target.data.sessionScopedBinding.sessionId = session.id;
            expect(await invoke(RPC_METHODS.READ_FILE)).toMatchObject({ ok: false, errorCode: 'agent_isolation_unavailable' });
            expect(await invoke(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT, requester.id, session.id, false))
                .toMatchObject({ ok: false, errorCode: 'agent_isolation_unavailable' });
            expect(emitWithAck).not.toHaveBeenCalled();
            await inTx(tx => removeMachineAccessGrantInTx(tx, { actorAccountId: custodian.id, machineId: machine.id,
                principal: { kind: 'account', accountId: requester.id } }));
            // Withdrawal affects the next INIT; an admitted transfer can finish
            // or abort. The receiver's existing store owns transfer activity.
            for (const rpcMethod of [RPC_METHODS.DAEMON_TRANSFER_UPLOAD_CHUNK,
                RPC_METHODS.DAEMON_TRANSFER_UPLOAD_FINALIZE, RPC_METHODS.DAEMON_TRANSFER_UPLOAD_ABORT,
                RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_CHUNK, RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_FINALIZE,
                RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_ABORT]) {
                expect(await invoke(rpcMethod)).toMatchObject({ ok: true });
            }
            emitWithAck.mockClear();
            expect(await invoke(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT)).toMatchObject({ ok: false, errorCode: 'RPC_FORBIDDEN' });
            expect(await invoke(RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_INIT)).toMatchObject({ ok: false, errorCode: 'RPC_FORBIDDEN' });
            expect(emitWithAck).not.toHaveBeenCalled();
            await db.machine.update({ where: { id: machine.id }, data: {
                operationProtocolCapabilities: {}, operationProtocolCapabilitiesRevision: 0,
            } });
            const ownerSession = await db.session.create({ data: { accountId: custodian.id, tag: randomUUID(),
                encryptionMode: 'plain', metadata: '{}' } });
            expect(await inTx(tx => createSessionMachineAccessKeyInTx(tx, { accountId: custodian.id, machineId: machine.id,
                sessionId: ownerSession.id, data: 'opaque-owner-session-key' }))).toMatchObject({ ok: true });
            target.data.userId = custodian.id;
            target.data.sessionScopedBinding.sessionId = ownerSession.id;
            const ownerMethod = `${ownerSession.id}:${RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT}`;
            const ownerGuard = createProtectedRawSessionTargetGuard({ method: ownerMethod, actorAccountId: custodian.id,
                targetUserId: custodian.id, callerSocket: { data: { clientType: 'user-scoped' } },
                callerAuthority: 'present_user', knownSessionSource: false });
            if (!ownerGuard) throw new Error('Expected protected owner upload');
            io.sockets.adapter.rooms.set(buildRpcMethodRoom({ userId: custodian.id, method: ownerMethod }), new Set([target.id]));
            expect(await forwardRpcCall({ io, targetUserId: custodian.id, method: ownerMethod,
                callerSocketId: 'owner-browser', callParams: 'sealed-owner-attachment-input', ...ownerGuard }))
                .toMatchObject({ ok: true, result: 'native-session-attachment-result' });
        } finally { io.sockets.sockets.clear(); }
    });
});
