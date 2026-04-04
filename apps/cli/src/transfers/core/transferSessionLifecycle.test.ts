import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

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

            await abortUploadTransferSession({ lifecycle, uploadId: abortedSession.uploadId });
            expect(store.getUploadSession(abortedSession.uploadId)).toBeNull();
        } finally {
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
});
