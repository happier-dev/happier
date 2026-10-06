import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { sessionAttachmentsUploadFile, type AttachmentsUploadConfig } from './uploadSessionAttachment';
import type { SessionAttachmentTransferContext } from '../runtime/transferRuntime/families/sessionAttachmentTransfers';
import { isTransferFinalizeRecoveryFailure } from '../runtime/transferRuntime/plumbing/directTransferFinalizeRecovery';
import { createTransferRecipientKeyPair, decryptEncryptedTransferChunkEnvelope } from '../runtime/transferRuntime/plumbing/transferChunkEncryption';

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
    beforeEach(() => {
        nativeOpenSpy.mockClear();
        nativeCloseSpy.mockClear();
    });
    afterEach(() => {
        delete process.env.EXPO_PUBLIC_HAPPIER_FILES_UPLOAD_PREFLIGHT_SIZE_TIMEOUT_MS;
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
        expect(result).toEqual({ success: false, error: 'Unknown attachment size' });
        expect(transport.call).not.toHaveBeenCalled();
        expect(nativeCloseSpy).toHaveBeenCalledTimes(1);
    });

    it('fails closed when native attachment size resolution times out', async () => {
        vi.useFakeTimers();
        process.env.EXPO_PUBLIC_HAPPIER_FILES_UPLOAD_PREFLIGHT_SIZE_TIMEOUT_MS = '100';
        let resolveNativeModule!: (module: ReturnType<typeof createNativeFileModule>) => void;
        const nativeModule = new Promise<ReturnType<typeof createNativeFileModule>>((resolve) => { resolveNativeModule = resolve; });
        // Stall the native module load instead of replacing internal size resolution.
        vi.doMock('expo-file-system', () => nativeModule);
        const transport = createSessionTransport();
        const result = sessionAttachmentsUploadFile({
            sessionId: 's1', transferContext: transport.transferContext,
            file: { kind: 'native', uri: 'file:///tmp/unknown.txt', name: 'unknown.txt', sizeBytes: null },
            messageLocalId: 'm1', config,
        });
        await vi.advanceTimersByTimeAsync(100);
        await expect(result).resolves.toEqual({ success: false, error: 'Upload preflight size resolution timed out' });
        expect(transport.call).not.toHaveBeenCalled();
        resolveNativeModule(createNativeFileModule());
        await vi.waitFor(() => expect(nativeCloseSpy).toHaveBeenCalledTimes(1));
    });

    it('fails when the attachment exceeds the configured maximum size', async () => {
        const transport = createSessionTransport();
        const result = await sessionAttachmentsUploadFile({
            sessionId: 's1', transferContext: transport.transferContext,
            file: { kind: 'web', file: webFile() }, messageLocalId: 'm1', config: { ...config, maxFileBytes: 4 },
        });
        expect(result).toEqual({ success: false, error: 'File exceeds maximum allowed size' });
        expect(transport.call).not.toHaveBeenCalled();
    });
});
