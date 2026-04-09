import { describe, expect, it, vi } from 'vitest';

import { uploadBulkJsonPayload } from './uploadBulkJsonPayload';
import { uploadBulkPayloadFromFile } from './uploadBulkPayloadFromFile';

describe('bulk transfer low-level helpers', () => {
    it('uploads a file-backed payload and closes the reader after finalizing', async () => {
        const close = vi.fn(async () => {});
        const readBytes = vi.fn(async (offset: number, length: number) =>
            new TextEncoder().encode('hello').subarray(offset, offset + length),
        );
        const sendChunk = vi.fn(async (_request: {
            uploadId: string;
            index: number;
            payloadBase64: string;
            encryptedDataKeyEnvelopeBase64: string;
        }) => ({ success: true as const }));
        const finalize = vi.fn(async (_request: { uploadId: string }) => ({
            success: true as const,
            remotePath: '/tmp/hello.txt',
        }));

        await expect(uploadBulkPayloadFromFile({
            fileReader: {
                sizeBytes: 5,
                readBytes,
                close,
            },
            init: async () => ({
                success: true as const,
                uploadId: 'upload-1',
                chunkSizeBytes: 2,
                recipientPublicKeyBase64: Buffer.alloc(32, 9).toString('base64'),
            }),
            sendChunk,
            finalize,
        })).resolves.toEqual({
            success: true,
            remotePath: '/tmp/hello.txt',
        });

        expect(readBytes).toHaveBeenCalledTimes(3);
        expect(sendChunk).toHaveBeenCalledTimes(3);
        expect(finalize).toHaveBeenCalledWith({ uploadId: 'upload-1' });
        expect(close).toHaveBeenCalledTimes(1);
    });

    it('uploads a JSON payload through the shared bulk upload surface and parses the finalized response', async () => {
        const init = vi.fn(async (request: { sizeBytes: number }) => ({
            success: true as const,
            uploadId: 'upload-json-1',
            chunkSizeBytes: 4096,
            recipientPublicKeyBase64: Buffer.alloc(32, 7).toString('base64'),
            acceptedSizeBytes: request.sizeBytes,
        }));

        await expect(uploadBulkJsonPayload({
            payload: {
                kind: 'metadata',
                values: ['a', 'b'],
            },
            init,
            sendChunk: async () => ({ success: true as const }),
            finalize: async () => ({
                success: true as const,
                response: {
                    uploadId: 'remote-json-1',
                },
            }),
            parseResponse: (value) => {
                const response = (value as { response?: { uploadId?: string } }).response;
                return typeof response?.uploadId === 'string' ? response : null;
            },
        })).resolves.toEqual({
            ok: true,
            response: {
                uploadId: 'remote-json-1',
            },
        });

        expect(init).toHaveBeenCalledWith({
            sizeBytes: new TextEncoder().encode(JSON.stringify({
                kind: 'metadata',
                values: ['a', 'b'],
            })).byteLength,
        });
    });

    it('fails closed when uploading a JSON payload that exceeds the bulk JSON max bytes', async () => {
        const previous = process.env.EXPO_PUBLIC_HAPPIER_BULK_TRANSFER_JSON_MAX_BYTES;
        process.env.EXPO_PUBLIC_HAPPIER_BULK_TRANSFER_JSON_MAX_BYTES = '8';

        try {
            const init = vi.fn(async () => {
                throw new Error('init should not be called when the payload is rejected by policy');
            });

            await expect(uploadBulkJsonPayload({
                payload: {
                    kind: 'metadata',
                    values: ['a', 'b'],
                },
                init,
                sendChunk: async () => ({ success: true as const }),
                finalize: async () => ({ success: true as const }),
                parseResponse: () => null,
            })).resolves.toEqual({
                ok: false,
                error: expect.stringContaining('exceeds'),
            });

            expect(init).not.toHaveBeenCalled();
        } finally {
            if (previous === undefined) {
                delete process.env.EXPO_PUBLIC_HAPPIER_BULK_TRANSFER_JSON_MAX_BYTES;
            } else {
                process.env.EXPO_PUBLIC_HAPPIER_BULK_TRANSFER_JSON_MAX_BYTES = previous;
            }
        }
    });

    it('rejects oversized JSON payloads without calling JSON.stringify (preflight avoids unbounded memory)', async () => {
        const previous = process.env.EXPO_PUBLIC_HAPPIER_BULK_TRANSFER_JSON_MAX_BYTES;
        process.env.EXPO_PUBLIC_HAPPIER_BULK_TRANSFER_JSON_MAX_BYTES = '1';

            const original = JSON.stringify;
            try {
                // If `uploadBulkJsonPayload` still stringifies before enforcing the limit, this test will fail.
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                JSON.stringify = (() => {
                    throw new Error('JSON.stringify should not be called for oversized payloads');
                }) as any;

            const init = vi.fn(async () => ({
                success: true as const,
                uploadId: 'upload-json-should-not-init',
                chunkSizeBytes: 4096,
                recipientPublicKeyBase64: Buffer.alloc(32, 7).toString('base64'),
            }));

            await expect(uploadBulkJsonPayload({
                payload: { a: 'b' },
                init,
                sendChunk: async () => ({ success: true as const }),
                finalize: async () => ({ success: true as const }),
                parseResponse: () => null,
            })).resolves.toEqual({
                ok: false,
                error: expect.stringContaining('exceeds'),
            });

            expect(init).not.toHaveBeenCalled();
            } finally {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                JSON.stringify = original as any;
                if (previous === undefined) {
                    delete process.env.EXPO_PUBLIC_HAPPIER_BULK_TRANSFER_JSON_MAX_BYTES;
                } else {
                process.env.EXPO_PUBLIC_HAPPIER_BULK_TRANSFER_JSON_MAX_BYTES = previous;
            }
        }
    });
});
