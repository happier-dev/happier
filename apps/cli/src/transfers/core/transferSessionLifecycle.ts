import { createHash } from 'node:crypto';

import { createEncryptedTransferChunkEnvelope, decryptEncryptedTransferChunkEnvelope } from '@/machines/transfer/transferChunkEncryption';
import { writeFileHandleFully } from '@/utils/fs/writeFileHandleFully';

import { decodeUploadChunkBase64 } from './decodeUploadChunkBase64';
import { TransferSessionStore } from './transferSessionStore';
import type { DownloadTransferSource } from '../targets/downloadTransferSource';
import type { UploadTransferFinalizeResult, UploadTransferTarget } from '../targets/uploadTransferTarget';

type UploadSessionHandle = NonNullable<ReturnType<TransferSessionStore['getUploadSession']>>;
type DownloadSessionHandle = NonNullable<ReturnType<TransferSessionStore['getDownloadSession']>>;

const ENCRYPTED_TRANSFER_CHUNK_OVERHEAD_BYTES = 1 + 12 + 16; // version + nonce + auth tag
const DEFAULT_MAX_ENCRYPTED_DATA_KEY_ENVELOPE_BYTES = 16 * 1024;

function estimateBase64DecodedBytes(value: string): number {
    if (value.length === 0) return 0;
    const paddingBytes = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
    return Math.max(0, Math.floor((value.length * 3) / 4) - paddingBytes);
}

function resolveMaxEncodedChars(maxDecodedBytes: number): number {
    const normalizedMaxDecodedBytes = Math.max(0, Math.floor(maxDecodedBytes));
    return Math.ceil(normalizedMaxDecodedBytes / 3) * 4;
}

function getMaxEncryptedDataKeyEnvelopeBytes(value?: number): number {
    return typeof value === 'number' && value > 0
        ? Math.floor(value)
        : DEFAULT_MAX_ENCRYPTED_DATA_KEY_ENVELOPE_BYTES;
}

export type TransferSessionLifecycle = Readonly<{
    openUploadTransferSession<TResult>(input: Readonly<{
        target: UploadTransferTarget<TResult> & Readonly<{ destPath: string }>;
        sha256Expected?: string;
        recipientSecretKeySeed?: Uint8Array;
        recipientPublicKeyBase64?: string;
    }>): Promise<UploadSessionHandle>;
    writeUploadTransferChunk(input: Readonly<{
        uploadId: string;
        index: number;
        contentBase64?: string;
        payloadBase64?: string;
        encryptedDataKeyEnvelopeBase64?: string;
    }>): Promise<Readonly<{ success: true } | { success: false; error: string }>>;
    finalizeUploadTransferSession<TResult>(input: Readonly<{
        uploadId: string;
    }>): Promise<Readonly<
        | { success: true; finalized: Extract<UploadTransferFinalizeResult<unknown>, { success: true }>; sha256: string }
        | Extract<UploadTransferFinalizeResult<unknown>, { success: false }>
    >>;
    abortUploadTransferSession(input: Readonly<{ uploadId: string }>): Promise<Readonly<{ aborted: boolean }>>;
    openDownloadTransferSession(input: Readonly<{
        source: DownloadTransferSource;
        recipientPublicKeyBase64?: string;
    }>): Promise<DownloadSessionHandle>;
    readDownloadTransferChunk(input: Readonly<{
        downloadId: string;
        index: number;
    }>): Promise<Readonly<
        | { success: true; contentBase64: string; isLast: boolean }
        | { success: true; payloadBase64: string; encryptedDataKeyEnvelopeBase64: string; isLast: boolean }
        | { success: false; error: string }
    >>;
    finalizeDownloadTransferSession(input: Readonly<{ downloadId: string }>): Promise<void>;
    abortDownloadTransferSession(input: Readonly<{ downloadId: string }>): Promise<void>;
}>;

export function createTransferSessionLifecycle(params: Readonly<{
    store: TransferSessionStore;
    chunkSizeBytes: number;
    maxEncryptedDataKeyEnvelopeBytes?: number;
}>): TransferSessionLifecycle {
    const chunkSizeBytes = Math.max(1, Math.floor(params.chunkSizeBytes));
    const maxEncryptedDataKeyEnvelopeBytes = getMaxEncryptedDataKeyEnvelopeBytes(params.maxEncryptedDataKeyEnvelopeBytes);
    const uploadOperationTails = new Map<string, Promise<void>>();
    const downloadOperationTails = new Map<string, Promise<void>>();

    async function runSessionOperation<TResult>(
        tails: Map<string, Promise<void>>,
        sessionId: string,
        operation: () => Promise<TResult>,
    ): Promise<TResult> {
        const previous = tails.get(sessionId) ?? Promise.resolve();
        let release!: () => void;
        const current = new Promise<void>((resolve) => {
            release = resolve;
        });
        tails.set(sessionId, current);
        await previous;
        try {
            return await operation();
        } finally {
            release();
            if (tails.get(sessionId) === current) tails.delete(sessionId);
        }
    }

    async function openUploadTransferSession<TResult>(input: Readonly<{
        target: UploadTransferTarget<TResult> & Readonly<{ destPath: string }>;
        sha256Expected?: string;
        recipientSecretKeySeed?: Uint8Array;
        recipientPublicKeyBase64?: string;
    }>): Promise<UploadSessionHandle> {
        return await params.store.createUploadSession({
            destPath: input.target.destPath,
            destDisplayPath: input.target.destDisplayPath,
            overwrite: input.target.overwrite,
            expectedSizeBytes: input.target.expectedSizeBytes,
            finalizeUpload: input.target.finalizeUpload,
            chunkSizeBytes,
            sha256Expected: input.sha256Expected,
            recipientSecretKeySeed: input.recipientSecretKeySeed,
            recipientPublicKeyBase64: input.recipientPublicKeyBase64,
            hash: createHash('sha256'),
        });
    }

    async function writeUploadTransferChunk(input: Readonly<{
        uploadId: string;
        index: number;
        contentBase64?: string;
        payloadBase64?: string;
        encryptedDataKeyEnvelopeBase64?: string;
    }>): Promise<Readonly<{ success: true } | { success: false; error: string }>> {
        return await runSessionOperation(uploadOperationTails, input.uploadId, async () => {
            params.store.cleanupExpiredBestEffort();
            if (!input.uploadId) return { success: false, error: 'Missing uploadId' };
            if (!Number.isFinite(input.index) || input.index < 0) return { success: false, error: 'Invalid index' };

            const activeOperation = params.store.beginUploadSessionOperation(input.uploadId);
            if (!activeOperation) return { success: false, error: 'Upload session not found' };
            const { session } = activeOperation;
            try {
                if (input.index < session.nextIndex) {
                    params.store.refreshUploadExpiry(input.uploadId);
                    return { success: true };
                }
                if (input.index !== session.nextIndex) return { success: false, error: 'Unexpected chunk index' };

                let buffer: Buffer;
                if (session.recipientSecretKeySeed) {
                    const payloadBase64 = typeof input.payloadBase64 === 'string' ? input.payloadBase64 : '';
                    const encryptedDataKeyEnvelopeBase64 = typeof input.encryptedDataKeyEnvelopeBase64 === 'string'
                        ? input.encryptedDataKeyEnvelopeBase64
                        : '';
                    if (!payloadBase64) return { success: false, error: 'Missing payloadBase64' };
                    if (!encryptedDataKeyEnvelopeBase64) return { success: false, error: 'Missing encryptedDataKeyEnvelopeBase64' };

                    const maxEncryptedChunkBytes = session.chunkSizeBytes + ENCRYPTED_TRANSFER_CHUNK_OVERHEAD_BYTES;
                    const maxPayloadEncodedChars = resolveMaxEncodedChars(maxEncryptedChunkBytes);
                    if (
                        payloadBase64.length > maxPayloadEncodedChars
                        || estimateBase64DecodedBytes(payloadBase64) > maxEncryptedChunkBytes
                    ) {
                        return { success: false, error: 'Chunk exceeds configured chunk size' };
                    }

                    const maxEnvelopeEncodedChars = resolveMaxEncodedChars(maxEncryptedDataKeyEnvelopeBytes);
                    if (
                        encryptedDataKeyEnvelopeBase64.length > maxEnvelopeEncodedChars
                        || estimateBase64DecodedBytes(encryptedDataKeyEnvelopeBase64) > maxEncryptedDataKeyEnvelopeBytes
                    ) {
                        return { success: false, error: 'Encrypted data key envelope exceeds configured size limit' };
                    }

                    try {
                        buffer = decryptEncryptedTransferChunkEnvelope({
                            transferId: input.uploadId,
                            sequence: input.index,
                            payloadBase64,
                            encryptedDataKeyEnvelopeBase64,
                            recipientSecretKeySeed: session.recipientSecretKeySeed,
                        });
                    } catch (error) {
                        return { success: false, error: error instanceof Error ? error.message : `Failed to decrypt transfer chunk for ${input.uploadId}` };
                    }
                } else {
                    const contentBase64 = typeof input.contentBase64 === 'string' ? input.contentBase64 : '';
                    if (!contentBase64) return { success: false, error: 'Missing contentBase64' };

                    const maxEncodedChars = resolveMaxEncodedChars(session.chunkSizeBytes);
                    if (
                        contentBase64.length > maxEncodedChars
                        || estimateBase64DecodedBytes(contentBase64) > session.chunkSizeBytes
                    ) {
                        return { success: false, error: 'Chunk exceeds configured chunk size' };
                    }

                    const decodedBuffer = decodeUploadChunkBase64(contentBase64, { maxDecodedBytes: session.chunkSizeBytes });
                    if (!decodedBuffer) {
                        return { success: false, error: 'Invalid base64 content' };
                    }
                    buffer = decodedBuffer;
                }

                if (buffer.length > session.chunkSizeBytes) {
                    return { success: false, error: 'Chunk exceeds configured chunk size' };
                }
                if (session.receivedBytes + buffer.length > session.expectedSizeBytes) {
                    return { success: false, error: 'Chunk exceeds expected upload size' };
                }

                try {
                    await writeFileHandleFully({
                        fileHandle: session.file,
                        buffer,
                        position: session.receivedBytes,
                    });
                    session.hash.update(buffer);
                    session.receivedBytes += buffer.length;
                    session.nextIndex += 1;
                    params.store.refreshUploadExpiry(input.uploadId);
                    return { success: true };
                } catch (error) {
                    return { success: false, error: error instanceof Error ? error.message : 'Failed to write chunk' };
                }
            } finally {
                activeOperation.release();
            }
        });
    }

    async function finalizeUploadTransferSession(input: Readonly<{
        uploadId: string;
    }>): Promise<Readonly<
        | { success: true; finalized: Extract<UploadTransferFinalizeResult<unknown>, { success: true }>; sha256: string }
        | Extract<UploadTransferFinalizeResult<unknown>, { success: false }>
    >> {
        return await runSessionOperation(uploadOperationTails, input.uploadId, async () => {
            params.store.cleanupExpiredBestEffort();
            const activeOperation = params.store.beginUploadSessionOperation(input.uploadId);
            if (!activeOperation) {
                return { success: false, error: 'Upload session not found' };
            }
            const { session } = activeOperation;
            try {
                if (session.receivedBytes !== session.expectedSizeBytes) {
                    return { success: false, error: 'Upload is incomplete' };
                }

                const sha256 = session.hash.copy().digest('hex');
                if (session.sha256Expected && session.sha256Expected !== sha256) {
                    await params.store.abortUploadSession(input.uploadId);
                    return { success: false, error: 'Upload hash mismatch' };
                }

                try {
                    await session.file.close().catch(() => undefined);
                    const finalized = await session.finalizeUpload({
                        uploadId: input.uploadId,
                        tempPath: session.tempPath,
                        sizeBytes: session.expectedSizeBytes,
                        sha256,
                    });
                    if (!finalized.success) {
                        return finalized;
                    }

                    await params.store.finalizeUploadSession(input.uploadId);
                    return { success: true, finalized, sha256 };
                } catch (error) {
                    await params.store.abortUploadSession(input.uploadId);
                    return { success: false, error: error instanceof Error ? error.message : 'Failed to finalize upload' };
                }
            } finally {
                activeOperation.release();
            }
        });
    }

    async function abortUploadTransferSession(input: Readonly<{ uploadId: string }>): Promise<Readonly<{ aborted: boolean }>> {
        return await runSessionOperation(uploadOperationTails, input.uploadId, async () => {
            params.store.cleanupExpiredBestEffort();
            if (!input.uploadId) return { aborted: false };
            const activeOperation = params.store.beginUploadSessionOperation(input.uploadId);
            if (!activeOperation) return { aborted: false };
            try {
                await params.store.abortUploadSession(input.uploadId);
                return { aborted: true };
            } finally {
                activeOperation.release();
            }
        });
    }

    async function openDownloadTransferSession(input: Readonly<{
        source: DownloadTransferSource;
        recipientPublicKeyBase64?: string;
    }>): Promise<DownloadSessionHandle> {
        return await params.store.createDownloadSession({
            filePath: input.source.filePath,
            deleteFileOnClose: input.source.deleteFileOnClose,
            chunkSizeBytes,
            recipientPublicKeyBase64: input.recipientPublicKeyBase64,
        });
    }

    async function readDownloadTransferChunk(input: Readonly<{
        downloadId: string;
        index: number;
    }>): Promise<Readonly<
        | { success: true; contentBase64: string; isLast: boolean }
        | { success: true; payloadBase64: string; encryptedDataKeyEnvelopeBase64: string; isLast: boolean }
        | { success: false; error: string }
    >> {
        return await runSessionOperation(downloadOperationTails, input.downloadId, async () => {
            params.store.cleanupExpiredBestEffort();
            if (!input.downloadId) return { success: false, error: 'Missing downloadId' };
            if (!Number.isFinite(input.index) || input.index < 0) return { success: false, error: 'Invalid index' };

            const activeOperation = params.store.beginDownloadSessionOperation(input.downloadId);
            if (!activeOperation) return { success: false, error: 'Download session not found' };
            const { session } = activeOperation;
            try {
                if (input.index !== session.nextIndex) return { success: false, error: 'Unexpected chunk index' };

                const remaining = session.sizeBytes - session.offset;
                const readSize = Math.max(0, Math.min(session.chunkSizeBytes, remaining));
                if (readSize === 0) {
                    if (!session.recipientPublicKeyBase64) {
                        return { success: true, contentBase64: '', isLast: true };
                    }
                    const encryptedChunk = createEncryptedTransferChunkEnvelope({
                        transferId: input.downloadId,
                        sequence: input.index,
                        payload: Buffer.alloc(0),
                        recipientPublicKeyBase64: session.recipientPublicKeyBase64,
                    });
                    return {
                        success: true,
                        payloadBase64: encryptedChunk.payloadBase64,
                        encryptedDataKeyEnvelopeBase64: encryptedChunk.encryptedDataKeyEnvelopeBase64,
                        isLast: true,
                    };
                }

                const buffer = Buffer.alloc(readSize);
                const readResult = await session.file.read(buffer, 0, readSize, session.offset);
                const bytesRead = readResult.bytesRead ?? 0;
                if (bytesRead === 0) {
                    await params.store.closeDownloadSession(input.downloadId);
                    return { success: false, error: 'Download source ended before expected size' };
                }
                const slice = bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead);

                session.offset += bytesRead;
                session.nextIndex += 1;
                params.store.refreshDownloadExpiry(input.downloadId);
                const isLast = session.offset >= session.sizeBytes;
                if (!session.recipientPublicKeyBase64) {
                    return { success: true, contentBase64: slice.toString('base64'), isLast };
                }
                const encryptedChunk = createEncryptedTransferChunkEnvelope({
                    transferId: input.downloadId,
                    sequence: input.index,
                    payload: slice,
                    recipientPublicKeyBase64: session.recipientPublicKeyBase64,
                });
                return {
                    success: true,
                    payloadBase64: encryptedChunk.payloadBase64,
                    encryptedDataKeyEnvelopeBase64: encryptedChunk.encryptedDataKeyEnvelopeBase64,
                    isLast,
                };
            } finally {
                activeOperation.release();
            }
        });
    }

    async function finalizeDownloadTransferSession(input: Readonly<{ downloadId: string }>): Promise<void> {
        await runSessionOperation(downloadOperationTails, input.downloadId, async () => {
            params.store.cleanupExpiredBestEffort();
            if (!input.downloadId) return;
            const activeOperation = params.store.beginDownloadSessionOperation(input.downloadId);
            if (!activeOperation) return;
            try {
                await params.store.closeDownloadSession(input.downloadId);
            } finally {
                activeOperation.release();
            }
        });
    }

    async function abortDownloadTransferSession(input: Readonly<{ downloadId: string }>): Promise<void> {
        await runSessionOperation(downloadOperationTails, input.downloadId, async () => {
            params.store.cleanupExpiredBestEffort();
            if (!input.downloadId) return;
            const activeOperation = params.store.beginDownloadSessionOperation(input.downloadId);
            if (!activeOperation) return;
            try {
                await params.store.closeDownloadSession(input.downloadId);
            } finally {
                activeOperation.release();
            }
        });
    }

    return {
        openUploadTransferSession,
        writeUploadTransferChunk,
        finalizeUploadTransferSession,
        abortUploadTransferSession,
        openDownloadTransferSession,
        readDownloadTransferChunk,
        finalizeDownloadTransferSession,
        abortDownloadTransferSession,
    };
}

export async function openUploadTransferSession<TResult>(params: Readonly<{
    lifecycle: TransferSessionLifecycle;
    target: UploadTransferTarget<TResult> & Readonly<{ destPath: string }>;
    sha256Expected?: string;
    recipientSecretKeySeed?: Uint8Array;
    recipientPublicKeyBase64?: string;
}>): Promise<UploadSessionHandle> {
    return await params.lifecycle.openUploadTransferSession({
        target: params.target,
        sha256Expected: params.sha256Expected,
        recipientSecretKeySeed: params.recipientSecretKeySeed,
        recipientPublicKeyBase64: params.recipientPublicKeyBase64,
    });
}

export async function writeUploadTransferChunk(params: Readonly<{
    lifecycle: TransferSessionLifecycle;
    uploadId: string;
    index: number;
    contentBase64?: string;
    payloadBase64?: string;
    encryptedDataKeyEnvelopeBase64?: string;
}>): Promise<Readonly<{ success: true } | { success: false; error: string }>> {
    return await params.lifecycle.writeUploadTransferChunk({
        uploadId: params.uploadId,
        index: params.index,
        contentBase64: params.contentBase64,
        payloadBase64: params.payloadBase64,
        encryptedDataKeyEnvelopeBase64: params.encryptedDataKeyEnvelopeBase64,
    });
}

export async function finalizeUploadTransferSession(params: Readonly<{
    lifecycle: TransferSessionLifecycle;
    uploadId: string;
}>): Promise<Readonly<
    | { success: true; finalized: Extract<UploadTransferFinalizeResult<unknown>, { success: true }>; sha256: string }
    | Extract<UploadTransferFinalizeResult<unknown>, { success: false }>
>> {
    return await params.lifecycle.finalizeUploadTransferSession({ uploadId: params.uploadId });
}

export async function abortUploadTransferSession(params: Readonly<{
    lifecycle: TransferSessionLifecycle;
    uploadId: string;
}>): Promise<Readonly<{ aborted: boolean }>> {
    return await params.lifecycle.abortUploadTransferSession({ uploadId: params.uploadId });
}

export async function openDownloadTransferSession(params: Readonly<{
    lifecycle: TransferSessionLifecycle;
    source: DownloadTransferSource;
    recipientPublicKeyBase64?: string;
}>): Promise<DownloadSessionHandle> {
    return await params.lifecycle.openDownloadTransferSession({
        source: params.source,
        recipientPublicKeyBase64: params.recipientPublicKeyBase64,
    });
}

export async function readDownloadTransferChunk(params: Readonly<{
    lifecycle: TransferSessionLifecycle;
    downloadId: string;
    index: number;
}>): Promise<Readonly<
    | { success: true; contentBase64: string; isLast: boolean }
    | { success: true; payloadBase64: string; encryptedDataKeyEnvelopeBase64: string; isLast: boolean }
    | { success: false; error: string }
>> {
    return await params.lifecycle.readDownloadTransferChunk({
        downloadId: params.downloadId,
        index: params.index,
    });
}

export async function finalizeDownloadTransferSession(params: Readonly<{
    lifecycle: TransferSessionLifecycle;
    downloadId: string;
}>): Promise<void> {
    await params.lifecycle.finalizeDownloadTransferSession({ downloadId: params.downloadId });
}

export async function abortDownloadTransferSession(params: Readonly<{
    lifecycle: TransferSessionLifecycle;
    downloadId: string;
}>): Promise<void> {
    await params.lifecycle.abortDownloadTransferSession({ downloadId: params.downloadId });
}
