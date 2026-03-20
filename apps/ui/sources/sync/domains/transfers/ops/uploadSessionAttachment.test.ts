import { afterEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

type RpcResponse = any;
const nativeOpenSpy = vi.fn();
const nativeCloseSpy = vi.fn();
const sessionRPCSpy = vi.fn(async (_sessionId: string, _method: string, _payload: unknown): Promise<RpcResponse> => ({
    success: false,
    error: 'unconfigured',
}));
const randomUUIDSpy = vi.fn(() => '12345678-0000-4000-8000-123456789abc');
const isRuntimeFeatureEnabledSpy = vi.fn<(params: unknown) => Promise<boolean>>(async (_params) => true);

vi.mock('@/sync/api/session/apiSocket', () => ({
    apiSocket: {
        sessionRPC: (sessionId: string, method: string, payload: any) => sessionRPCSpy(sessionId, method, payload),
    },
}));

vi.mock('@/sync/domains/features/featureDecisionInputs', () => ({
    isRuntimeFeatureEnabled: (params: unknown) => isRuntimeFeatureEnabledSpy(params),
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
    nativeOpenSpy.mockReset();
    nativeCloseSpy.mockReset();
    randomUUIDSpy.mockClear();
    isRuntimeFeatureEnabledSpy.mockClear();
    isRuntimeFeatureEnabledSpy.mockImplementation(async () => true);
});

describe('uploadSessionAttachment', () => {
    it('uploads a file through files.upload.* and returns the finalized path', async () => {
        const { sessionAttachmentsUploadFile } = await import('./uploadSessionAttachment');

        sessionRPCSpy.mockImplementation(async (_sessionId: string, method: string, payload: any) => {
            if (method === RPC_METHODS.ATTACHMENTS_CONFIGURE) {
                expect(payload).toMatchObject({
                    uploadLocation: 'workspace',
                    workspaceRelativeDir: '.happier/uploads',
                    vcsIgnoreStrategy: 'git_info_exclude',
                    vcsIgnoreWritesEnabled: true,
                });
                return { success: true, uploadLocation: 'workspace', uploadBasePath: '.happier/uploads/messages' };
            }
            if (method === RPC_METHODS.FILES_UPLOAD_INIT) {
                expect(payload).toMatchObject({
                    path: '.happier/uploads/messages/m1/12345678-hello.txt',
                    sizeBytes: 5,
                    overwrite: false,
                });
                return { success: true, uploadId: 'u1', chunkSizeBytes: 2 };
            }
            if (method === RPC_METHODS.FILES_UPLOAD_CHUNK) return { success: true };
            if (method === RPC_METHODS.FILES_UPLOAD_FINALIZE) {
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

        expect(res).toMatchObject({ success: true });
        expect((res as any).path).toBe('.happier/uploads/messages/m1/12345678-hello.txt');

        const calls = sessionRPCSpy.mock.calls.map((c) => ({ method: c[1], payload: c[2] }));
        expect(calls[0]?.method).toBe(RPC_METHODS.ATTACHMENTS_CONFIGURE);
        expect(calls[1]?.method).toBe(RPC_METHODS.FILES_UPLOAD_INIT);
        expect(calls[2]?.method).toBe(RPC_METHODS.FILES_UPLOAD_CHUNK);
        expect(calls[3]?.method).toBe(RPC_METHODS.FILES_UPLOAD_CHUNK);
        expect(calls[4]?.method).toBe(RPC_METHODS.FILES_UPLOAD_CHUNK);
        expect(calls[5]?.method).toBe(RPC_METHODS.FILES_UPLOAD_FINALIZE);

        expect(calls[2]?.payload).toMatchObject({ uploadId: 'u1', index: 0, contentBase64: 'aGU=' });
        expect(calls[3]?.payload).toMatchObject({ uploadId: 'u1', index: 1, contentBase64: 'bGw=' });
        expect(calls[4]?.payload).toMatchObject({ uploadId: 'u1', index: 2, contentBase64: 'bw==' });
    });

    it('calls onProgress after each uploaded chunk', async () => {
        const { sessionAttachmentsUploadFile } = await import('./uploadSessionAttachment');

        sessionRPCSpy.mockImplementation(async (_sessionId: string, method: string) => {
            if (method === RPC_METHODS.ATTACHMENTS_CONFIGURE) {
                return { success: true, uploadLocation: 'workspace', uploadBasePath: '.happier/uploads/messages' };
            }
            if (method === RPC_METHODS.FILES_UPLOAD_INIT) return { success: true, uploadId: 'u1', chunkSizeBytes: 2 };
            if (method === RPC_METHODS.FILES_UPLOAD_CHUNK) return { success: true };
            if (method === RPC_METHODS.FILES_UPLOAD_FINALIZE) {
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

    it('uploads a native file by reading bytes from an expo-file-system FileHandle', async () => {
        const { sessionAttachmentsUploadFile } = await import('./uploadSessionAttachment');

        sessionRPCSpy.mockImplementation(async (_sessionId: string, method: string) => {
            if (method === RPC_METHODS.ATTACHMENTS_CONFIGURE) {
                return { success: true, uploadLocation: 'workspace', uploadBasePath: '.happier/uploads/messages' };
            }
            if (method === RPC_METHODS.FILES_UPLOAD_INIT) return { success: true, uploadId: 'u1', chunkSizeBytes: 2 };
            if (method === RPC_METHODS.FILES_UPLOAD_CHUNK) return { success: true };
            if (method === RPC_METHODS.FILES_UPLOAD_FINALIZE) {
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

        const calls = sessionRPCSpy.mock.calls.map((c) => ({ method: c[1], payload: c[2] }));
        expect(calls[1]?.method).toBe(RPC_METHODS.FILES_UPLOAD_INIT);
    });

    it('fails when the file size is unknown', async () => {
        const { sessionAttachmentsUploadFile } = await import('./uploadSessionAttachment');

        const res = await sessionAttachmentsUploadFile({
            sessionId: 's1',
            file: { kind: 'native', uri: 'file:///tmp/unknown.txt', name: 'hello.txt', sizeBytes: null, mimeType: 'text/plain' },
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
    });

    it('fails when the file exceeds the configured size limit', async () => {
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
    });
});
