import { appendFile, mkdtemp, readFile, rm, truncate, writeFile, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { createTransferRecipientKeyPair, decryptEncryptedTransferChunkEnvelope } from '@/machines/transfer/transferChunkEncryption';

import { TransferSessionStore } from './transferSessionStore';
import {
    abortDownloadTransferSession,
    abortUploadTransferSession,
    createTransferSessionLifecycle,
    finalizeDownloadTransferSession,
    finalizeUploadTransferSession,
    openDownloadTransferSession,
    openUploadTransferSession,
    readDownloadTransferChunk,
    writeUploadTransferChunk,
} from './transferSessionLifecycle';

type BufferFileWrite = (
    buffer: Uint8Array,
    offset?: number | null,
    length?: number | null,
    position?: number | null,
) => Promise<{ bytesWritten: number; buffer: Uint8Array }>;

type BufferFileRead = (
    buffer: Uint8Array,
    offset?: number,
    length?: number,
    position?: number | null,
) => Promise<{ bytesRead: number; buffer: Uint8Array }>;

function installShortWriteBoundary(handle: FileHandle, maxWriteBytes: number): () => number {
    const write = handle.write.bind(handle) as BufferFileWrite;
    let writeCount = 0;
    Object.defineProperty(handle, 'write', {
        configurable: true,
        value: async (
            buffer: Uint8Array,
            offset = 0,
            length = buffer.byteLength - offset,
            position: number | null = null,
        ) => {
            writeCount += 1;
            return await write(buffer, offset, Math.min(length, maxWriteBytes), position);
        },
    });
    return () => writeCount;
}

function installDeferredWriteBoundary(handle: FileHandle): Readonly<{
    entered: Promise<void>;
    release(): void;
}> {
    const write = handle.write.bind(handle) as BufferFileWrite;
    let resolveEntered!: () => void;
    let resolveRelease!: () => void;
    const entered = new Promise<void>((resolve) => {
        resolveEntered = resolve;
    });
    const released = new Promise<void>((resolve) => {
        resolveRelease = resolve;
    });
    let deferred = false;
    Object.defineProperty(handle, 'write', {
        configurable: true,
        value: async (
            buffer: Uint8Array,
            offset = 0,
            length = buffer.byteLength - offset,
            position: number | null = null,
        ) => {
            const result = await write(buffer, offset, length, position);
            if (!deferred) {
                deferred = true;
                resolveEntered();
                await released;
            }
            return result;
        },
    });
    return { entered, release: resolveRelease };
}

function installDeferredReadBoundary(handle: FileHandle): Readonly<{
    entered: Promise<void>;
    release(): void;
}> {
    const read = handle.read.bind(handle) as BufferFileRead;
    let resolveEntered!: () => void;
    let resolveRelease!: () => void;
    const entered = new Promise<void>((resolve) => {
        resolveEntered = resolve;
    });
    const released = new Promise<void>((resolve) => {
        resolveRelease = resolve;
    });
    let deferred = false;
    Object.defineProperty(handle, 'read', {
        configurable: true,
        value: async (
            buffer: Uint8Array,
            offset = 0,
            length = buffer.byteLength - offset,
            position: number | null = null,
        ) => {
            const result = await read(buffer, offset, length, position);
            if (!deferred) {
                deferred = true;
                resolveEntered();
                await released;
            }
            return result;
        },
    });
    return { entered, release: resolveRelease };
}

describe('transferSessionLifecycle', () => {
    it('reuses upload session state across init, chunk retries, finalize, and abort', async () => {
        const tempDir = await mkdtemp(join(tmpdir(), 'happier-transfer-lifecycle-upload-'));
        const store = new TransferSessionStore({ ttlMs: 30_000 });
        const lifecycle = createTransferSessionLifecycle({ store, chunkSizeBytes: 2 });
        const targetPath = join(tempDir, 'dest.bin');
        let finalizeUploadInput: Readonly<{ tempPath: string; sizeBytes: number; sha256: string }> | null = null;
        const finalizeUpload = async (input: Readonly<{ tempPath: string; sizeBytes: number; sha256: string }>) => {
            finalizeUploadInput = input;
            return {
                success: true as const,
                path: targetPath,
                sizeBytes: input.sizeBytes,
                result: { sha256: input.sha256 },
            };
        };

        try {
        const session = await openUploadTransferSession({
                lifecycle,
                target: {
                    destPath: targetPath,
                    destDisplayPath: 'dest.bin',
                    overwrite: true,
                    expectedSizeBytes: 2,
                    finalizeUpload,
                },
            });

            const initialExpiry = session.expiresAt;
            const chunk = Buffer.from('ab', 'utf8').toString('base64');

            await expect(writeUploadTransferChunk({
                lifecycle,
                uploadId: session.uploadId,
                index: 0,
                contentBase64: chunk,
            })).resolves.toEqual({ success: true });

            expect(store.getUploadSession(session.uploadId)?.nextIndex).toBe(1);
            expect(store.getUploadSession(session.uploadId)?.receivedBytes).toBe(2);
            expect(store.getUploadSession(session.uploadId)?.expiresAt).toBeGreaterThanOrEqual(initialExpiry);

            await expect(writeUploadTransferChunk({
                lifecycle,
                uploadId: session.uploadId,
                index: 0,
                contentBase64: chunk,
            })).resolves.toEqual({ success: true });

            const finalized = await finalizeUploadTransferSession({ lifecycle, uploadId: session.uploadId });
            expect(finalized).toEqual(expect.objectContaining({
                success: true,
                finalized: expect.objectContaining({
                    path: targetPath,
                    sizeBytes: 2,
                }),
            }));
            expect(finalizeUploadInput).toEqual(expect.objectContaining({
                tempPath: expect.any(String),
                sizeBytes: 2,
                sha256: expect.any(String),
            }));
            expect(store.getUploadSession(session.uploadId)).toBeNull();

            const abortedSession = await openUploadTransferSession({
                lifecycle,
                target: {
                    destPath: join(tempDir, 'aborted.bin'),
                    destDisplayPath: 'aborted.bin',
                    overwrite: true,
                    expectedSizeBytes: 2,
                    finalizeUpload,
                },
            });

            await expect(abortUploadTransferSession({
                lifecycle,
                uploadId: abortedSession.uploadId,
            })).resolves.toEqual({ aborted: true });
            expect(store.getUploadSession(abortedSession.uploadId)).toBeNull();

            await expect(abortUploadTransferSession({
                lifecycle,
                uploadId: abortedSession.uploadId,
            })).resolves.toEqual({ aborted: false });
        } finally {
            await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
        }
    });

    it('preserves finalize recovery failures and keeps their upload session attached', async () => {
        const tempDir = await mkdtemp(join(tmpdir(), 'happier-transfer-lifecycle-finalize-recovery-'));
        const store = new TransferSessionStore({ ttlMs: 30_000 });
        const lifecycle = createTransferSessionLifecycle({ store, chunkSizeBytes: 8 });
        const payload = Buffer.from('recovery', 'utf8');

        try {
            const session = await openUploadTransferSession({
                lifecycle,
                target: {
                    destPath: join(tempDir, 'dest.bin'),
                    destDisplayPath: 'dest.bin',
                    overwrite: true,
                    expectedSizeBytes: payload.length,
                    finalizeUpload: async () => ({
                        success: false as const,
                        error: 'Destination recovery requires operator action',
                        errorCode: 'TRANSFER_FINALIZE_RECOVERY_REQUIRED' as const,
                        keepSession: true as const,
                    }),
                },
            });

            await expect(writeUploadTransferChunk({
                lifecycle,
                uploadId: session.uploadId,
                index: 0,
                contentBase64: payload.toString('base64'),
            })).resolves.toEqual({ success: true });

            await expect(finalizeUploadTransferSession({
                lifecycle,
                uploadId: session.uploadId,
            })).resolves.toEqual({
                success: false,
                error: 'Destination recovery requires operator action',
                errorCode: 'TRANSFER_FINALIZE_RECOVERY_REQUIRED',
                keepSession: true,
            });
            expect(store.getUploadSession(session.uploadId)).not.toBeNull();
        } finally {
            await store.dispose();
            await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
        }
    });

    it('passes the exact upload identity through the canonical finalize target', async () => {
        const tempDir = await mkdtemp(join(tmpdir(), 'happier-transfer-lifecycle-finalize-identity-'));
        const store = new TransferSessionStore({ ttlMs: 30_000 });
        const finalizeUpload = vi.fn(async (input: Readonly<{
            uploadId: string;
            tempPath: string;
            sizeBytes: number;
            sha256: string;
        }>) => ({
            success: true as const,
            path: join(tempDir, 'dest.bin'),
            sizeBytes: input.sizeBytes,
        }));
        const lifecycle = createTransferSessionLifecycle({
            store,
            chunkSizeBytes: 8,
        });
        const payload = Buffer.from('recovery', 'utf8');

        try {
            const destPath = join(tempDir, 'dest.bin');
            const session = await openUploadTransferSession({
                lifecycle,
                target: {
                    destPath,
                    destDisplayPath: 'dest.bin',
                    overwrite: true,
                    expectedSizeBytes: payload.length,
                    finalizeUpload,
                },
            });

            await expect(writeUploadTransferChunk({
                lifecycle,
                uploadId: session.uploadId,
                index: 0,
                contentBase64: payload.toString('base64'),
            })).resolves.toEqual({ success: true });

            await expect(finalizeUploadTransferSession({
                lifecycle,
                uploadId: session.uploadId,
            })).resolves.toMatchObject({
                success: true,
                finalized: {
                    success: true,
                    path: destPath,
                    sizeBytes: payload.length,
                },
            });
            expect(finalizeUpload).toHaveBeenCalledWith({
                uploadId: session.uploadId,
                tempPath: expect.any(String),
                sizeBytes: payload.length,
                sha256: expect.any(String),
            });
            expect(store.getUploadSession(session.uploadId)).toBeNull();
        } finally {
            await store.dispose();
            await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
        }
    });

    it('serializes concurrent retries for the same upload chunk without writing bytes twice', async () => {
        const tempDir = await mkdtemp(join(tmpdir(), 'happier-transfer-lifecycle-upload-race-'));
        const store = new TransferSessionStore({ ttlMs: 30_000 });
        const lifecycle = createTransferSessionLifecycle({ store, chunkSizeBytes: 2 });

        try {
            const session = await openUploadTransferSession({
                lifecycle,
                target: {
                    destPath: join(tempDir, 'dest.bin'),
                    destDisplayPath: 'dest.bin',
                    overwrite: true,
                    expectedSizeBytes: 2,
                    finalizeUpload: async (input) => ({
                        success: true as const,
                        path: join(tempDir, 'dest.bin'),
                        sizeBytes: input.sizeBytes,
                        result: null,
                    }),
                },
            });
            const chunk = Buffer.from('ab', 'utf8').toString('base64');

            await expect(Promise.all([
                writeUploadTransferChunk({
                    lifecycle,
                    uploadId: session.uploadId,
                    index: 0,
                    contentBase64: chunk,
                }),
                writeUploadTransferChunk({
                    lifecycle,
                    uploadId: session.uploadId,
                    index: 0,
                    contentBase64: chunk,
                }),
            ])).resolves.toEqual([{ success: true }, { success: true }]);

            expect(store.getUploadSession(session.uploadId)).toMatchObject({
                nextIndex: 1,
                receivedBytes: 2,
            });
        } finally {
            await store.dispose();
            await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
        }
    });

    it('persists every upload byte before committing hash, count, and sequence after short writes', async () => {
        const tempDir = await mkdtemp(join(tmpdir(), 'happier-transfer-lifecycle-short-write-'));
        const store = new TransferSessionStore({ ttlMs: 30_000 });
        const lifecycle = createTransferSessionLifecycle({ store, chunkSizeBytes: 8 });
        const payload = Buffer.from('abcdefgh', 'utf8');
        let finalizedBytes: Buffer | null = null;

        try {
            const session = await openUploadTransferSession({
                lifecycle,
                target: {
                    destPath: join(tempDir, 'dest.bin'),
                    destDisplayPath: 'dest.bin',
                    overwrite: true,
                    expectedSizeBytes: payload.length,
                    finalizeUpload: async (input) => {
                        finalizedBytes = await readFile(input.tempPath);
                        return {
                            success: true as const,
                            path: join(tempDir, 'dest.bin'),
                            sizeBytes: input.sizeBytes,
                            result: null,
                        };
                    },
                },
            });
            const openSession = store.getUploadSession(session.uploadId);
            if (!openSession) {
                throw new Error('Expected open upload session');
            }
            const readWriteCount = installShortWriteBoundary(openSession.file, 2);

            await expect(writeUploadTransferChunk({
                lifecycle,
                uploadId: session.uploadId,
                index: 0,
                contentBase64: payload.toString('base64'),
            })).resolves.toEqual({ success: true });

            expect(store.getUploadSession(session.uploadId)).toMatchObject({
                nextIndex: 1,
                receivedBytes: payload.length,
            });
            await expect(finalizeUploadTransferSession({
                lifecycle,
                uploadId: session.uploadId,
            })).resolves.toMatchObject({ success: true });

            expect(readWriteCount()).toBe(4);
            expect(finalizedBytes).toEqual(payload);
        } finally {
            await store.dispose();
            await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
        }
    });

    it('keeps an upload session attached while an external expiry sweep overlaps an in-flight write', async () => {
        const tempDir = await mkdtemp(join(tmpdir(), 'happier-transfer-lifecycle-upload-expiry-race-'));
        const store = new TransferSessionStore({ ttlMs: 1_000 });
        const lifecycle = createTransferSessionLifecycle({ store, chunkSizeBytes: 2 });
        let now = 1_000;
        const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
        let releaseWrite: (() => void) | null = null;
        let writePromise: Promise<Readonly<{ success: true } | { success: false; error: string }>> | null = null;

        try {
            const session = await openUploadTransferSession({
                lifecycle,
                target: {
                    destPath: join(tempDir, 'dest.bin'),
                    destDisplayPath: 'dest.bin',
                    overwrite: true,
                    expectedSizeBytes: 2,
                    finalizeUpload: async (input) => ({
                        success: true as const,
                        path: join(tempDir, 'dest.bin'),
                        sizeBytes: input.sizeBytes,
                        result: null,
                    }),
                },
            });
            const deferredWrite = installDeferredWriteBoundary(session.file);
            releaseWrite = deferredWrite.release;

            now = session.expiresAt - 1;
            writePromise = writeUploadTransferChunk({
                lifecycle,
                uploadId: session.uploadId,
                index: 0,
                contentBase64: Buffer.from('ab', 'utf8').toString('base64'),
            });
            await deferredWrite.entered;

            store.cleanupExpiredBestEffort(session.expiresAt);
            expect(store.getUploadSession(session.uploadId)).toBe(session);

            deferredWrite.release();
            await expect(writePromise).resolves.toEqual({ success: true });
            expect(store.getUploadSession(session.uploadId)).toMatchObject({
                nextIndex: 1,
                receivedBytes: 2,
                expiresAt: now + 1_000,
            });

            store.cleanupExpiredBestEffort(now + 1_000);
            expect(store.getUploadSession(session.uploadId)).toBeNull();
        } finally {
            releaseWrite?.();
            if (writePromise) {
                await Promise.allSettled([writePromise]);
            }
            nowSpy.mockRestore();
            await store.dispose();
            await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
        }
    });

    it('reuses download session state across chunk reads, finalize, and abort', async () => {
        const tempDir = await mkdtemp(join(tmpdir(), 'happier-transfer-lifecycle-download-'));
        const store = new TransferSessionStore({ ttlMs: 30_000 });
        const lifecycle = createTransferSessionLifecycle({ store, chunkSizeBytes: 2 });
        const recipientKeyPair = createTransferRecipientKeyPair();

        try {
            const filePath = join(tempDir, 'source.bin');
            await writeFile(filePath, Buffer.from('abcd', 'utf8'));

            const session = await openDownloadTransferSession({
                lifecycle,
                source: {
                    filePath,
                    deleteFileOnClose: false,
                    sizeBytes: 4,
                    name: 'source.bin',
                },
                recipientPublicKeyBase64: recipientKeyPair.recipientPublicKeyBase64,
            });

            const firstChunk = await readDownloadTransferChunk({
                lifecycle,
                downloadId: session.downloadId,
                index: 0,
            });

            expect(firstChunk.success).toBe(true);
            if (!firstChunk.success) {
                throw new Error(firstChunk.error);
            }
            if (!('payloadBase64' in firstChunk)) {
                throw new Error('Expected encrypted chunk response');
            }

            const decryptedFirstChunk = decryptEncryptedTransferChunkEnvelope({
                transferId: session.downloadId,
                sequence: 0,
                payloadBase64: firstChunk.payloadBase64,
                encryptedDataKeyEnvelopeBase64: firstChunk.encryptedDataKeyEnvelopeBase64,
                recipientSecretKeySeed: recipientKeyPair.recipientSecretKeySeed,
            });
            expect(decryptedFirstChunk.toString('utf8')).toBe('ab');

            expect(store.getDownloadSession(session.downloadId)?.nextIndex).toBe(1);
            expect(store.getDownloadSession(session.downloadId)?.offset).toBe(2);

            await expect(finalizeDownloadTransferSession({ lifecycle, downloadId: session.downloadId })).resolves.toBeUndefined();
            expect(store.getDownloadSession(session.downloadId)).toBeNull();

            const abortedSession = await openDownloadTransferSession({
                lifecycle,
                source: {
                    filePath,
                    deleteFileOnClose: false,
                    sizeBytes: 4,
                    name: 'source.bin',
                },
            });
            await abortDownloadTransferSession({ lifecycle, downloadId: abortedSession.downloadId });
            expect(store.getDownloadSession(abortedSession.downloadId)).toBeNull();
        } finally {
            await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
        }
    });

    it('reads only the declared bounded range of a download source', async () => {
        const tempDir = await mkdtemp(join(tmpdir(), 'happier-transfer-lifecycle-download-range-'));
        const store = new TransferSessionStore({ ttlMs: 30_000 });
        const lifecycle = createTransferSessionLifecycle({ store, chunkSizeBytes: 3 });

        try {
            const filePath = join(tempDir, 'source.bin');
            await writeFile(filePath, Buffer.from('prefix:CONTENT:suffix', 'utf8'));
            const session = await openDownloadTransferSession({
                lifecycle,
                source: {
                    filePath,
                    deleteFileOnClose: false,
                    sourceOffsetBytes: 7,
                    sizeBytes: 7,
                    name: 'content.bin',
                },
            });

            const chunks: Buffer[] = [];
            for (let index = 0; index < 3; index += 1) {
                const chunk = await readDownloadTransferChunk({
                    lifecycle,
                    downloadId: session.downloadId,
                    index,
                });
                expect(chunk.success).toBe(true);
                if (!chunk.success || !('contentBase64' in chunk)) throw new Error('expected unencrypted chunk');
                chunks.push(Buffer.from(chunk.contentBase64, 'base64'));
                if (chunk.isLast) break;
            }

            expect(Buffer.concat(chunks).toString('utf8')).toBe('CONTENT');
            await expect(finalizeDownloadTransferSession({ lifecycle, downloadId: session.downloadId })).resolves.toBeUndefined();
        } finally {
            await store.dispose();
            await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
        }
    });

    it('keeps a download session attached while an external expiry sweep overlaps an in-flight read', async () => {
        const tempDir = await mkdtemp(join(tmpdir(), 'happier-transfer-lifecycle-download-expiry-race-'));
        const store = new TransferSessionStore({ ttlMs: 1_000 });
        const lifecycle = createTransferSessionLifecycle({ store, chunkSizeBytes: 2 });
        let now = 1_000;
        const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
        let releaseRead: (() => void) | null = null;
        let readPromise: ReturnType<typeof readDownloadTransferChunk> | null = null;

        try {
            const filePath = join(tempDir, 'source.bin');
            await writeFile(filePath, Buffer.from('abcd', 'utf8'));
            const session = await openDownloadTransferSession({
                lifecycle,
                source: {
                    filePath,
                    deleteFileOnClose: false,
                    sizeBytes: 4,
                    name: 'source.bin',
                },
            });
            const deferredRead = installDeferredReadBoundary(session.file);
            releaseRead = deferredRead.release;

            now = session.expiresAt - 1;
            readPromise = readDownloadTransferChunk({
                lifecycle,
                downloadId: session.downloadId,
                index: 0,
            });
            await deferredRead.entered;

            store.cleanupExpiredBestEffort(session.expiresAt);
            expect(store.getDownloadSession(session.downloadId)).toBe(session);

            deferredRead.release();
            await expect(readPromise).resolves.toMatchObject({
                success: true,
                isLast: false,
            });
            expect(store.getDownloadSession(session.downloadId)).toMatchObject({
                nextIndex: 1,
                offset: 2,
                expiresAt: now + 1_000,
            });

            store.cleanupExpiredBestEffort(now + 1_000);
            expect(store.getDownloadSession(session.downloadId)).toBeNull();
        } finally {
            releaseRead?.();
            if (readPromise) {
                await Promise.allSettled([readPromise]);
            }
            nowSpy.mockRestore();
            await store.dispose();
            await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
        }
    });

    it('closes an encrypted download session when its source ends before the opened size', async () => {
        const tempDir = await mkdtemp(join(tmpdir(), 'happier-transfer-lifecycle-download-truncated-'));
        const store = new TransferSessionStore({ ttlMs: 30_000 });
        const lifecycle = createTransferSessionLifecycle({ store, chunkSizeBytes: 4 });
        const recipientKeyPair = createTransferRecipientKeyPair();

        try {
            const filePath = join(tempDir, 'source.bin');
            await writeFile(filePath, Buffer.from('abcdefgh', 'utf8'));
            const session = await openDownloadTransferSession({
                lifecycle,
                source: {
                    filePath,
                    deleteFileOnClose: false,
                    sizeBytes: 8,
                    name: 'source.bin',
                },
                recipientPublicKeyBase64: recipientKeyPair.recipientPublicKeyBase64,
            });
            const initialExpiry = session.expiresAt;
            await truncate(filePath, 0);

            await expect(readDownloadTransferChunk({
                lifecycle,
                downloadId: session.downloadId,
                index: 0,
            })).resolves.toEqual({
                success: false,
                error: 'Download source ended before expected size',
            });

            expect(session.expiresAt).toBe(initialExpiry);
            expect(store.getDownloadSession(session.downloadId)).toBeNull();
            await expect(readDownloadTransferChunk({
                lifecycle,
                downloadId: session.downloadId,
                index: 0,
            })).resolves.toEqual({
                success: false,
                error: 'Download session not found',
            });
        } finally {
            await store.dispose();
            await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
        }
    });

    it('continues an encrypted download after a progressing short read', async () => {
        const tempDir = await mkdtemp(join(tmpdir(), 'happier-transfer-lifecycle-download-short-read-'));
        const store = new TransferSessionStore({ ttlMs: 30_000 });
        const lifecycle = createTransferSessionLifecycle({ store, chunkSizeBytes: 8 });
        const recipientKeyPair = createTransferRecipientKeyPair();

        try {
            const filePath = join(tempDir, 'source.bin');
            await writeFile(filePath, Buffer.from('abcdefgh', 'utf8'));
            const session = await openDownloadTransferSession({
                lifecycle,
                source: {
                    filePath,
                    deleteFileOnClose: false,
                    sizeBytes: 8,
                    name: 'source.bin',
                },
                recipientPublicKeyBase64: recipientKeyPair.recipientPublicKeyBase64,
            });
            await truncate(filePath, 3);

            const firstChunk = await readDownloadTransferChunk({
                lifecycle,
                downloadId: session.downloadId,
                index: 0,
            });
            expect(firstChunk).toMatchObject({ success: true, isLast: false });
            if (!firstChunk.success || !('payloadBase64' in firstChunk)) {
                throw new Error('Expected encrypted short-read chunk response');
            }
            expect(decryptEncryptedTransferChunkEnvelope({
                transferId: session.downloadId,
                sequence: 0,
                payloadBase64: firstChunk.payloadBase64,
                encryptedDataKeyEnvelopeBase64: firstChunk.encryptedDataKeyEnvelopeBase64,
                recipientSecretKeySeed: recipientKeyPair.recipientSecretKeySeed,
            }).toString('utf8')).toBe('abc');
            expect(store.getDownloadSession(session.downloadId)).toMatchObject({
                nextIndex: 1,
                offset: 3,
            });

            await appendFile(filePath, Buffer.from('defgh', 'utf8'));
            const finalChunk = await readDownloadTransferChunk({
                lifecycle,
                downloadId: session.downloadId,
                index: 1,
            });
            expect(finalChunk).toMatchObject({ success: true, isLast: true });
            if (!finalChunk.success || !('payloadBase64' in finalChunk)) {
                throw new Error('Expected encrypted final chunk response');
            }
            expect(decryptEncryptedTransferChunkEnvelope({
                transferId: session.downloadId,
                sequence: 1,
                payloadBase64: finalChunk.payloadBase64,
                encryptedDataKeyEnvelopeBase64: finalChunk.encryptedDataKeyEnvelopeBase64,
                recipientSecretKeySeed: recipientKeyPair.recipientSecretKeySeed,
            }).toString('utf8')).toBe('defgh');
        } finally {
            await store.dispose();
            await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
        }
    });

    it('serializes concurrent reads for the same download index without advancing twice', async () => {
        const tempDir = await mkdtemp(join(tmpdir(), 'happier-transfer-lifecycle-download-race-'));
        const store = new TransferSessionStore({ ttlMs: 30_000 });
        const lifecycle = createTransferSessionLifecycle({ store, chunkSizeBytes: 2 });

        try {
            const filePath = join(tempDir, 'source.bin');
            await writeFile(filePath, Buffer.from('abcd', 'utf8'));
            const session = await openDownloadTransferSession({
                lifecycle,
                source: {
                    filePath,
                    deleteFileOnClose: false,
                    sizeBytes: 4,
                    name: 'source.bin',
                },
            });

            const results = await Promise.all([
                readDownloadTransferChunk({ lifecycle, downloadId: session.downloadId, index: 0 }),
                readDownloadTransferChunk({ lifecycle, downloadId: session.downloadId, index: 0 }),
            ]);

            expect(results.filter((result) => result.success)).toHaveLength(1);
            expect(store.getDownloadSession(session.downloadId)).toMatchObject({
                nextIndex: 1,
                offset: 2,
            });
        } finally {
            await store.dispose();
            await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
        }
    });
});
