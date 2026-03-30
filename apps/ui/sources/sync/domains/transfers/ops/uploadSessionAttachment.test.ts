import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type RpcResponse = any;
const nativeOpenSpy = vi.fn();
const nativeCloseSpy = vi.fn();
const sessionRPCSpy = vi.fn(async (_sessionId: string, _method: string, _payload: unknown): Promise<RpcResponse> => ({
    success: false,
    error: 'unconfigured',
}));
const getReadyServerFeaturesSpy = vi.fn();
const uploadBulkPayloadFromFileSpy = vi.fn();
const uploadDaemonSessionAttachmentFromReaderSpy = vi.fn();
const randomUUIDSpy = vi.fn(() => '12345678-0000-4000-8000-123456789abc');
const isRuntimeFeatureEnabledSpy = vi.fn<(params: unknown) => Promise<boolean>>(async (_params) => true);
const recipientPublicKeyBase64 = Buffer.alloc(32, 7).toString('base64');
const resolveLocalUploadSourceSizeBytesSpy = vi.fn();
let localUploadSourceReaderActual: typeof import('@/sync/runtime/files/localUploadSourceReader') | null = null;

async function driveMockBulkUpload(params: Readonly<{
    fileReader: Readonly<{
        sizeBytes: number;
        readBytes: (offset: number, length: number) => Promise<Uint8Array>;
        close: () => Promise<void>;
    }>;
    init: () => Promise<
        | Readonly<{ success: true; uploadId: string; chunkSizeBytes: number; recipientPublicKeyBase64: string }>
        | Readonly<{ success: false; error: string; errorCode?: string }>
    >;
    sendChunk: (request: Readonly<{
        uploadId: string;
        index: number;
        payloadBase64: string;
        encryptedDataKeyEnvelopeBase64: string;
    }>) => Promise<{ success: boolean; error?: string }>;
    finalize: (request: Readonly<{ uploadId: string }>) => Promise<Readonly<{ success: boolean; error?: string }>>;
    onProgress?: ((progress: Readonly<{ uploadedBytes: number; totalBytes: number }>) => void) | null;
}>): Promise<Readonly<{ success: boolean; error?: string }>> {
    const initResponse = await params.init();
    if (!initResponse.success) {
        return initResponse;
    }

    try {
        let offset = 0;
        let index = 0;
        while (offset < params.fileReader.sizeBytes) {
            const length = Math.min(initResponse.chunkSizeBytes, params.fileReader.sizeBytes - offset);
            const bytes = await params.fileReader.readBytes(offset, length);
            await params.sendChunk({
                uploadId: initResponse.uploadId,
                index,
                payloadBase64: Buffer.from(bytes).toString('base64'),
                encryptedDataKeyEnvelopeBase64: `envelope-${index}`,
            });
            offset += bytes.byteLength;
            index += 1;
            params.onProgress?.({
                uploadedBytes: offset,
                totalBytes: params.fileReader.sizeBytes,
            });
        }

        return await params.finalize({ uploadId: initResponse.uploadId });
    } finally {
        await params.fileReader.close();
    }
}

vi.mock('@/sync/api/session/apiSocket', () => ({
    apiSocket: {
        machineRPC: (sessionId: string, method: string, payload: any) => sessionRPCSpy(sessionId, method, payload),
        sessionRPC: (sessionId: string, method: string, payload: any) => sessionRPCSpy(sessionId, method, payload),
    },
}));

vi.mock('@/sync/domains/features/featureDecisionInputs', () => ({
    isRuntimeFeatureEnabled: (params: unknown) => isRuntimeFeatureEnabledSpy(params),
}));

vi.mock('@/sync/api/capabilities/getReadyServerFeatures', () => ({
    getReadyServerFeatures: (...args: unknown[]) => getReadyServerFeaturesSpy(...args),
}));

vi.mock('@/sync/domains/transfers/runtime/bulkTransferPipeline/uploadBulkPayloadFromFile', async () => {
    const actual = await vi.importActual<typeof import('@/sync/domains/transfers/runtime/bulkTransferPipeline/uploadBulkPayloadFromFile')>(
        '@/sync/domains/transfers/runtime/bulkTransferPipeline/uploadBulkPayloadFromFile',
    );

    return {
        ...actual,
        uploadBulkPayloadFromFile: (...args: unknown[]) => uploadBulkPayloadFromFileSpy(...args),
    };
});

vi.mock('@/sync/domains/transfers/runtime/bulkTransferPipeline/daemonSessionAttachments', async () => {
    const actual = await vi.importActual<typeof import('@/sync/domains/transfers/runtime/bulkTransferPipeline/daemonSessionAttachments')>(
        '@/sync/domains/transfers/runtime/bulkTransferPipeline/daemonSessionAttachments',
    );

    return {
        ...actual,
        uploadDaemonSessionAttachmentFromReader: (params: unknown) => {
            uploadDaemonSessionAttachmentFromReaderSpy(params);
            return (actual as any).uploadDaemonSessionAttachmentFromReader(params);
        },
    };
});

vi.mock('@/sync/runtime/files/localUploadSourceReader', async () => {
    const actual = await vi.importActual<typeof import('@/sync/runtime/files/localUploadSourceReader')>(
        '@/sync/runtime/files/localUploadSourceReader',
    );
    localUploadSourceReaderActual = actual;
    if (!resolveLocalUploadSourceSizeBytesSpy.getMockImplementation()) {
        resolveLocalUploadSourceSizeBytesSpy.mockImplementation((source: unknown) => (actual as any).resolveLocalUploadSourceSizeBytes(source));
    }

    return {
        ...actual,
        resolveLocalUploadSourceSizeBytes: (source: unknown) => resolveLocalUploadSourceSizeBytesSpy(source),
    };
});

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId', () => ({
    resolvePreferredServerIdForSessionId: () => 'server-owned',
}));

vi.mock('@/sync/domains/transfers/runtime/transferRouteCache', () => ({
    readCachedMachineRpcDirectRoute: () => ({ status: 'unknown' }),
    recordCachedMachineRpcDirectRouteViable: () => {},
    recordCachedMachineRpcDirectRouteUnavailable: () => {},
}));

vi.mock('@/sync/ops/sessionMachineTarget', () => ({
    readMachineTargetForSession: () => ({ machineId: 'm1', basePath: '/tmp' }),
    canUseSessionRpc: () => true,
    resolveMachinePathFromSessionBase: ({ basePath, requestPath }: { basePath: string; requestPath?: string }) =>
        requestPath && requestPath !== '.' ? `${basePath}/${requestPath}` : basePath,
    shouldFallbackToSessionRpc: () => true,
}));

vi.mock('@/platform/randomUUID', () => ({
    randomUUID: () => randomUUIDSpy(),
}));

vi.mock('expo-file-system', () => {
    class FakeFileHandle {
        offset: number | null = 0;
        size: number | null;
        private bytes: Uint8Array;
        constructor(bytes: Uint8Array, size: number | null) {
            this.bytes = bytes;
            this.size = size;
        }
        close() { }
        readBytes(length: number): Uint8Array {
            const offset = this.offset ?? 0;
            const slice = this.bytes.slice(offset, offset + length);
            this.offset = offset + slice.byteLength;
            return slice;
        }
        writeBytes(): void {
            throw new Error('not implemented');
        }
    }

    class FakeFile {
        uri: string;
        constructor(uri: string) {
            this.uri = uri;
        }
        open() {
            nativeOpenSpy();
            const size = this.uri.includes('unknown') ? null : 5;
            const handle = new FakeFileHandle(new TextEncoder().encode('hello'), size);
            const close = handle.close.bind(handle);
            handle.close = () => {
                nativeCloseSpy();
                close();
            };
            return handle;
        }
    }

    return { File: FakeFile };
});

afterEach(() => {
    sessionRPCSpy.mockReset();
    getReadyServerFeaturesSpy.mockReset();
    uploadBulkPayloadFromFileSpy.mockReset();
    uploadDaemonSessionAttachmentFromReaderSpy.mockReset();
    nativeOpenSpy.mockReset();
    nativeCloseSpy.mockReset();
    randomUUIDSpy.mockClear();
    isRuntimeFeatureEnabledSpy.mockClear();
    isRuntimeFeatureEnabledSpy.mockImplementation(async () => true);
    resolveLocalUploadSourceSizeBytesSpy.mockClear();
    if (localUploadSourceReaderActual) {
        resolveLocalUploadSourceSizeBytesSpy.mockImplementation((source: unknown) =>
            (localUploadSourceReaderActual as any).resolveLocalUploadSourceSizeBytes(source),
        );
    }
    delete process.env.EXPO_PUBLIC_HAPPIER_FILES_UPLOAD_PREFLIGHT_SIZE_TIMEOUT_MS;
    vi.useRealTimers();
});

describe('uploadSessionAttachment', () => {
    beforeEach(() => {
        getReadyServerFeaturesSpy.mockResolvedValue(FeaturesResponseSchema.parse({
            features: {
                machines: {
                    enabled: true,
                    transfer: {
                        enabled: true,
                        directPeer: { enabled: true },
                        serverRouted: { enabled: true },
                    },
                },
            },
            capabilities: {},
        }));
        uploadBulkPayloadFromFileSpy.mockImplementation(async (params: any) => await driveMockBulkUpload(params));
    });

    it('uploads a file through the canonical attachment upload init and returns the finalized path', async () => {
        const { sessionAttachmentsUploadFile } = await import('./uploadSessionAttachment');

        uploadBulkPayloadFromFileSpy.mockImplementation(async (params: any) => {
            expect(params.fileReader.sizeBytes).toBe(5);
            expect(await params.fileReader.readBytes(0, 5)).toEqual(new TextEncoder().encode('hello'));
            await params.fileReader.close();

            const initResponse = await params.init();
            expect(initResponse).toMatchObject({
                success: true,
                uploadId: 'u1',
                chunkSizeBytes: 2,
                recipientPublicKeyBase64,
            });

            await params.sendChunk({
                uploadId: 'u1',
                index: 0,
                payloadBase64: 'payload-1',
                encryptedDataKeyEnvelopeBase64: 'envelope-1',
            });
            await params.sendChunk({
                uploadId: 'u1',
                index: 1,
                payloadBase64: 'payload-2',
                encryptedDataKeyEnvelopeBase64: 'envelope-2',
            });
            await params.sendChunk({
                uploadId: 'u1',
                index: 2,
                payloadBase64: 'payload-3',
                encryptedDataKeyEnvelopeBase64: 'envelope-3',
            });

            return await params.finalize({ uploadId: 'u1' });
        });

        sessionRPCSpy.mockImplementation(async (_sessionId: string, method: string, payload: any) => {
            if (method === RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_INIT) {
                expect(payload).toMatchObject({
                    t: 'session_attachment_upload_v1',
                    messageLocalId: 'm1',
                    fileName: 'hello.txt',
                    sizeBytes: 5,
                    uploadLocation: 'workspace',
                    workspaceRelativeDir: '.happier/uploads',
                    vcsIgnoreStrategy: 'git_info_exclude',
                    vcsIgnoreWritesEnabled: true,
                });
                return { success: true, uploadId: 'u1', chunkSizeBytes: 2, recipientPublicKeyBase64 };
            }
            if (method === RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_CHUNK) return { success: true };
            if (method === RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_FINALIZE) {
                return {
                    success: true,
                    path: '.happier/uploads/messages/m1/12345678-hello.txt',
                    sizeBytes: 5,
                    sha256: 'h1',
                };
            }
            return { success: false, error: `unexpected method ${method}` };
        });

        const file = typeof File === 'function'
            ? new File([new TextEncoder().encode('hello')], 'hello.txt', { type: 'text/plain' })
            : ({ name: 'hello.txt', size: 5, type: 'text/plain', slice: () => new Blob([]) } as any);

        const res = await sessionAttachmentsUploadFile({
            sessionId: 's1',
            file: { kind: 'web', file },
            messageLocalId: 'm1',
            config: {
                uploadLocation: 'workspace',
                workspaceRelativeDir: '.happier/uploads',
                vcsIgnoreStrategy: 'git_info_exclude',
                vcsIgnoreWritesEnabled: true,
                maxFileBytes: 25 * 1024 * 1024,
            },
        });

        expect(getReadyServerFeaturesSpy).toHaveBeenCalled();
        expect(uploadDaemonSessionAttachmentFromReaderSpy).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 's1',
            request: expect.objectContaining({
                messageLocalId: 'm1',
                fileName: 'hello.txt',
                sizeBytes: 5,
                uploadLocation: 'workspace',
                workspaceRelativeDir: '.happier/uploads',
                vcsIgnoreStrategy: 'git_info_exclude',
                vcsIgnoreWritesEnabled: true,
            }),
        }));
        expect(sessionRPCSpy).toHaveBeenCalledWith(
            'm1',
            RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_INIT,
            expect.objectContaining({
                t: 'session_attachment_upload_v1',
                messageLocalId: 'm1',
                fileName: 'hello.txt',
                sizeBytes: 5,
                uploadLocation: 'workspace',
                workspaceRelativeDir: '.happier/uploads',
                vcsIgnoreStrategy: 'git_info_exclude',
                vcsIgnoreWritesEnabled: true,
            }),
        );
        expect(sessionRPCSpy).toHaveBeenCalled();
        expect(uploadBulkPayloadFromFileSpy).toHaveBeenCalledTimes(1);
        expect(res).toMatchObject({ success: true });
        expect((res as any).path).toBe('.happier/uploads/messages/m1/12345678-hello.txt');

        const calls = sessionRPCSpy.mock.calls.map((c) => ({ method: c[1], payload: c[2] }));
        expect(calls.map((call) => call.method)).toContain(RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_INIT);
        expect(calls.map((call) => call.method)).toContain(RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_FINALIZE);
    });

    it('calls onProgress after each uploaded chunk', async () => {
        const { sessionAttachmentsUploadFile } = await import('./uploadSessionAttachment');

        sessionRPCSpy.mockImplementation(async (_sessionId: string, method: string) => {
            if (method === RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_INIT) {
                return { success: true, uploadId: 'u1', chunkSizeBytes: 2, recipientPublicKeyBase64 };
            }
            if (method === RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_CHUNK) return { success: true };
            if (method === RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_FINALIZE) {
                return { success: true, path: '.happier/uploads/messages/m1/12345678-hello.txt', sizeBytes: 5, sha256: 'h1' };
            }
            return { success: false, error: `unexpected method ${method}` };
        });

        const file = typeof File === 'function'
            ? new File([new TextEncoder().encode('hello')], 'hello.txt', { type: 'text/plain' })
            : ({ name: 'hello.txt', size: 5, type: 'text/plain', slice: () => new Blob([]) } as any);

        const progressSpy = vi.fn();

        const res = await sessionAttachmentsUploadFile({
            sessionId: 's1',
            file: { kind: 'web', file },
            messageLocalId: 'm1',
            config: {
                uploadLocation: 'workspace',
                workspaceRelativeDir: '.happier/uploads',
                vcsIgnoreStrategy: 'git_info_exclude',
                vcsIgnoreWritesEnabled: true,
                maxFileBytes: 25 * 1024 * 1024,
            },
            onProgress: progressSpy,
        });

        expect(res).toMatchObject({ success: true });
        expect(progressSpy.mock.calls.length).toBeGreaterThan(1);

        const last = progressSpy.mock.calls.at(-1)?.[0] ?? null;
        expect(last).toMatchObject({ uploadedBytes: 5, totalBytes: 5 });
    });

    it('uploads a native file through the canonical attachment upload init and closes the native handle', async () => {
        const { sessionAttachmentsUploadFile } = await import('./uploadSessionAttachment');

        sessionRPCSpy.mockImplementation(async (_sessionId: string, method: string) => {
            if (method === RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_INIT) {
                return { success: true, uploadId: 'u1', chunkSizeBytes: 2, recipientPublicKeyBase64 };
            }
            if (method === RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_CHUNK) return { success: true };
            if (method === RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_FINALIZE) {
                return { success: true, path: '.happier/uploads/messages/m1/12345678-hello.txt', sizeBytes: 5, sha256: 'h1' };
            }
            return { success: false, error: `unexpected method ${method}` };
        });

        const res = await sessionAttachmentsUploadFile({
            sessionId: 's1',
            file: { kind: 'native', uri: 'file:///tmp/hello.txt', name: 'hello.txt', sizeBytes: 5, mimeType: 'text/plain' },
            messageLocalId: 'm1',
            config: {
                uploadLocation: 'workspace',
                workspaceRelativeDir: '.happier/uploads',
                vcsIgnoreStrategy: 'git_info_exclude',
                vcsIgnoreWritesEnabled: true,
                maxFileBytes: 25 * 1024 * 1024,
            },
        });

        expect(res).toMatchObject({ success: true });
        expect((res as any).path).toBe('.happier/uploads/messages/m1/12345678-hello.txt');
        expect(nativeOpenSpy).toHaveBeenCalledTimes(1);
        expect(nativeCloseSpy).toHaveBeenCalledTimes(1);

        expect(sessionRPCSpy).toHaveBeenCalledWith(
            expect.any(String),
            RPC_METHODS.DAEMON_BULK_TRANSFER_UPLOAD_INIT,
            expect.objectContaining({
                t: 'session_attachment_upload_v1',
                messageLocalId: 'm1',
            fileName: 'hello.txt',
            sizeBytes: 5,
            uploadLocation: 'workspace',
            workspaceRelativeDir: '.happier/uploads',
            vcsIgnoreStrategy: 'git_info_exclude',
            vcsIgnoreWritesEnabled: true,
            }),
        );
    });

    it('fails when the attachment size cannot be resolved', async () => {
        const { sessionAttachmentsUploadFile } = await import('./uploadSessionAttachment');

        const res = await sessionAttachmentsUploadFile({
            sessionId: 's1',
            file: { kind: 'native', uri: 'file:///tmp/unknown.txt', name: 'unknown.txt', sizeBytes: null, mimeType: 'text/plain' },
            messageLocalId: 'm1',
            config: {
                uploadLocation: 'workspace',
                workspaceRelativeDir: '.happier/uploads',
                vcsIgnoreStrategy: 'git_info_exclude',
                vcsIgnoreWritesEnabled: true,
                maxFileBytes: 25 * 1024 * 1024,
            },
        });

        expect(res).toEqual({ success: false, error: 'Unknown attachment size' });
        expect(sessionRPCSpy).not.toHaveBeenCalled();
        expect(uploadBulkPayloadFromFileSpy).not.toHaveBeenCalled();
    });

    it('fails closed when native attachment size resolution times out', async () => {
        vi.useFakeTimers();
        process.env.EXPO_PUBLIC_HAPPIER_FILES_UPLOAD_PREFLIGHT_SIZE_TIMEOUT_MS = '50';
        resolveLocalUploadSourceSizeBytesSpy.mockImplementation(() => new Promise(() => {}));

        const { sessionAttachmentsUploadFile } = await import('./uploadSessionAttachment');

        const resPromise = sessionAttachmentsUploadFile({
            sessionId: 's1',
            file: { kind: 'native', uri: 'file:///tmp/hanging.txt', name: 'hanging.txt', sizeBytes: null, mimeType: 'text/plain' },
            messageLocalId: 'm1',
            config: {
                uploadLocation: 'workspace',
                workspaceRelativeDir: '.happier/uploads',
                vcsIgnoreStrategy: 'git_info_exclude',
                vcsIgnoreWritesEnabled: true,
                maxFileBytes: 25 * 1024 * 1024,
            },
        });

        const racedPromise = Promise.race([
            resPromise,
            new Promise<unknown>((resolve) => setTimeout(() => resolve({ timeout: true }), 100)),
        ]);

        await vi.advanceTimersByTimeAsync(100);

        const raced = await racedPromise;

        expect(raced).toEqual({ success: false, error: 'Upload preflight size resolution timed out' });
        expect(sessionRPCSpy).not.toHaveBeenCalled();
        expect(uploadBulkPayloadFromFileSpy).not.toHaveBeenCalled();
    });

    it('fails when the attachment exceeds the configured maximum size', async () => {
        const { sessionAttachmentsUploadFile } = await import('./uploadSessionAttachment');

        const file = typeof File === 'function'
            ? new File([new TextEncoder().encode('hello')], 'hello.txt', { type: 'text/plain' })
            : ({ name: 'hello.txt', size: 5, type: 'text/plain', slice: () => new Blob([]) } as any);

        const res = await sessionAttachmentsUploadFile({
            sessionId: 's1',
            file: { kind: 'web', file },
            messageLocalId: 'm1',
            config: {
                uploadLocation: 'workspace',
                workspaceRelativeDir: '.happier/uploads',
                vcsIgnoreStrategy: 'git_info_exclude',
                vcsIgnoreWritesEnabled: true,
                maxFileBytes: 4,
            },
        });

        expect(res).toEqual({ success: false, error: 'File exceeds maximum allowed size' });
        expect(sessionRPCSpy).not.toHaveBeenCalled();
        expect(uploadBulkPayloadFromFileSpy).not.toHaveBeenCalled();
    });
});
