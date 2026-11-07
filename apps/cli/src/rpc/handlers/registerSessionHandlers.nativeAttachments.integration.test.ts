import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SessionAttachmentHandleV1Schema } from '@happier-dev/protocol/transfers/sessions/sessionAttachmentHandleV1';
import { createEncryptedTransferChunkEnvelope, createTransferRecipientKeyPair } from '@happier-dev/transfers/node';
import type { RpcHandler } from '@/api/rpc/types';
import { withTempDir } from '@/testkit/fs/tempDir';
import { runFilesystemEffectInternal } from './fileSystem/filesystemEffectInternal';
import { createFilesystemEffectChannel, initializeFilesystemEffectChannel } from './fileSystem/filesystemEffectChannel';
import type { SessionAttachmentNativeRuntime } from './fileSystem/sessionAttachmentIntake';
import { registerSessionHandlers } from './registerSessionHandlers';

describe('Session native attachment registration', () => {
    it('retries a failed native open and retains transfer and transcript custody after runtime release', async () => {
        await withTempDir('session-native-intake-', async root => {
            let opens = 0;
            let closed = false;
            // Only native process pipes are replaced. Dispatch, encrypted chunks,
            // filesystem policy, issuance and transcript projection are real owners.
            const native: SessionAttachmentNativeRuntime = {
                workingDirectory: root,
                requester: { sessionId: 'session-a', homeServerIdentityId: 'home-a', identity: {
                    kind: 'isolated', separationRequired: true, requester: {
                        serverId: 'profile-a', accountId: 'member-a', machineId: 'machine-a', installationId: 'installation-a',
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
            const handlers = new Map<string, RpcHandler>();
            const registration = registerSessionHandlers({ registerHandler(method, handler) { handlers.set(method, handler); } }, '/owner-workspace', {
                sessionId: 'session-a', readSessionAttachmentNativeRuntime: () => currentRuntime,
            });
            const invoke = async (method: string, input: unknown) => {
                const handler = handlers.get(method);
                if (!handler) throw new Error('Missing Session attachment handler');
                return await handler(input);
            };
            try {
                const bytes = Buffer.from('member attachment');
                const request = {
                    t: 'session_attachment_upload_v1', sessionId: 'session-a', messageLocalId: 'message-a',
                    fileName: 'notes.txt', sizeBytes: bytes.length, uploadLocation: 'os_temp',
                    workspaceRelativeDir: '.happier/attachments', vcsIgnoreStrategy: 'none', vcsIgnoreWritesEnabled: false,
                };
                await expect(invoke(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT, request)).rejects.toThrow('Synthetic native open failure');
                const init = await invoke(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT, request);
                expect(init).toMatchObject({ success: true });
                expect(opens).toBe(2);
                // Releasing the launcher cannot move an admitted transfer back
                // to daemon-user IO; the successful channel keeps its custody.
                currentRuntime = null;
                const chunk = createEncryptedTransferChunkEnvelope({ transferId: init.uploadId, sequence: 0,
                    payload: bytes, recipientPublicKeyBase64: init.recipientPublicKeyBase64 });
                expect(await invoke(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_CHUNK, { uploadId: init.uploadId, index: 0, ...chunk }))
                    .toMatchObject({ success: true });
                const finalized = await invoke(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_FINALIZE, { uploadId: init.uploadId });
                expect(finalized).toMatchObject({ success: true });
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
                expect(await invoke(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_ABORT, { uploadId: init.uploadId }))
                    .toMatchObject({ success: true });
                const recipient = createTransferRecipientKeyPair();
                expect(await invoke(RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_INIT, {
                    t: 'session_attachment_download_v1', attachmentHandle: handle,
                    recipientPublicKeyBase64: recipient.recipientPublicKeyBase64,
                })).toMatchObject({ success: true, sizeBytes: bytes.length });
                expect(opens).toBe(2);
            } finally { await registration.dispose(); }
            expect(closed).toBe(true);
        });
    });
});
