import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const nativeOpenSpy = vi.fn();
const nativeCloseSpy = vi.fn();
const uploadDaemonSessionAttachmentFromReaderSpy = vi.fn();
const randomUUIDSpy = vi.fn(() => '12345678-0000-4000-8000-123456789abc');
const isRuntimeFeatureEnabledSpy = vi.fn<(params: unknown) => Promise<boolean>>(async (_params) => true);
const resolveLocalUploadSourceSizeBytesSpy = vi.fn();
let localUploadSourceReaderActual: typeof import('@/sync/runtime/files/localUploadSourceReader') | null = null;

vi.mock('@/sync/domains/features/featureDecisionInputs', () => ({
    isRuntimeFeatureEnabled: (params: unknown) => isRuntimeFeatureEnabledSpy(params),
}));

vi.mock('@/sync/domains/transfers/runtime/transferRuntime', async () => {
    return {
        uploadDaemonSessionAttachmentFromReader: (params: unknown) => uploadDaemonSessionAttachmentFromReaderSpy(params),
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
        uploadDaemonSessionAttachmentFromReaderSpy.mockResolvedValue({
            success: true,
            path: '.happier/uploads/messages/m1/12345678-hello.txt',
            sizeBytes: 5,
            sha256: 'h1',
        });
    });

    it('uploads a file through the canonical attachment upload init and returns the finalized path', async () => {
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
                maxFileBytes: 25 * 1024 * 1024,
            },
        });

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
        expect(res).toMatchObject({ success: true });
        expect((res as any).path).toBe('.happier/uploads/messages/m1/12345678-hello.txt');
    });

    it('calls onProgress after each uploaded chunk', async () => {
        const { sessionAttachmentsUploadFile } = await import('./uploadSessionAttachment');

        uploadDaemonSessionAttachmentFromReaderSpy.mockImplementation(async (params: any) => {
            params.onProgress?.({ uploadedBytes: 2, totalBytes: 5 });
            params.onProgress?.({ uploadedBytes: 5, totalBytes: 5 });
            return { success: true, path: '.happier/uploads/messages/m1/12345678-hello.txt', sizeBytes: 5, sha256: 'h1' };
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

        uploadDaemonSessionAttachmentFromReaderSpy.mockImplementation(async (params: any) => {
            expect(params.fileReader.sizeBytes).toBe(5);
            expect(await params.fileReader.readBytes(0, 5)).toEqual(new TextEncoder().encode('hello'));
            await params.fileReader.close();
            return { success: true, path: '.happier/uploads/messages/m1/12345678-hello.txt', sizeBytes: 5, sha256: 'h1' };
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
    });

    it('closes the native file handle when the canonical upload helper rejects', async () => {
        const { sessionAttachmentsUploadFile } = await import('./uploadSessionAttachment');

        uploadDaemonSessionAttachmentFromReaderSpy.mockRejectedValue(new Error('Upload source reader exploded'));

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

        expect(res).toEqual({ success: false, error: 'Upload source reader exploded' });
        expect(nativeOpenSpy).toHaveBeenCalledTimes(1);
        expect(nativeCloseSpy).toHaveBeenCalledTimes(1);
    });

    it('preserves the opaque finalize recovery continuation after closing the source', async () => {
        const { sessionAttachmentsUploadFile } = await import('./uploadSessionAttachment');
        const recovery = {
            kind: 'transfer_finalize_recovery' as const,
            expiresAt: Date.now() + 60_000,
            actions: ['retry_finalize', 'discard_staged'] as const,
            invoke: vi.fn(),
        };
        uploadDaemonSessionAttachmentFromReaderSpy.mockResolvedValueOnce({
            success: false,
            error: 'Finalize recovery is required',
            errorCode: 'TRANSFER_FINALIZE_RECOVERY_REQUIRED',
            recovery,
        });

        const result = await sessionAttachmentsUploadFile({
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

        expect(result).toMatchObject({
            success: false,
            errorCode: 'TRANSFER_FINALIZE_RECOVERY_REQUIRED',
            recovery,
        });
        expect(nativeOpenSpy).toHaveBeenCalledTimes(1);
        expect(nativeCloseSpy).toHaveBeenCalledTimes(1);
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
        expect(uploadDaemonSessionAttachmentFromReaderSpy).not.toHaveBeenCalled();
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
        expect(uploadDaemonSessionAttachmentFromReaderSpy).not.toHaveBeenCalled();
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
        expect(uploadDaemonSessionAttachmentFromReaderSpy).not.toHaveBeenCalled();
    });
});
