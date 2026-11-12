import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { sessionAttachmentsUploadFile, type AttachmentsUploadConfig } from './uploadSessionAttachment';
import type { SessionAttachmentTransferContext, SessionAttachmentsUploadFinalizeResponse } from '../runtime/transferRuntime/families/sessionAttachmentTransfers';
import { isTransferFinalizeRecoveryFailure } from '../runtime/transferRuntime/plumbing/directTransferFinalizeRecovery';
import { createTransferRecipientKeyPair, decryptEncryptedTransferChunkEnvelope } from '../runtime/transferRuntime/plumbing/transferChunkEncryption';
import { uploadAttachmentDraftsToSession } from '@/components/sessions/attachments/uploadAttachmentDraftsToSession';
import { classifyTransferFailure } from '../runtime/transferRuntime/plumbing/transferFailureCode';
import { describeUploadFailure } from '@/components/transfers/describeUploadFailure';
import { t } from '@/text';
import { readRpcErrorCode } from '@/sync/runtime/rpcErrors';

const nativeOpenSpy = vi.hoisted(() => vi.fn());
const nativeCloseSpy = vi.hoisted(() => vi.fn());

// Expo's native file handle is the device boundary. The source reader stays real.
function createNativeFileModule() {
    class File {
        constructor(readonly uri: string) {}
        open() {
            nativeOpenSpy();
            const bytes = new TextEncoder().encode('hello');
            return {
                offset: 0,
                size: this.uri.includes('unknown') ? null : bytes.length,
                readBytes(length: number) {
                    const chunk = bytes.slice(this.offset, this.offset + length);
                    this.offset += chunk.length;
                    return chunk;
                },
                close: () => nativeCloseSpy(),
            };
        }
    }
    return { File };
}
vi.mock('expo-file-system', () => createNativeFileModule());

const config: AttachmentsUploadConfig = {
    uploadLocation: 'workspace',
    workspaceRelativeDir: '.happier/uploads',
    vcsIgnoreStrategy: 'git_info_exclude',
    vcsIgnoreWritesEnabled: true,
    maxFileBytes: 25 * 1024 * 1024,
};
const finalized = {
    success: true as const,
    path: '.happier/uploads/messages/m1/attachment-hello.txt',
    sizeBytes: 5,
    sha256: 'h1',
    attachmentHandle: { v: 1 as const, sessionId: 's1', id: 'attachment-1' },
};

function webFile(): File {
    return Object.assign(new Blob(['hello'], { type: 'text/plain' }), {
        name: 'hello.txt', lastModified: 0, webkitRelativePath: '',
    });
}

function createSessionTransport() {
    const recipient = createTransferRecipientKeyPair();
    const uploadedBytes: number[] = [];
    const finalize = vi.fn(async (): Promise<unknown> => finalized);
    // This session-bound call is the network edge; encryption, chunking,
    // progress, source custody and finalize recovery run through real owners.
    const call = vi.fn(async (method: string, request: unknown): Promise<unknown> => {
        if (method === RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT) {
            return {
                success: true, uploadId: 'upload-1', chunkSizeBytes: 2,
                recipientPublicKeyBase64: recipient.recipientPublicKeyBase64,
                expiresAt: Date.now() + 60_000,
            };
        }
        if (method === RPC_METHODS.DAEMON_TRANSFER_UPLOAD_CHUNK) {
            const chunk = request as {
                uploadId: string; index: number; payloadBase64: string; encryptedDataKeyEnvelopeBase64: string;
            };
            uploadedBytes.push(...await decryptEncryptedTransferChunkEnvelope({
                transferId: chunk.uploadId, sequence: chunk.index,
                payloadBase64: chunk.payloadBase64,
                encryptedDataKeyEnvelopeBase64: chunk.encryptedDataKeyEnvelopeBase64,
                recipientSecretKeySeed: recipient.recipientSecretKeySeed,
            }));
            return { success: true };
        }
        if (method === RPC_METHODS.DAEMON_TRANSFER_UPLOAD_FINALIZE) return await finalize();
        if (method === RPC_METHODS.DAEMON_TRANSFER_UPLOAD_ABORT) return { success: true };
        throw new Error(`Unexpected session transfer method: ${method}`);
    });
    const transferContext: SessionAttachmentTransferContext = {
        kind: 'sessionBound', sessionId: 's1',
        // The generic transport response is decoded by the real transfer owner.
        call: async <T>(method: string, request: unknown): Promise<T> => await call(method, request) as T,
    };
    return { transferContext, call, finalize, uploadedBytes };
}

describe('uploadSessionAttachment', () => {
    it.each([
        ['oversized file', 'tooLarge'], ['oversized folder', 'tooLarge'],
        ['unknown size', 'sourceUnavailable'], ['invalid path', 'sourceUnavailable'],
        ['invalid Session context', 'sessionUnavailable'],
        ['receiver size limit', 'tooLarge'],
    ] as const)('keeps an %s refusal actionable in the attachment draft', async (kind, reason) => {
        const transport = createSessionTransport();
        if (kind === 'receiver size limit') transport.call.mockResolvedValue({
            success: false, error: 'File exceeds the server-routed transfer size limit', errorCode: 'attachment_too_large',
        });
        const file = { kind: 'memory' as const, name: 'note.txt', bytes: new Uint8Array(kind.startsWith('oversized') ? 5 : 1) };
        const source = kind === 'unknown size'
            ? { kind: 'native' as const, uri: 'file:///tmp/unknown.txt', name: 'unknown.txt', sizeBytes: null }
            : kind === 'oversized folder' || kind === 'invalid path'
                ? { kind: 'folder' as const, name: 'project', mimeType: 'inode/directory' as const,
                    entries: [{ relativePath: kind === 'invalid path' ? '../note.txt' : 'note.txt', source: file }] }
                : file;
        const applyDraftPatch = vi.fn();
        const failure: unknown = await uploadAttachmentDraftsToSession({
            sessionId: 's1', messageLocalId: 'm1', transferContext: kind === 'invalid Session context'
                ? { ...transport.transferContext, sessionId: 'other' } : transport.transferContext,
            drafts: [{ id: 'draft', source, status: 'pending' }],
            config: { ...config, maxFileBytes: 4 }, applyDraftPatch,
        }).catch((error: unknown) => error);

        expect(classifyTransferFailure({ errorCode: readRpcErrorCode(failure), thrown: failure })).toBe(reason);
        expect(applyDraftPatch).toHaveBeenLastCalledWith('draft', expect.objectContaining({
            status: 'error', error: describeUploadFailure(reason, t('common.machine')),
        }));
        if (kind === 'receiver size limit') expect(transport.finalize).not.toHaveBeenCalled();
        else expect(transport.call).not.toHaveBeenCalled();
    });

    it.each(['web', 'native'] as const)('uploads a %s folder through the same owner without applying the file limit to the whole folder', async (kind) => {
        const transport = createSessionTransport();
        const paths: string[] = [];
        transport.call.mockImplementation(async (method, raw) => {
            const request = raw as Record<string, unknown>;
            if (method === RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT) {
                expect(request).toMatchObject({ uploadLocation: 'workspace', workspaceRelativeDir: '.happier/uploads',
                    vcsIgnoreStrategy: 'git_info_exclude', vcsIgnoreWritesEnabled: true });
                paths.push(String(request.relativePath));
                if (request.relativePath === 'draft-folder/project') expect(request.directoryEntries).toEqual(['empty']);
                return { success: true, uploadId: 'folder-upload', chunkSizeBytes: 8,
                    recipientPublicKeyBase64: createTransferRecipientKeyPair().recipientPublicKeyBase64 };
            }
            if (method === RPC_METHODS.DAEMON_TRANSFER_UPLOAD_FINALIZE) {
                return { ...finalized, path: `.happier/uploads/messages/m1/${paths.at(-1)}` };
            }
            return { success: true };
        });
        const request = {
            sessionId: 's1', transferContext: transport.transferContext, messageLocalId: 'm1',
            config: { ...config, maxFileBytes: 5 },
            file: { kind: 'folder', name: 'project', mimeType: 'inode/directory', directories: ['empty'], entries: [
                { relativePath: 'a.txt', source: kind === 'web' ? { kind: 'web', file: webFile() }
                    : { kind: 'native', uri: 'file:///cache/a.txt', name: 'a.txt', sizeBytes: 5, mimeType: 'text/plain' } },
                { relativePath: 'nested/b.txt', source: kind === 'web' ? { kind: 'web', file: webFile() }
                    : { kind: 'native', uri: 'file:///cache/b.txt', name: 'b.txt', sizeBytes: 5, mimeType: 'text/plain' } },
            ] },
            attachmentId: 'draft-folder',
        } satisfies Parameters<typeof sessionAttachmentsUploadFile>[0];
        const { uploadAttachmentDraftsToSession } = await import('@/components/sessions/attachments/uploadAttachmentDraftsToSession');
        const run = () => uploadAttachmentDraftsToSession({ sessionId: request.sessionId, transferContext: request.transferContext,
            config: request.config, messageLocalId: request.messageLocalId,
            drafts: [{ id: 'draft-folder', source: request.file, status: 'pending' }], applyDraftPatch: () => {} });
        const [result, concurrent] = await Promise.all([run(), run()]);
        expect(paths).toEqual(['draft-folder/project/a.txt', 'draft-folder/project/nested/b.txt', 'draft-folder/project']);
        expect(result.uploaded).toEqual([expect.objectContaining({ id: 'draft-folder', name: 'project', mimeType: 'inode/directory',
            path: '.happier/uploads/messages/m1/draft-folder/project', sizeBytes: 10 })]);
        expect(concurrent).toEqual(result);
    });
    it('keeps folder recovery actionable across multiple file and directory finalizations', async () => {
        const transport = createSessionTransport();
        const paths = new Map<string, string>();
        const attempts = new Set<string>();
        transport.call.mockImplementation(async (method, raw) => {
            const request = raw as Record<string, unknown>;
            if (method === RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT) {
                const id = String(paths.size);
                paths.set(id, String(request.relativePath));
                return { success: true, uploadId: id, chunkSizeBytes: 8, expiresAt: Date.now() + 60_000,
                    recipientPublicKeyBase64: createTransferRecipientKeyPair().recipientPublicKeyBase64 };
            }
            if (method === RPC_METHODS.DAEMON_TRANSFER_UPLOAD_FINALIZE) {
                const id = String(request.uploadId);
                if (!attempts.has(id)) { attempts.add(id); return { success: false,
                    error: 'Commit needs confirmation', errorCode: 'TRANSFER_FINALIZE_RECOVERY_REQUIRED' }; }
                return { ...finalized, path: `.uploads/messages/m1/${paths.get(id)}`, sizeBytes: paths.get(id)?.endsWith('.txt') ? 5 : 0 };
            }
            return { success: true };
        });
        const result = await sessionAttachmentsUploadFile({ sessionId: 's1', transferContext: transport.transferContext,
            messageLocalId: 'm1', attachmentId: 'folder-draft', config,
            file: { kind: 'folder', name: 'project', mimeType: 'inode/directory', entries: [
                { relativePath: 'a.txt', source: { kind: 'web', file: webFile() } },
                { relativePath: 'b.txt', source: { kind: 'web', file: webFile() } },
            ] } });
        if (!isTransferFinalizeRecoveryFailure<SessionAttachmentsUploadFinalizeResponse>(result)) throw new Error('Expected folder recovery');
        expect(await result.recovery.invoke('retry_finalize')).toMatchObject({ status: 'recovery_required' });
        expect(result.recovery.isActionable()).toBe(true);
        expect(await result.recovery.invoke('retry_finalize')).toMatchObject({ status: 'recovery_required' });
        expect(result.recovery.isActionable()).toBe(true);
        expect(await result.recovery.invoke('retry_finalize')).toMatchObject({ status: 'finalized', response: {
            path: '.uploads/messages/m1/folder-draft/project', sizeBytes: 10,
        } });
        expect(result.recovery.isActionable()).toBe(false);
    });
    beforeEach(() => {
        nativeOpenSpy.mockClear();
        nativeCloseSpy.mockClear();
    });
    afterEach(() => {
        vi.useRealTimers();
        vi.doMock('expo-file-system', () => createNativeFileModule());
    });

    it('uploads a file through the canonical attachment upload init and returns the finalized path', async () => {
        const transport = createSessionTransport();
        const result = await sessionAttachmentsUploadFile({
            sessionId: 's1', transferContext: transport.transferContext,
            file: { kind: 'web', file: webFile() }, messageLocalId: 'm1', config,
        });
        expect(transport.call).toHaveBeenCalledWith(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT, {
            t: 'session_attachment_upload_v1', sessionId: 's1', messageLocalId: 'm1',
            fileName: 'hello.txt', sizeBytes: 5, uploadLocation: config.uploadLocation,
            workspaceRelativeDir: config.workspaceRelativeDir,
            vcsIgnoreStrategy: config.vcsIgnoreStrategy, vcsIgnoreWritesEnabled: config.vcsIgnoreWritesEnabled,
        });
        expect(transport.uploadedBytes).toEqual([...new TextEncoder().encode('hello')]);
        expect(result).toEqual(finalized);
    });

    it('calls onProgress after each uploaded chunk', async () => {
        const transport = createSessionTransport();
        const onProgress = vi.fn();
        const result = await sessionAttachmentsUploadFile({
            sessionId: 's1', transferContext: transport.transferContext,
            file: { kind: 'web', file: webFile() }, messageLocalId: 'm1', config, onProgress,
        });
        expect(result).toEqual(finalized);
        expect(onProgress.mock.calls.map(([progress]) => progress)).toEqual([
            { uploadedBytes: 2, totalBytes: 5 },
            { uploadedBytes: 4, totalBytes: 5 },
            { uploadedBytes: 5, totalBytes: 5 },
        ]);
    });

    it('refuses an already cancelled upload before opening a native source or reaching the transport', async () => {
        const transport = createSessionTransport();
        const controller = new AbortController();
        controller.abort();
        const result = await sessionAttachmentsUploadFile({
            sessionId: 's1', transferContext: transport.transferContext, signal: controller.signal,
            file: { kind: 'native', uri: 'file:///tmp/hello.txt', name: 'hello.txt', sizeBytes: 5 },
            messageLocalId: 'm1', config,
        });
        expect(result).toMatchObject({ success: false });
        expect(nativeOpenSpy).not.toHaveBeenCalled();
        expect(transport.call).not.toHaveBeenCalled();
    });

    it('stops after cancellation between chunks and closes the native source without finalizing', async () => {
        const transport = createSessionTransport();
        const controller = new AbortController();
        const result = await sessionAttachmentsUploadFile({
            sessionId: 's1', transferContext: transport.transferContext, signal: controller.signal,
            file: { kind: 'native', uri: 'file:///tmp/hello.txt', name: 'hello.txt', sizeBytes: 5 },
            messageLocalId: 'm1', config, onProgress: () => controller.abort(),
        });
        expect(result).toMatchObject({ success: false });
        expect(transport.uploadedBytes).toHaveLength(2);
        expect(transport.finalize).not.toHaveBeenCalled();
        expect(nativeCloseSpy).toHaveBeenCalledTimes(1);
    });

    it('uploads a native file through the canonical attachment upload init and closes the native handle', async () => {
        const transport = createSessionTransport();
        const result = await sessionAttachmentsUploadFile({
            sessionId: 's1', transferContext: transport.transferContext,
            file: { kind: 'native', uri: 'file:///tmp/hello.txt', name: 'hello.txt', sizeBytes: 5 },
            messageLocalId: 'm1', config,
        });
        expect(result).toEqual(finalized);
        expect(transport.uploadedBytes).toEqual([...new TextEncoder().encode('hello')]);
        expect(nativeOpenSpy).toHaveBeenCalledTimes(1);
        expect(nativeCloseSpy).toHaveBeenCalledTimes(1);
    });

    it('closes the native file handle when the session upload transport rejects', async () => {
        const transport = createSessionTransport();
        transport.call.mockRejectedValueOnce(new Error('Upload transport interrupted'));
        const result = await sessionAttachmentsUploadFile({
            sessionId: 's1', transferContext: transport.transferContext,
            file: { kind: 'native', uri: 'file:///tmp/hello.txt', name: 'hello.txt', sizeBytes: 5 },
            messageLocalId: 'm1', config,
        });
        expect(result).toMatchObject({ success: false, error: 'Upload transport interrupted' });
        expect(nativeOpenSpy).toHaveBeenCalledTimes(1);
        expect(nativeCloseSpy).toHaveBeenCalledTimes(1);
    });

    it('preserves the opaque finalize recovery continuation after closing the source', async () => {
        const transport = createSessionTransport();
        transport.finalize.mockResolvedValueOnce({
            success: false, error: 'Destination unavailable', errorCode: 'TRANSFER_FINALIZE_RECOVERY_REQUIRED',
        });
        const result = await sessionAttachmentsUploadFile({
            sessionId: 's1', transferContext: transport.transferContext,
            file: { kind: 'native', uri: 'file:///tmp/hello.txt', name: 'hello.txt', sizeBytes: 5 },
            messageLocalId: 'm1', config,
        });
        if (!isTransferFinalizeRecoveryFailure(result)) throw new Error('Expected actionable transfer recovery');
        expect(result.recovery.isActionable()).toBe(true);
        expect(nativeCloseSpy).toHaveBeenCalledTimes(1);
        expect(transport.call.mock.calls.some(([method]) => method === RPC_METHODS.DAEMON_TRANSFER_UPLOAD_ABORT)).toBe(false);
        expect(await result.recovery.invoke('retry_finalize')).toEqual({ status: 'finalized', response: finalized });
        expect(result.recovery.isActionable()).toBe(false);
        expect(nativeOpenSpy).toHaveBeenCalledTimes(1);
        expect(nativeCloseSpy).toHaveBeenCalledTimes(1);
    });

    it('fails when the attachment size cannot be resolved', async () => {
        const transport = createSessionTransport();
        const result = await sessionAttachmentsUploadFile({
            sessionId: 's1', transferContext: transport.transferContext,
            file: { kind: 'native', uri: 'file:///tmp/unknown.txt', name: 'unknown.txt', sizeBytes: null },
            messageLocalId: 'm1', config,
        });
        expect(result).toEqual({ success: false, error: 'Unknown attachment size', errorCode: 'attachment_source_unavailable' });
        expect(transport.call).not.toHaveBeenCalled();
        expect(nativeCloseSpy).toHaveBeenCalledTimes(1);
    });

    it('reports native size acquisition failure before opening a transfer', async () => {
        vi.doMock('expo-file-system', () => ({ File: class { constructor() { throw new Error('Native source unavailable'); } } }));
        const transport = createSessionTransport();
        expect(await sessionAttachmentsUploadFile({
            sessionId: 's1', transferContext: transport.transferContext,
            file: { kind: 'native', uri: 'file:///tmp/hello.txt', name: 'hello.txt', sizeBytes: null },
            messageLocalId: 'm1', config,
        })).toEqual({ success: false, error: 'Native source unavailable', errorCode: 'attachment_source_unavailable' });
        expect(transport.call).not.toHaveBeenCalled();
    });

    it('waits for native size resolution without a phase timeout and uploads once', async () => {
        vi.useFakeTimers();
        let resolveNativeModule!: (module: ReturnType<typeof createNativeFileModule>) => void;
        const nativeModule = new Promise<ReturnType<typeof createNativeFileModule>>((resolve) => { resolveNativeModule = resolve; });
        // The native module loader is the device boundary; source resolution remains real.
        vi.doMock('expo-file-system', () => nativeModule);
        const transport = createSessionTransport();
        let settled = false;
        const result = sessionAttachmentsUploadFile({
            sessionId: 's1', transferContext: transport.transferContext,
            file: { kind: 'native', uri: 'file:///tmp/hello.txt', name: 'hello.txt', sizeBytes: null },
            messageLocalId: 'm1', config,
        }).then(value => { settled = true; return value; });
        await vi.advanceTimersByTimeAsync(20_001);
        expect(settled).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
        expect(transport.call).not.toHaveBeenCalled();
        resolveNativeModule(createNativeFileModule());
        expect(await result).toMatchObject(finalized);
        expect(transport.finalize).toHaveBeenCalledTimes(1);
        expect(transport.uploadedBytes).toEqual([...new TextEncoder().encode('hello')]);
        expect(nativeCloseSpy).toHaveBeenCalledTimes(2);
    });

    it('fails when the attachment exceeds the configured maximum size', async () => {
        const transport = createSessionTransport();
        const result = await sessionAttachmentsUploadFile({
            sessionId: 's1', transferContext: transport.transferContext,
            file: { kind: 'web', file: webFile() }, messageLocalId: 'm1', config: { ...config, maxFileBytes: 4 },
        });
        expect(result).toEqual({ success: false, error: 'File exceeds maximum allowed size', errorCode: 'attachment_too_large' });
        expect(transport.call).not.toHaveBeenCalled();
    });
});
