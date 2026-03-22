import { FeaturesResponseSchema, type FeaturesResponse } from '@happier-dev/protocol';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import { describe, expect, it, vi } from 'vitest';

import { createEncryptedTransferChunkEnvelope } from '@/sync/domains/files/transfers/transferChunkEncryption';

import {
    downloadBulkJsonPayload,
    downloadBulkPayloadToFile,
    resolveBulkTransferPolicyAndRoute,
    uploadBulkJsonPayload,
    uploadBulkPayloadFromFile,
} from './index';

function createServerFeaturesResponse(partial?: Readonly<{
    features?: unknown;
    capabilities?: unknown;
}>): FeaturesResponse {
    return FeaturesResponseSchema.parse({
        features: {
            machines: {
                enabled: true,
                transfer: {
                    enabled: true,
                    directPeer: {
                        enabled: false,
                    },
                    serverRouted: {
                        enabled: true,
                    },
                },
            },
            ...(partial?.features ?? {}),
        },
        capabilities: {
            ...(partial?.capabilities ?? {}),
        },
    });
}

describe('bulkTransferPipeline', () => {
    it('resolves a server-routed route through the shared policy helper', () => {
        expect(resolveBulkTransferPolicyAndRoute({
            serverId: 'server-1',
            machineTargetAvailable: false,
            sessionRpcAvailable: true,
            transferSizeBytes: 128,
            serverFeatures: createServerFeaturesResponse({
                capabilities: {
                    machines: {
                        transfer: {
                            serverRouted: {
                                maxBytes: 256,
                            },
                        },
                    },
                },
            }),
        })).toEqual({
            kind: 'selected',
            route: {
                kind: 'server_routed_stream',
                serverId: 'server-1',
            },
        });
    });

    it('fails closed when the payload exceeds the server-routed limit', () => {
        expect(resolveBulkTransferPolicyAndRoute({
            serverId: 'server-1',
            machineTargetAvailable: false,
            sessionRpcAvailable: true,
            transferSizeBytes: 512,
            serverFeatures: createServerFeaturesResponse({
                capabilities: {
                    machines: {
                        transfer: {
                            serverRouted: {
                                maxBytes: 256,
                            },
                        },
                    },
                },
            }),
        })).toEqual({
            kind: 'unavailable',
            response: {
                success: false,
                error: 'File exceeds the server-routed transfer size limit',
                errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
            },
        });
    });

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

    it('downloads an encrypted payload into the provided file sink and closes it on success', async () => {
        const written: Uint8Array[] = [];
        const close = vi.fn(async () => {});
        const cleanup = vi.fn(async () => {});
        let recipientPublicKeyBase64 = '';

        await expect(downloadBulkPayloadToFile({
            destination: {
                writeBytes: async (bytes) => {
                    written.push(bytes);
                },
                close,
                cleanup,
            },
            init: async (request) => {
                recipientPublicKeyBase64 = request.recipientPublicKeyBase64;
                return {
                    success: true as const,
                    downloadId: 'download-1',
                    chunkSizeBytes: 4,
                    sizeBytes: 5,
                    name: 'hello.txt',
                };
            },
            readChunk: async (request) => {
                if (request.index === 0) {
                    return {
                        success: true as const,
                        ...await createEncryptedTransferChunkEnvelope({
                            transferId: request.downloadId,
                            sequence: request.index,
                            payload: new TextEncoder().encode('he'),
                            recipientPublicKeyBase64,
                            randomBytes: (length) => new Uint8Array(length).fill(11),
                        }),
                        isLast: false,
                    };
                }

                return {
                    success: true as const,
                    ...await createEncryptedTransferChunkEnvelope({
                        transferId: request.downloadId,
                        sequence: request.index,
                        payload: new TextEncoder().encode('llo'),
                        recipientPublicKeyBase64,
                        randomBytes: (length) => new Uint8Array(length).fill(13),
                    }),
                    isLast: true,
                };
            },
            finalize: async (_request) => ({ success: true as const }),
        })).resolves.toEqual({
            ok: true,
            name: 'hello.txt',
            sizeBytes: 5,
        });

        expect(new TextDecoder().decode(Uint8Array.from(written.flatMap((chunk) => Array.from(chunk))))).toBe('hello');
        expect(close).toHaveBeenCalledTimes(1);
        expect(cleanup).not.toHaveBeenCalled();
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

    it('downloads a JSON payload through the shared bulk download surface and parses it', async () => {
        let recipientPublicKeyBase64 = '';

        await expect(downloadBulkJsonPayload({
            init: async (request) => {
                recipientPublicKeyBase64 = request.recipientPublicKeyBase64;
                return {
                    success: true as const,
                    downloadId: 'download-json-1',
                    chunkSizeBytes: 4096,
                    sizeBytes: 28,
                    name: 'metadata.json',
                };
            },
            readChunk: async (request) => ({
                success: true as const,
                ...await createEncryptedTransferChunkEnvelope({
                    transferId: request.downloadId,
                    sequence: request.index,
                    payload: new TextEncoder().encode(JSON.stringify({ kind: 'metadata', count: 2 })),
                    recipientPublicKeyBase64,
                    randomBytes: (length) => new Uint8Array(length).fill(17),
                }),
                isLast: true,
            }),
            finalize: async () => ({ success: true as const }),
            parsePayload: (value) => {
                const candidate = value as { kind?: string; count?: number };
                return candidate.kind === 'metadata' && typeof candidate.count === 'number' ? candidate : null;
            },
        })).resolves.toEqual({
            ok: true,
            payload: {
                kind: 'metadata',
                count: 2,
            },
        });
    });

    it('fails closed when downloading a JSON payload that exceeds the bulk JSON max bytes', async () => {
        const previous = process.env.EXPO_PUBLIC_HAPPIER_BULK_TRANSFER_JSON_MAX_BYTES;
        process.env.EXPO_PUBLIC_HAPPIER_BULK_TRANSFER_JSON_MAX_BYTES = '8';

        try {
            let initCalled = 0;
            let readChunkCalled = 0;

            await expect(downloadBulkJsonPayload({
                init: async (request) => {
                    initCalled += 1;
                    return {
                        success: true as const,
                        downloadId: 'download-json-too-large',
                        chunkSizeBytes: 4096,
                        sizeBytes: 9,
                        name: 'too-large.json',
                    };
                },
                readChunk: async () => {
                    readChunkCalled += 1;
                    throw new Error('readChunk should not be called when the payload is rejected by policy');
                },
                finalize: async () => ({ success: true as const }),
                parsePayload: () => null,
            })).resolves.toEqual({
                ok: false,
                error: expect.stringContaining('exceeds'),
            });

            expect(initCalled).toBe(1);
            expect(readChunkCalled).toBe(0);
        } finally {
            if (previous === undefined) {
                delete process.env.EXPO_PUBLIC_HAPPIER_BULK_TRANSFER_JSON_MAX_BYTES;
            } else {
                process.env.EXPO_PUBLIC_HAPPIER_BULK_TRANSFER_JSON_MAX_BYTES = previous;
            }
        }
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
});
