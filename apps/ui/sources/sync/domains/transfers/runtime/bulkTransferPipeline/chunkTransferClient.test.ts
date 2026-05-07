import { describe, expect, it, vi } from 'vitest';

import * as base64Module from '@/encryption/base64';
import { downloadInChunks, uploadInChunks } from './chunkTransferClient';
import {
    createEncryptedTransferChunkEnvelope,
    createTransferRecipientKeyPair,
} from './transferChunkEncryption';

// This suite intentionally lives alongside bulkTransferPipeline internals so feature code cannot
// reach chunk-transfer plumbing outside the canonical pipeline boundary.
describe('chunkTransferClient', () => {
    it('uploads data in chunks, reporting progress and finalizing', async () => {
        const bytes = new TextEncoder().encode('hello');
        const initSpy = vi.fn(async () => ({
            success: true as const,
            uploadId: 'u1',
            chunkSizeBytes: 2,
            recipientPublicKeyBase64: Buffer.alloc(32, 9).toString('base64'),
        }));
        const chunkSpy = vi.fn(async (_req: {
            uploadId: string;
            index: number;
            payloadBase64: string;
            encryptedDataKeyEnvelopeBase64: string;
        }) => ({ success: true as const }));
        const finalizeSpy = vi.fn(async (_req: { uploadId: string }) => ({ success: true as const, path: 'file.txt' }));
        const abortSpy = vi.fn(async (_req: { uploadId: string }) => ({ success: true as const }));
        const progressSpy = vi.fn();

        const res = await uploadInChunks({
            totalBytes: bytes.byteLength,
            readBytes: async (offset, length) => bytes.slice(offset, offset + length),
            init: initSpy,
            sendChunk: chunkSpy,
            finalize: finalizeSpy,
            abort: abortSpy,
            onProgress: progressSpy,
        });

        expect(res).toMatchObject({ success: true, path: 'file.txt' });
        expect(initSpy).toHaveBeenCalledTimes(1);
        expect(chunkSpy).toHaveBeenCalledTimes(3);
        expect(chunkSpy.mock.calls[0]?.[0]).toMatchObject({
            uploadId: 'u1',
            index: 0,
            payloadBase64: expect.any(String),
            encryptedDataKeyEnvelopeBase64: expect.any(String),
        });
        expect(chunkSpy.mock.calls[0]?.[0]).not.toHaveProperty('contentBase64');
        expect(chunkSpy.mock.calls[1]?.[0]).toMatchObject({
            uploadId: 'u1',
            index: 1,
            payloadBase64: expect.any(String),
            encryptedDataKeyEnvelopeBase64: expect.any(String),
        });
        expect(chunkSpy.mock.calls[2]?.[0]).toMatchObject({
            uploadId: 'u1',
            index: 2,
            payloadBase64: expect.any(String),
            encryptedDataKeyEnvelopeBase64: expect.any(String),
        });
        expect(finalizeSpy).toHaveBeenCalledTimes(1);
        expect(abortSpy).not.toHaveBeenCalled();
        expect(progressSpy.mock.calls.map((call) => call[0])).toEqual([
            { uploadedBytes: 2, totalBytes: 5 },
            { uploadedBytes: 4, totalBytes: 5 },
            { uploadedBytes: 5, totalBytes: 5 },
        ]);
    });

    it('aborts uploads when the signal is canceled', async () => {
        const bytes = new TextEncoder().encode('hello');
        const initSpy = vi.fn(async () => ({
            success: true as const,
            uploadId: 'u1',
            chunkSizeBytes: 2,
            recipientPublicKeyBase64: Buffer.alloc(32, 9).toString('base64'),
        }));
        const chunkSpy = vi.fn(async (_req: {
            uploadId: string;
            index: number;
            payloadBase64: string;
            encryptedDataKeyEnvelopeBase64: string;
        }) => ({ success: true as const }));
        const finalizeSpy = vi.fn(async (_req: { uploadId: string }) => ({ success: true as const, path: 'file.txt' }));
        const abortSpy = vi.fn(async (_req: { uploadId: string }) => ({ success: true as const }));

        const controller = new AbortController();
        const res = await uploadInChunks({
            totalBytes: bytes.byteLength,
            readBytes: async (offset, length) => bytes.slice(offset, offset + length),
            init: initSpy,
            sendChunk: chunkSpy,
            finalize: finalizeSpy,
            abort: abortSpy,
            signal: controller.signal,
            onProgress: (progress) => {
                if (progress.uploadedBytes >= 2) {
                    controller.abort();
                }
            },
        });

        expect(res).toMatchObject({ success: false, error: 'Upload canceled' });
        expect(chunkSpy).toHaveBeenCalledTimes(1);
        expect(finalizeSpy).not.toHaveBeenCalled();
        expect(abortSpy).toHaveBeenCalledWith({ uploadId: 'u1' });
    });

    it('returns an upload error shape when chunk encryption throws', async () => {
        const bytes = new TextEncoder().encode('hello');
        const initSpy = vi.fn(async () => ({
            success: true as const,
            uploadId: 'u1',
            chunkSizeBytes: 2,
            recipientPublicKeyBase64: 'invalid-base64',
        }));
        const chunkSpy = vi.fn(async (_req: {
            uploadId: string;
            index: number;
            payloadBase64: string;
            encryptedDataKeyEnvelopeBase64: string;
        }) => ({ success: true as const }));
        const finalizeSpy = vi.fn(async (_req: { uploadId: string }) => ({ success: true as const, path: 'file.txt' }));
        const abortSpy = vi.fn(async (_req: { uploadId: string }) => ({ success: true as const }));

        await expect(uploadInChunks({
            totalBytes: bytes.byteLength,
            readBytes: async (offset, length) => bytes.slice(offset, offset + length),
            init: initSpy,
            sendChunk: chunkSpy,
            finalize: finalizeSpy,
            abort: abortSpy,
        })).resolves.toEqual({ success: false, error: 'Upload chunk encryption failed' });

        expect(chunkSpy).not.toHaveBeenCalled();
        expect(finalizeSpy).not.toHaveBeenCalled();
        expect(abortSpy).toHaveBeenCalledWith({ uploadId: 'u1' });
    });

    it('downloads data in chunks, reporting progress and finalizing', async () => {
        const recipientKeyPair = createTransferRecipientKeyPair({
            randomBytes: (length) => new Uint8Array(length).fill(7),
        });
        const initSpy = vi.fn(async () => ({ success: true as const, downloadId: 'd1', chunkSizeBytes: 2, sizeBytes: 5, name: 'file.txt' }));
        const chunkSpy = vi.fn(async (req: { downloadId: string; index: number }) => {
            if (req.index === 0) {
                return {
                    success: true as const,
                    ...await createEncryptedTransferChunkEnvelope({
                        transferId: req.downloadId,
                        sequence: req.index,
                        payload: new TextEncoder().encode('he'),
                        recipientPublicKeyBase64: recipientKeyPair.recipientPublicKeyBase64,
                        randomBytes: (length) => new Uint8Array(length).fill(11),
                    }),
                    isLast: false,
                };
            }
            if (req.index === 1) {
                return {
                    success: true as const,
                    ...await createEncryptedTransferChunkEnvelope({
                        transferId: req.downloadId,
                        sequence: req.index,
                        payload: new TextEncoder().encode('ll'),
                        recipientPublicKeyBase64: recipientKeyPair.recipientPublicKeyBase64,
                        randomBytes: (length) => new Uint8Array(length).fill(13),
                    }),
                    isLast: false,
                };
            }
            return {
                success: true as const,
                ...await createEncryptedTransferChunkEnvelope({
                    transferId: req.downloadId,
                    sequence: req.index,
                    payload: new TextEncoder().encode('o'),
                    recipientPublicKeyBase64: recipientKeyPair.recipientPublicKeyBase64,
                    randomBytes: (length) => new Uint8Array(length).fill(17),
                }),
                isLast: true,
            };
        });
        const finalizeSpy = vi.fn(async (_req: { downloadId: string }) => ({ success: true as const }));
        const abortSpy = vi.fn(async (_req: { downloadId: string }) => ({ success: true as const }));
        const progressSpy = vi.fn();

        const chunks: Uint8Array[] = [];
        const res = await downloadInChunks({
            init: initSpy,
            readChunk: chunkSpy,
            finalize: finalizeSpy,
            abort: abortSpy,
            onProgress: progressSpy,
            recipientSecretKeySeed: recipientKeyPair.recipientSecretKeySeed,
            writeBytes: async (chunk) => {
                chunks.push(chunk);
            },
        });

        expect(res).toEqual({ ok: true, sizeBytes: 5 });
        expect(finalizeSpy).toHaveBeenCalledTimes(1);
        expect(abortSpy).not.toHaveBeenCalled();
        expect(new TextDecoder().decode(Uint8Array.from(chunks.flatMap((c) => Array.from(c))))).toBe('hello');
        expect(progressSpy.mock.calls.map((call) => call[0])).toEqual([
            { downloadedBytes: 2, totalBytes: 5 },
            { downloadedBytes: 4, totalBytes: 5 },
            { downloadedBytes: 5, totalBytes: 5 },
        ]);
    });

    it('downloads encrypted chunks when SubtleCrypto is unavailable', async () => {
        const recipientKeyPair = createTransferRecipientKeyPair({
            randomBytes: (length) => new Uint8Array(length).fill(7),
        });
        const encryptedChunk = await createEncryptedTransferChunkEnvelope({
            transferId: 'd1',
            sequence: 0,
            payload: new TextEncoder().encode('native'),
            recipientPublicKeyBase64: recipientKeyPair.recipientPublicKeyBase64,
            randomBytes: (length) => new Uint8Array(length).fill(19),
        });
        const originalCryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
        const originalCrypto = globalThis.crypto;
        if (!originalCrypto?.getRandomValues) {
            throw new Error('Expected test runtime to expose crypto.getRandomValues');
        }

        Object.defineProperty(globalThis, 'crypto', {
            configurable: true,
            value: {
                getRandomValues: originalCrypto.getRandomValues.bind(originalCrypto),
            },
        });

        try {
            const initSpy = vi.fn(async () => ({ success: true as const, downloadId: 'd1', chunkSizeBytes: 6, sizeBytes: 6, name: 'file.txt' }));
            const chunkSpy = vi.fn(async (_req: { downloadId: string; index: number }) => ({
                success: true as const,
                ...encryptedChunk,
                isLast: true,
            }));
            const finalizeSpy = vi.fn(async (_req: { downloadId: string }) => ({ success: true as const }));
            const abortSpy = vi.fn(async (_req: { downloadId: string }) => ({ success: true as const }));
            const chunks: Uint8Array[] = [];

            const res = await downloadInChunks({
                init: initSpy,
                readChunk: chunkSpy,
                finalize: finalizeSpy,
                abort: abortSpy,
                recipientSecretKeySeed: recipientKeyPair.recipientSecretKeySeed,
                writeBytes: async (chunk) => {
                    chunks.push(chunk);
                },
            });

            expect(res).toEqual({ ok: true, sizeBytes: 6 });
            expect(new TextDecoder().decode(Uint8Array.from(chunks.flatMap((chunk) => Array.from(chunk))))).toBe('native');
            expect(finalizeSpy).toHaveBeenCalledTimes(1);
            expect(abortSpy).not.toHaveBeenCalled();
        } finally {
            if (originalCryptoDescriptor) {
                Object.defineProperty(globalThis, 'crypto', originalCryptoDescriptor);
            }
        }
    });

    it('aborts downloads when the signal is canceled', async () => {
        const recipientKeyPair = createTransferRecipientKeyPair({
            randomBytes: (length) => new Uint8Array(length).fill(7),
        });
        const initSpy = vi.fn(async () => ({ success: true as const, downloadId: 'd1', chunkSizeBytes: 2, sizeBytes: 5, name: 'file.txt' }));
        const chunkSpy = vi.fn(async (req: { downloadId: string; index: number }) => {
            if (req.index === 0) {
                return {
                    success: true as const,
                    ...await createEncryptedTransferChunkEnvelope({
                        transferId: req.downloadId,
                        sequence: req.index,
                        payload: new TextEncoder().encode('he'),
                        recipientPublicKeyBase64: recipientKeyPair.recipientPublicKeyBase64,
                        randomBytes: (length) => new Uint8Array(length).fill(11),
                    }),
                    isLast: false,
                };
            }
            if (req.index === 1) {
                return {
                    success: true as const,
                    ...await createEncryptedTransferChunkEnvelope({
                        transferId: req.downloadId,
                        sequence: req.index,
                        payload: new TextEncoder().encode('ll'),
                        recipientPublicKeyBase64: recipientKeyPair.recipientPublicKeyBase64,
                        randomBytes: (length) => new Uint8Array(length).fill(13),
                    }),
                    isLast: false,
                };
            }
            return {
                success: true as const,
                ...await createEncryptedTransferChunkEnvelope({
                    transferId: req.downloadId,
                    sequence: req.index,
                    payload: new TextEncoder().encode('o'),
                    recipientPublicKeyBase64: recipientKeyPair.recipientPublicKeyBase64,
                    randomBytes: (length) => new Uint8Array(length).fill(17),
                }),
                isLast: true,
            };
        });
        const finalizeSpy = vi.fn(async (_req: { downloadId: string }) => ({ success: true as const }));
        const abortSpy = vi.fn(async (_req: { downloadId: string }) => ({ success: true as const }));

        const controller = new AbortController();
        const res = await downloadInChunks({
            init: initSpy,
            readChunk: chunkSpy,
            finalize: finalizeSpy,
            abort: abortSpy,
            recipientSecretKeySeed: recipientKeyPair.recipientSecretKeySeed,
            signal: controller.signal,
            onProgress: (progress) => {
                if (progress.downloadedBytes >= 2) {
                    controller.abort();
                }
            },
            writeBytes: async () => {},
        });

        expect(res).toEqual({ ok: false, error: 'Download canceled' });
        expect(finalizeSpy).not.toHaveBeenCalled();
        expect(abortSpy).toHaveBeenCalledWith({ downloadId: 'd1' });
    });

    it('fails closed when a non-final chunk has no content', async () => {
        const initSpy = vi.fn(async () => ({ success: true as const, downloadId: 'd1', chunkSizeBytes: 2, sizeBytes: 1, name: 'file.txt' }));
        const chunkSpy = vi.fn(async (req: { downloadId: string; index: number }) => {
            if (req.index === 0) {
                return {
                    success: true as const,
                    isLast: false,
                };
            }

            return {
                success: true as const,
                contentBase64: Buffer.from('x').toString('base64'),
                isLast: true,
            };
        });
        const finalizeSpy = vi.fn(async (_req: { downloadId: string }) => ({ success: true as const }));
        const abortSpy = vi.fn(async (_req: { downloadId: string }) => ({ success: true as const }));

        await expect(downloadInChunks({
            init: initSpy,
            readChunk: chunkSpy,
            finalize: finalizeSpy,
            abort: abortSpy,
            writeBytes: async () => {},
        })).resolves.toEqual({ ok: false, error: 'Download chunk returned no content' });

        expect(chunkSpy).toHaveBeenCalledTimes(1);
        expect(finalizeSpy).not.toHaveBeenCalled();
        expect(abortSpy).toHaveBeenCalledWith({ downloadId: 'd1' });
    });

    it('returns a download error shape when decrypting a chunk throws', async () => {
        const recipientKeyPair = createTransferRecipientKeyPair({
            randomBytes: (length) => new Uint8Array(length).fill(7),
        });
        const initSpy = vi.fn(async () => ({ success: true as const, downloadId: 'd1', chunkSizeBytes: 2, sizeBytes: 2, name: 'file.txt' }));
        const chunkSpy = vi.fn(async (_req: { downloadId: string; index: number }) => ({
            success: true as const,
            payloadBase64: 'invalid-base64',
            encryptedDataKeyEnvelopeBase64: 'invalid-base64',
            isLast: true,
        }));
        const finalizeSpy = vi.fn(async (_req: { downloadId: string }) => ({ success: true as const }));
        const abortSpy = vi.fn(async (_req: { downloadId: string }) => ({ success: true as const }));

        await expect(downloadInChunks({
            init: initSpy,
            readChunk: chunkSpy,
            finalize: finalizeSpy,
            abort: abortSpy,
            recipientSecretKeySeed: recipientKeyPair.recipientSecretKeySeed,
            writeBytes: async () => {},
        })).resolves.toEqual({ ok: false, error: 'Download chunk decryption failed' });

        expect(finalizeSpy).not.toHaveBeenCalled();
        expect(abortSpy).toHaveBeenCalledWith({ downloadId: 'd1' });
    });

    it('returns a download error shape when decoding a plaintext chunk throws', async () => {
        const initSpy = vi.fn(async () => ({ success: true as const, downloadId: 'd1', chunkSizeBytes: 2, sizeBytes: 2, name: 'file.txt' }));
        const chunkSpy = vi.fn(async (_req: { downloadId: string; index: number }) => ({
            success: true as const,
            contentBase64: Buffer.from('ok').toString('base64'),
            isLast: true,
        }));
        const finalizeSpy = vi.fn(async (_req: { downloadId: string }) => ({ success: true as const }));
        const abortSpy = vi.fn(async (_req: { downloadId: string }) => ({ success: true as const }));
        const decodeSpy = vi.spyOn(base64Module, 'decodeBase64').mockImplementation(() => {
            throw new Error('decode failed');
        });

        try {
            await expect(downloadInChunks({
                init: initSpy,
                readChunk: chunkSpy,
                finalize: finalizeSpy,
                abort: abortSpy,
                writeBytes: async () => {},
            })).resolves.toEqual({ ok: false, error: 'Download chunk decode failed' });
        } finally {
            decodeSpy.mockRestore();
        }

        expect(finalizeSpy).not.toHaveBeenCalled();
        expect(abortSpy).toHaveBeenCalledWith({ downloadId: 'd1' });
    });

    it('fails when completed chunks do not match the expected download size', async () => {
        const initSpy = vi.fn(async () => ({ success: true as const, downloadId: 'd1', chunkSizeBytes: 4, sizeBytes: 5, name: 'file.txt' }));
        const chunkSpy = vi.fn(async (_req: { downloadId: string; index: number }) => ({
            success: true as const,
            contentBase64: Buffer.from('four').toString('base64'),
            isLast: true,
        }));
        const finalizeSpy = vi.fn(async (_req: { downloadId: string }) => ({ success: true as const }));
        const abortSpy = vi.fn(async (_req: { downloadId: string }) => ({ success: true as const }));

        await expect(downloadInChunks({
            init: initSpy,
            readChunk: chunkSpy,
            finalize: finalizeSpy,
            abort: abortSpy,
            writeBytes: async () => {},
        })).resolves.toEqual({ ok: false, error: 'Downloaded size did not match expected size' });

        expect(finalizeSpy).not.toHaveBeenCalled();
        expect(abortSpy).toHaveBeenCalledWith({ downloadId: 'd1' });
    });
});
