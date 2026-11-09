import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SessionAttachmentHandleV1Schema } from '@happier-dev/protocol/transfers/sessions/sessionAttachmentHandleV1';
import { createEncryptedTransferChunkEnvelope, createTransferRecipientKeyPair, decryptEncryptedTransferChunkEnvelope } from '@happier-dev/transfers/node';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { createSessionRpcAuthorization } from '@/api/session/client/sessionRpcAuthorization';
import { readOrCreateInstallationIdentity } from '@/daemon/identity/store';
import { withTempDir } from '@/testkit/fs/tempDir';
import { runFilesystemEffectInternal } from './fileSystem/filesystemEffectInternal';
import { createFilesystemEffectChannel, initializeFilesystemEffectChannel } from './fileSystem/filesystemEffectChannel';
import type { SessionAttachmentNativeRuntime } from './fileSystem/sessionAttachmentIntake';
import { registerSessionHandlers } from './registerSessionHandlers';

describe('Session native attachment registration', () => {
    it.each(['owner', 'member'] as const)('authorizes %s through native-open retry and retained attachment custody', async actor => {
        await withTempDir('session-native-intake-', async root => {
            const installation = await readOrCreateInstallationIdentity();
            const accountId = actor === 'owner' ? 'owner-a' : 'member-a';
            let opens = 0;
            let closed = false;
            // Only native process pipes are replaced. Dispatch, encrypted chunks,
            // filesystem policy, issuance and transcript projection are real owners.
            // Pipes run as the test UID; agentIsolation.real.integration.test.ts
            // separately proves kernel UID separation and the native MCP launch.
            const native: SessionAttachmentNativeRuntime = {
                workingDirectory: root,
                requester: { sessionId: 'session-a', homeServerIdentityId: 'home-a', identity: {
                    kind: 'isolated', separationRequired: actor !== 'owner', requester: {
                        serverId: 'profile-a', accountId, machineId: 'machine-a', installationId: installation.installationId,
                    },
                } },
                async prepareFilesystemEffect(configuration) {
                    opens += 1;
                    if (opens === 1) throw new Error('Synthetic native open failure');
                    const input = new PassThrough();
                    const output = new PassThrough();
                    const running = runFilesystemEffectInternal(input, output);
                    const channel = createFilesystemEffectChannel({ input, output, dispose: async () => { await running; closed = true; } });
                    await initializeFilesystemEffectChannel(channel, configuration);
                    return channel;
                },
            };
            let currentRuntime: SessionAttachmentNativeRuntime | null = native;
            let registration: ReturnType<typeof registerSessionHandlers>;
            const rpc = new RpcHandlerManager({ scopePrefix: 'session-a', scopeKind: 'session', localMachineId: 'machine-a',
                encryptionMode: 'plain', logger: () => {},
                authorizeRequest: createSessionRpcAuthorization({ sessionId: 'session-a', localMachineId: 'machine-a',
                    serverUrl: 'https://attachment.test', isClosed: () => false,
                    readHomeServerIdentityId: () => 'home-a', readOwnerCredentials: async () => null,
                    readSessionAttachmentRequester: method => registration.readSessionAttachmentRequester(method) }),
            });
            registration = registerSessionHandlers(rpc, '/owner-workspace', {
                sessionId: 'session-a', readSessionAttachmentNativeRuntime: () => currentRuntime,
            });
            const invoke = (method: string, params: unknown, requester = accountId) => rpc.handleRequest({
                method: `session-a:${method}`, params, callerAuthority: 'present_user', machineAdmission: {
                    actorAccountId: requester, custodianAccountId: 'owner-a', machineId: 'machine-a',
                    installationId: installation.installationId, role: 'use', encryptionMode: 'plain',
                },
            }, undefined, 'authenticated_home_socket');
            const refuseForeign = async (method: string, params: unknown) => {
                expect(await invoke(method, params, 'foreign-account')).toMatchObject({
                    errorCode: 'agent_isolation_unavailable', effectAttempted: false,
                });
            };
            try {
                const bytes = Buffer.from('member attachment');
                const request = {
                    t: 'session_attachment_upload_v1', sessionId: 'session-a', messageLocalId: 'message-a',
                    fileName: 'notes.txt', sizeBytes: bytes.length, uploadLocation: 'os_temp',
                    workspaceRelativeDir: '.happier/attachments', vcsIgnoreStrategy: 'none', vcsIgnoreWritesEnabled: false,
                };
                await refuseForeign(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT, request);
                expect(await invoke(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT, request)).toMatchObject({ error: 'Synthetic native open failure' });
                const init = await invoke(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT, request);
                expect(init).toMatchObject({ success: true });
                expect(opens).toBe(2);
                const abortable = await invoke(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT, request);
                expect(abortable).toMatchObject({ success: true });
                // Releasing the launcher cannot move an admitted transfer back
                // to daemon-user IO; the successful channel keeps its custody.
                currentRuntime = null;
                const chunk = createEncryptedTransferChunkEnvelope({ transferId: init.uploadId, sequence: 0,
                    payload: bytes, recipientPublicKeyBase64: init.recipientPublicKeyBase64 });
                await refuseForeign(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_CHUNK, { uploadId: init.uploadId, index: 0, ...chunk });
                expect(await invoke(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_CHUNK, { uploadId: init.uploadId, index: 0, ...chunk }))
                    .toMatchObject({ success: true });
                // A later runtime cannot replace the requester of an admitted
                // channel, even while that different runtime is available.
                currentRuntime = { ...native, requester: { ...native.requester, identity: { ...native.requester.identity,
                    requester: { ...native.requester.identity.requester, accountId: 'foreign-account' } } } };
                await refuseForeign(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_FINALIZE, { uploadId: init.uploadId });
                const finalized = await invoke(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_FINALIZE, { uploadId: init.uploadId });
                expect(finalized).toMatchObject({ success: true });
                currentRuntime = null;
                const handle = SessionAttachmentHandleV1Schema.parse(finalized.attachmentHandle);
                const issued = registration.resolveSessionAttachment(handle);
                expect(issued).toMatchObject({ handle, name: 'notes.txt', sizeBytes: bytes.length });
                if (!issued) throw new Error('Native finalized handle missing from transcript projection');
                expect(issued.filePath.startsWith(join(root, '.happier', 'attachments'))).toBe(true);
                expect(await readFile(issued.filePath)).toEqual(bytes);
                expect(registration.resolveSessionAttachment({ ...handle, sessionId: 'session-b' })).toBeNull();
                expect(await invoke(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_CHUNK, { uploadId: init.uploadId, index: 1, ...chunk }))
                    .toMatchObject({ success: false });
                expect(await invoke(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_FINALIZE, { uploadId: init.uploadId }))
                    .toMatchObject({ success: false });
                await refuseForeign(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_ABORT, { uploadId: abortable.uploadId });
                expect(await invoke(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_ABORT, { uploadId: abortable.uploadId }))
                    .toMatchObject({ success: true });
                const recipient = createTransferRecipientKeyPair();
                const downloadRequest = {
                    t: 'session_attachment_download_v1', attachmentHandle: handle,
                    recipientPublicKeyBase64: recipient.recipientPublicKeyBase64,
                };
                await refuseForeign(RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_INIT, downloadRequest);
                const download = await invoke(RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_INIT, downloadRequest);
                expect(download).toMatchObject({ success: true, sizeBytes: bytes.length });
                await refuseForeign(RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_CHUNK, { downloadId: download.downloadId, index: 0 });
                const downloaded = await invoke(RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_CHUNK, { downloadId: download.downloadId, index: 0 });
                expect(downloaded).toMatchObject({ success: true, isLast: true });
                expect(decryptEncryptedTransferChunkEnvelope({ transferId: download.downloadId, sequence: 0,
                    payloadBase64: downloaded.payloadBase64, encryptedDataKeyEnvelopeBase64: downloaded.encryptedDataKeyEnvelopeBase64,
                    recipientSecretKeySeed: recipient.recipientSecretKeySeed })).toEqual(bytes);
                await refuseForeign(RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_FINALIZE, { downloadId: download.downloadId });
                expect(await invoke(RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_FINALIZE, { downloadId: download.downloadId }))
                    .toMatchObject({ success: true });
                expect(await invoke(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT, request))
                    .toMatchObject({ errorCode: 'agent_isolation_unavailable', effectAttempted: false });
                // The retained native channel serves upload and preview; a
                // withdrawn runtime must not reopen it for a new upload.
                expect(opens).toBe(2);
            } finally { await registration.dispose(); }
            expect(closed).toBe(true);
        });
    });
});
