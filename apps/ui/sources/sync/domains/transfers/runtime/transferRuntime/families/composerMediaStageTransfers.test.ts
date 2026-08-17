import { createHash } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';

const machineRpcMock = vi.hoisted(() => vi.fn());
const getReadyServerFeaturesMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/guardedMachineRpc', () => ({
    callGuardedMachineRpcWithPolicy: (...args: unknown[]) => machineRpcMock(...args),
}));

vi.mock('@/sync/api/capabilities/getReadyServerFeatures', () => ({
    getReadyServerFeatures: (...args: unknown[]) => getReadyServerFeaturesMock(...args),
}));

describe('uploadComposerMediaStageFromReader', () => {
    beforeEach(() => {
        vi.resetModules();
    });

    afterEach(() => {
        machineRpcMock.mockReset();
        getReadyServerFeaturesMock.mockReset();
    });

    it('fails closed when an older daemon does not expose Composer media capability negotiation', async () => {
        const executionTarget = { serverId: 'server-current', machineId: 'machine-current' };
        getReadyServerFeaturesMock.mockResolvedValue(null);
        machineRpcMock.mockResolvedValue({
            error: 'Method not found',
            errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND,
        });

        const { getComposerMediaContentAvailability } = await import('./composerMediaStageTransfers');

        await expect(getComposerMediaContentAvailability({ executionTarget })).resolves.toEqual({ available: false });
        expect(machineRpcMock).toHaveBeenCalledWith(expect.objectContaining({
            method: RPC_METHODS.DAEMON_TRANSFER_COMPOSER_MEDIA_CAPABILITY_GET_V1,
            payload: {},
        }));
    });

    it('accepts only the current daemon Composer media capability fact', async () => {
        const executionTarget = { serverId: 'server-current', machineId: 'machine-current' };
        getReadyServerFeaturesMock.mockResolvedValue(null);
        machineRpcMock.mockResolvedValue({
            success: true,
            available: true,
            capability: 'composer.mediaContent.v1',
        });

        const { getComposerMediaContentAvailability } = await import('./composerMediaStageTransfers');

        await expect(getComposerMediaContentAvailability({ executionTarget })).resolves.toEqual({
            available: true,
            capability: 'composer.mediaContent.v1',
        });
    });

    it('falls back from direct import to the incumbent relay carrier and returns only a target-bound opaque handle', async () => {
        const executionTarget = { serverId: 'server-current', machineId: 'machine-current' };
        const owner = { pluginId: 'com.example.media', localId: 'composer' };
        const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00]);
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        const calls: Array<Readonly<{ method: string; payload: unknown }>> = [];
        const close = vi.fn(async () => {});
        getReadyServerFeaturesMock.mockResolvedValue(null);
        machineRpcMock.mockImplementation(async (input: Readonly<{ method: string; payload: unknown }>) => {
            calls.push(input);
            if (input.method === RPC_METHODS.DAEMON_DIRECT_TRANSFER_IMPORT_PREPARE) {
                return { success: false, error: 'Direct import endpoints unavailable' };
            }
            if (input.method === RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT) {
                return {
                    success: true,
                    uploadId: 'relay-upload-1',
                    chunkSizeBytes: 8,
                    recipientPublicKeyBase64: Buffer.alloc(32, 7).toString('base64'),
                };
            }
            if (input.method === RPC_METHODS.DAEMON_TRANSFER_UPLOAD_CHUNK) {
                return { success: true };
            }
            if (input.method === RPC_METHODS.DAEMON_TRANSFER_UPLOAD_FINALIZE) {
                return {
                    success: true,
                    path: 'Composer media stage',
                    sizeBytes: bytes.byteLength,
                    sha256,
                    result: {
                        v: 1,
                        id: 'opaque-content-1',
                        executionTarget,
                        owner,
                        mediaKind: 'image',
                        mimeType: 'image/png',
                        name: 'camera.png',
                        sizeBytes: bytes.byteLength,
                        sha256,
                    },
                };
            }
            if (input.method === RPC_METHODS.DAEMON_TRANSFER_UPLOAD_ABORT) {
                return { success: true };
            }
            throw new Error(`Unexpected machine RPC method: ${input.method}`);
        });

        const { uploadComposerMediaStageFromReader } = await import('./composerMediaStageTransfers');
        const result = await uploadComposerMediaStageFromReader({
            fileReader: {
                sizeBytes: bytes.byteLength,
                readBytes: async (offset, length) => bytes.subarray(offset, offset + length),
                close,
            },
            executionTarget,
            owner,
            mediaKind: 'image',
            mimeType: 'image/png',
            name: 'camera.png',
            sha256,
        });

        expect(result).toEqual({
            success: true,
            handle: {
                v: 1,
                id: 'opaque-content-1',
                executionTarget,
                owner,
                mediaKind: 'image',
                mimeType: 'image/png',
                name: 'camera.png',
                sizeBytes: bytes.byteLength,
                sha256,
            },
        });
        expect(calls[0]).toEqual(expect.objectContaining({
            method: RPC_METHODS.DAEMON_DIRECT_TRANSFER_IMPORT_PREPARE,
            payload: {
                t: 'composer_media_stage_upload_v1',
                workingDirectory: '/',
                executionTarget,
                owner,
                mediaKind: 'image',
                mimeType: 'image/png',
                name: 'camera.png',
                sizeBytes: bytes.byteLength,
                sha256,
            },
        }));
        expect(calls.find((call) => call.method === RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT)).toEqual(expect.objectContaining({
            method: RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT,
            payload: {
                t: 'composer_media_stage_upload_v1',
                executionTarget,
                owner,
                mediaKind: 'image',
                mimeType: 'image/png',
                name: 'camera.png',
                sizeBytes: bytes.byteLength,
                sha256,
            },
        }));
        expect(close).toHaveBeenCalledTimes(1);
        expect(getReadyServerFeaturesMock).toHaveBeenCalled();
    });

    it('inspects a bounded opaque stage range and releases it through the same target-scoped transfer caller', async () => {
        const executionTarget = { serverId: 'server-current', machineId: 'machine-current' };
        const owner = { pluginId: 'com.example.media', localId: 'composer' };
        const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d]);
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        const handle = {
            v: 1 as const,
            id: 'opaque-content-2',
            executionTarget,
            owner,
            mediaKind: 'image' as const,
            mimeType: 'image/png' as const,
            name: 'camera.png',
            sizeBytes: bytes.byteLength,
            sha256,
        };
        const calls: Array<Readonly<{ method: string; payload: unknown }>> = [];
        getReadyServerFeaturesMock.mockResolvedValue(null);
        machineRpcMock.mockImplementation(async (input: Readonly<{ method: string; payload: unknown }>) => {
            calls.push(input);
            if (input.method === RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_INIT) {
                return {
                    success: true,
                    downloadId: 'inspection-1',
                    chunkSizeBytes: 2,
                    sizeBytes: 2,
                    name: handle.name,
                };
            }
            if (input.method === RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_CHUNK) {
                return {
                    success: true,
                    contentBase64: Buffer.from(bytes.subarray(2, 4)).toString('base64'),
                    isLast: true,
                };
            }
            if (input.method === RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_FINALIZE) {
                return { success: true };
            }
            if (input.method === RPC_METHODS.DAEMON_TRANSFER_COMPOSER_MEDIA_RELEASE) {
                return { success: true };
            }
            throw new Error(`Unexpected machine RPC method: ${input.method}`);
        });

        const { inspectComposerContent, releaseComposerContent } = await import('./composerMediaStageTransfers');
        const inspection = await inspectComposerContent(handle, { offset: 2, maxBytes: 2 });
        expect(inspection).toEqual({
            success: true,
            result: {
                offset: 2,
                bytesBase64: Buffer.from(bytes.subarray(2, 4)).toString('base64'),
                eof: false,
            },
        });
        await expect(releaseComposerContent(handle)).resolves.toEqual({ success: true });
        expect(calls.find((call) => call.method === RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_INIT)).toEqual(expect.objectContaining({
            payload: expect.objectContaining({
                t: 'composer_media_stage_inspect_v1',
                handle,
                offset: 2,
                maxBytes: 2,
                recipientPublicKeyBase64: expect.any(String),
            }),
        }));
        expect(calls.find((call) => call.method === RPC_METHODS.DAEMON_TRANSFER_COMPOSER_MEDIA_RELEASE)).toEqual(expect.objectContaining({
            payload: { handle },
        }));
    });
});
