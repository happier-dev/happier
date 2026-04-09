import { describe, expect, it, vi } from 'vitest';

import { downloadBulkPayloadViaMachineRpcToDestination } from './downloadBulkPayloadViaMachineRpcToDestination';

describe('downloadBulkPayloadViaMachineRpcToDestination', () => {
    it('cleans up the destination when init throws', async () => {
        const cleanup = vi.fn(async () => {});
        const close = vi.fn(async () => {});

        const result = await downloadBulkPayloadViaMachineRpcToDestination({
            destination: {
                writeBytes: async () => {},
                close,
                cleanup,
            },
            init: async () => {
                throw new Error('init exploded');
            },
            readChunk: async () => {
                throw new Error('unexpected readChunk');
            },
            finalize: async () => ({ success: true }),
        });

        expect(result).toEqual({
            ok: false,
            error: 'init exploded',
        });
        expect(cleanup).toHaveBeenCalledTimes(1);
        expect(close).not.toHaveBeenCalled();
    });

    it('preserves the init errorCode when init returns a failure response', async () => {
        const cleanup = vi.fn(async () => {});
        const close = vi.fn(async () => {});

        const result = await downloadBulkPayloadViaMachineRpcToDestination({
            destination: {
                writeBytes: async () => {},
                close,
                cleanup,
            },
            init: async () => ({
                success: false,
                error: 'init failed',
                errorCode: 'INIT_FAILED',
            }),
            readChunk: async () => {
                throw new Error('unexpected readChunk');
            },
            finalize: async () => ({ success: true }),
        });

        expect(result).toEqual({
            ok: false,
            error: 'init failed',
            errorCode: 'INIT_FAILED',
        });
        expect(cleanup).toHaveBeenCalledTimes(1);
        expect(close).not.toHaveBeenCalled();
    });

    it('preserves the chunk errorCode when a chunk request fails', async () => {
        const cleanup = vi.fn(async () => {});
        const close = vi.fn(async () => {});

        const result = await downloadBulkPayloadViaMachineRpcToDestination({
            destination: {
                writeBytes: async () => {},
                close,
                cleanup,
            },
            init: async () => ({
                success: true,
                downloadId: 'download-1',
                chunkSizeBytes: 1,
                sizeBytes: 1,
                name: 'payload.bin',
            }),
            readChunk: async () => ({
                success: false,
                error: 'chunk failed',
                errorCode: 'CHUNK_FAILED',
            }),
            finalize: async () => ({ success: true }),
        });

        expect(result).toEqual({
            ok: false,
            error: 'chunk failed',
            errorCode: 'CHUNK_FAILED',
        });
        expect(cleanup).toHaveBeenCalledTimes(1);
        expect(close).not.toHaveBeenCalled();
    });

    it('preserves the finalize errorCode when finalize returns a failure response', async () => {
        const cleanup = vi.fn(async () => {});
        const close = vi.fn(async () => {});

        const result = await downloadBulkPayloadViaMachineRpcToDestination({
            destination: {
                writeBytes: async () => {},
                close,
                cleanup,
            },
            init: async () => ({
                success: true,
                downloadId: 'download-1',
                chunkSizeBytes: 1,
                sizeBytes: 1,
                name: 'payload.bin',
            }),
            readChunk: async () => ({
                success: true,
                contentBase64: 'YQ==',
                isLast: true,
            }),
            finalize: async () => ({
                success: false,
                error: 'finalize failed',
                errorCode: 'FINALIZE_FAILED',
            }),
        });

        expect(result).toEqual({
            ok: false,
            error: 'finalize failed',
            errorCode: 'FINALIZE_FAILED',
        });
        expect(cleanup).toHaveBeenCalledTimes(1);
        expect(close).not.toHaveBeenCalled();
    });
});
