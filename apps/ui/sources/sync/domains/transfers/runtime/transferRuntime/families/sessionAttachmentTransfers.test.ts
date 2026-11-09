import { describe, expect, it, vi } from 'vitest';
import { deriveBoxPublicKeyFromSeed } from '@happier-dev/protocol/crypto/boxBundle';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createSessionAttachmentTransferRouting, downloadDaemonSessionAttachmentToDestination, uploadDaemonSessionAttachmentFromReader } from './sessionAttachmentTransfers';
import { createEncryptedTransferChunkEnvelope } from '../plumbing/transferChunkEncryption';
import { isTransferFinalizeRecoveryFailure } from '../plumbing/directTransferFinalizeRecovery';

describe('session-bound attachment carrier', () => {
    it.each(['upload', 'download'] as const)('settles cancelled %s while Account-owned abort cleanup awaits a late outcome', async direction => {
        const cancellation = new AbortController();
        let completeCleanup!: () => void;
        let cleanedLocally = false;
        let stallCleanup = true;
        const call = async <T>(method: string, _request: unknown, signal?: AbortSignal | null): Promise<T> => {
            if (method === RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT || method === RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_INIT) {
                if (stallCleanup) cancellation.abort();
                return { success: true, uploadId: 'upload-a', downloadId: 'download-a', sizeBytes: 0, name: 'notes.txt', chunkSizeBytes: 2,
                    recipientPublicKeyBase64: Buffer.from(deriveBoxPublicKeyFromSeed(new Uint8Array(32).fill(7))).toString('base64') } as T;
            }
            if (method === RPC_METHODS.DAEMON_TRANSFER_UPLOAD_ABORT || method === RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_ABORT) {
                // The captured Session context owns Account retirement. The
                // cancelled transfer must not stop that independent cleanup.
                expect(signal?.aborted).not.toBe(true);
                return await new Promise<T>((resolve, reject) => {
                    completeCleanup = () => direction === 'upload' ? resolve({ success: true } as T) : reject(new Error('Late cleanup unavailable'));
                });
            }
            return { success: true, path: 'notes.txt', sizeBytes: 0, sha256: 'hash',
                attachmentHandle: { v: 1, sessionId: 'session-a', id: 'attachment-a' } } as T;
        };
        const transferContext = { kind: 'sessionBound', sessionId: 'session-a', call } as const;
        const upload = (signal: AbortSignal) => uploadDaemonSessionAttachmentFromReader({ sessionId: 'session-a', transferContext, signal,
            fileReader: { sizeBytes: 0, readBytes: async () => new Uint8Array(), close: async () => { cleanedLocally = true; } },
            request: { messageLocalId: 'message-a', fileName: 'notes.txt', sizeBytes: 0, uploadLocation: 'workspace',
                workspaceRelativeDir: '.happier/attachments', vcsIgnoreStrategy: 'none', vcsIgnoreWritesEnabled: false } });
        const pending = direction === 'upload' ? upload(cancellation.signal) : downloadDaemonSessionAttachmentToDestination({
            transferContext, signal: cancellation.signal, attachmentHandle: { v: 1, sessionId: 'session-a', id: 'attachment-a' },
            destination: { writeBytes: async () => {}, close: async () => { cleanedLocally = true; } },
        });
        let settled = false;
        void pending.then(() => { settled = true; });
        try {
            await vi.waitFor(() => expect(completeCleanup).toBeTypeOf('function'));
            await vi.waitFor(() => expect(settled).toBe(true));
            await expect(pending).resolves.toMatchObject(direction === 'upload' ? { success: false } : { ok: false });
            expect(cleanedLocally).toBe(true);
            completeCleanup();
            stallCleanup = false;
            await expect(upload(new AbortController().signal)).resolves.toMatchObject({ success: true });
        } finally { completeCleanup?.(); await pending; }
    });

    it.each(['retry_finalize', 'discard_staged'] as const)('cancels a nonreplying recovery %s and keeps the staged upload retryable', async (action) => {
        let finalizeCalls = 0;
        let stallRecovery = true;
        let staged = true;
        let recoverySignal: AbortSignal | null | undefined;
        const uploadController = new AbortController();
        // Genuine Session RPC boundary; the upload and continuation lifecycle remain real.
        const call = async <T>(method: string, _request: unknown, signal?: AbortSignal | null): Promise<T> => {
            if (method === RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT) return {
                success: true, uploadId: 'upload-a', chunkSizeBytes: 2, expiresAt: 1234,
                recipientPublicKeyBase64: Buffer.from(deriveBoxPublicKeyFromSeed(new Uint8Array(32).fill(7))).toString('base64'),
            } as T;
            if (method === RPC_METHODS.DAEMON_TRANSFER_UPLOAD_FINALIZE && finalizeCalls++ === 0) return {
                success: false, error: 'Destination unavailable', errorCode: 'TRANSFER_FINALIZE_RECOVERY_REQUIRED', expiresAt: 1234,
            } as T;
            if (stallRecovery) {
                recoverySignal = signal;
                return await new Promise<T>((_resolve, reject) => {
                    if (signal?.aborted) reject(signal.reason);
                    else signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
                });
            }
            staged = false;
            return { success: true, path: 'notes.txt', sizeBytes: 0, sha256: 'hash',
                attachmentHandle: { v: 1, sessionId: 'session-a', id: 'attachment-a' } } as T;
        };
        const uploaded = await uploadDaemonSessionAttachmentFromReader({
            sessionId: 'session-a', transferContext: { kind: 'sessionBound', sessionId: 'session-a', call },
            signal: uploadController.signal,
            fileReader: { sizeBytes: 0, readBytes: async () => new Uint8Array(), close: async () => {} },
            request: { messageLocalId: 'message-a', fileName: 'notes.txt', sizeBytes: 0, uploadLocation: 'workspace',
                workspaceRelativeDir: '.happier/attachments', vcsIgnoreStrategy: 'none', vcsIgnoreWritesEnabled: false },
        });
        if (!isTransferFinalizeRecoveryFailure(uploaded)) throw new Error('Expected actionable recovery');
        // The failed transfer lifetime may already have ended. Recovery belongs
        // to the new explicit user request, not that retired transfer.
        uploadController.abort();
        const observer = new AbortController();
        const pending = uploaded.recovery.invoke(action, observer.signal);
        await vi.waitFor(() => expect(recoverySignal).toBe(observer.signal));
        observer.abort(new Error('Recovery view retired'));
        await expect(pending).resolves.toMatchObject({ status: 'unavailable' });
        expect(staged).toBe(true);
        expect(uploaded.recovery.isActionable()).toBe(true);
        stallRecovery = false;
        await expect(uploaded.recovery.invoke(action, new AbortController().signal)).resolves.toMatchObject({
            status: action === 'retry_finalize' ? 'finalized' : 'discarded',
        });
        expect(staged).toBe(false);
        expect(uploaded.recovery.isActionable()).toBe(false);
    });

    it('previews a handle using the encrypted download loop without sending a filesystem path', async () => {
        let recipientPublicKeyBase64 = '';
        let downloadOpen = false;
        const bytes = new Uint8Array([1, 2, 3]);
        const downloaded: number[] = [];
        const handle = { v: 1 as const, sessionId: 'session-a', id: 'attachment-a' };
        // Genuine network boundary; the transfer encryption and destination logic remain real.
        const call = async <T>(method: string, request: unknown): Promise<T> => {
            const routing = createSessionAttachmentTransferRouting('session-a', method);
            expect(routing.t).toBe('session_attachment_download_v1');
            if (method === RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_INIT) {
                expect(request).toMatchObject({ t: 'session_attachment_download_v1', attachmentHandle: handle });
                expect(request).not.toHaveProperty('path');
                recipientPublicKeyBase64 = (request as { recipientPublicKeyBase64: string }).recipientPublicKeyBase64;
                downloadOpen = true;
                return { success: true, downloadId: 'download-a', chunkSizeBytes: 3, sizeBytes: 3, name: 'notes.png' } as T;
            }
            if (method === RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_CHUNK) {
                return { success: true, isLast: true, ...await createEncryptedTransferChunkEnvelope({
                    transferId: 'download-a', sequence: 0, payload: bytes, recipientPublicKeyBase64,
                }) } as T;
            }
            downloadOpen = false;
            return { success: true } as T;
        };
        const result = await downloadDaemonSessionAttachmentToDestination({
            transferContext: { kind: 'sessionBound', sessionId: 'session-a', call }, attachmentHandle: handle,
            destination: { writeBytes: async (chunk) => { downloaded.push(...chunk); }, close: async () => {} },
        });
        expect(result).toMatchObject({ ok: true, sizeBytes: bytes.length, name: 'notes.png' });
        expect(downloaded).toEqual([...bytes]);
        expect(downloadOpen).toBe(false);
    });

    it('retains staged upload custody for explicit finalize recovery', async () => {
        let staged = false;
        let recoveryRequired = true;
        let readerClosed = false;
        const call = async <T>(method: string): Promise<T> => {
            expect(createSessionAttachmentTransferRouting('session-a', method).t).toBe('session_attachment_upload_v1');
            if (method === RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT) {
                staged = true;
                return { success: true, uploadId: 'upload-a', chunkSizeBytes: 2, expiresAt: 1234,
                    recipientPublicKeyBase64: Buffer.from(deriveBoxPublicKeyFromSeed(new Uint8Array(32).fill(7))).toString('base64') } as T;
            }
            if (method === RPC_METHODS.DAEMON_TRANSFER_UPLOAD_FINALIZE && recoveryRequired) {
                recoveryRequired = false;
                return { success: false, error: 'Destination unavailable', errorCode: 'TRANSFER_FINALIZE_RECOVERY_REQUIRED', expiresAt: 1234 } as T;
            }
            staged = false;
            return { success: true, path: 'notes.txt', sizeBytes: 0, sha256: 'hash',
                attachmentHandle: { v: 1, sessionId: 'session-a', id: 'attachment-a' } } as T;
        };
        const result = await uploadDaemonSessionAttachmentFromReader({
            sessionId: 'session-a', transferContext: { kind: 'sessionBound', sessionId: 'session-a', call },
            fileReader: { sizeBytes: 0, readBytes: async () => new Uint8Array(), close: async () => { readerClosed = true; } },
            request: { messageLocalId: 'message-a', fileName: 'notes.txt', sizeBytes: 0, uploadLocation: 'workspace',
                workspaceRelativeDir: '.happier/attachments', vcsIgnoreStrategy: 'none', vcsIgnoreWritesEnabled: false },
        });
        expect(readerClosed).toBe(true);
        expect(staged).toBe(true);
        if (!isTransferFinalizeRecoveryFailure(result)) throw new Error('Expected actionable transfer recovery');
        expect(await result.recovery.invoke('retry_finalize')).toMatchObject({ status: 'finalized', response: { attachmentHandle: { id: 'attachment-a' } } });
        expect(result.recovery.isActionable()).toBe(false);
        expect(staged).toBe(false);
    });

    it('uploads without machine state and retries an interrupted chunk through the same owner', async () => {
        let interrupted = true;
        let closed = 0;
        const methods: string[] = [];
        const call = async <T>(method: string, request: unknown): Promise<T> => {
            methods.push(method);
            if (method === RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT) {
                expect(request).toMatchObject({ t: 'session_attachment_upload_v1' });
                expect(request).not.toHaveProperty('workingDirectory');
                return { success: true, uploadId: 'upload-a', chunkSizeBytes: 2,
                    recipientPublicKeyBase64: Buffer.from(deriveBoxPublicKeyFromSeed(new Uint8Array(32).fill(7))).toString('base64') } as T;
            }
            if (method === RPC_METHODS.DAEMON_TRANSFER_UPLOAD_CHUNK && interrupted) {
                interrupted = false;
                throw new Error('connection interrupted');
            }
            if (method === RPC_METHODS.DAEMON_TRANSFER_UPLOAD_FINALIZE) {
                return { success: true, path: '/session/notes.txt', sizeBytes: 3, sha256: 'hash',
                    attachmentHandle: { v: 1, sessionId: 'session-a', id: 'attachment-a' } } as T;
            }
            return { success: true } as T;
        };
        const upload = () => uploadDaemonSessionAttachmentFromReader({
            sessionId: 'session-a',
            transferContext: { kind: 'sessionBound', sessionId: 'session-a', call },
            fileReader: { sizeBytes: 3, readBytes: async (offset, length) => new Uint8Array([1, 2, 3]).slice(offset, offset + length), close: async () => { closed++; } },
            request: { messageLocalId: 'message-a', fileName: 'notes.txt', sizeBytes: 3, uploadLocation: 'workspace',
                workspaceRelativeDir: '.happier/attachments', vcsIgnoreStrategy: 'none', vcsIgnoreWritesEnabled: false },
        });
        await expect(upload()).rejects.toThrow('connection interrupted');
        expect(await upload()).toMatchObject({ success: true, attachmentHandle: { sessionId: 'session-a' } });
        expect(closed).toBe(2);
        expect(methods).toContain(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_ABORT);
    });
});
