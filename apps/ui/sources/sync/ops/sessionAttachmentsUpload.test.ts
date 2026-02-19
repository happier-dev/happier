import { describe, expect, it, vi } from 'vitest';

type RpcResponse = any;
const sessionRPCSpy = vi.fn(async (_sessionId: string, _method: string, _payload: unknown): Promise<RpcResponse> => ({
    success: false,
    error: 'unconfigured',
}));

vi.mock('../api/session/apiSocket', () => ({
    apiSocket: {
        sessionRPC: (sessionId: string, method: string, payload: any) => sessionRPCSpy(sessionId, method, payload),
    },
}));

vi.mock('expo-file-system', () => {
    class FakeFileHandle {
        offset: number | null = 0;
        size: number | null;
        private bytes: Uint8Array;
        constructor(bytes: Uint8Array) {
            this.bytes = bytes;
            this.size = bytes.byteLength;
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
            return new FakeFileHandle(new TextEncoder().encode('hello'));
        }
    }

    return { File: FakeFile };
});

describe('sessionAttachmentsUpload', () => {
    it('uploads a file in chunks and returns the finalized path', async () => {
        const { sessionAttachmentsUploadFile } = await import('./sessionAttachmentsUpload');

        sessionRPCSpy.mockImplementation(async (_sessionId: string, method: string) => {
            if (method === 'attachments.configure') return { success: true };
            if (method === 'attachments.upload.init') return { success: true, uploadId: 'u1', chunkSizeBytes: 2 };
            if (method === 'attachments.upload.chunk') return { success: true };
            if (method === 'attachments.upload.finalize') return { success: true, path: 'p1', sizeBytes: 5, sha256: 'h1' };
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
                uploadTtlMs: 5 * 60 * 1000,
                chunkSizeBytes: 256 * 1024,
            },
        });

        expect(res).toMatchObject({ success: true });
        expect((res as any).path).toBe('p1');

        const calls = sessionRPCSpy.mock.calls.map((c) => ({ method: c[1], payload: c[2] }));
        expect(calls[0]?.method).toBe('attachments.configure');
        expect(calls[1]?.method).toBe('attachments.upload.init');
        expect(calls[2]?.method).toBe('attachments.upload.chunk');
        expect(calls[3]?.method).toBe('attachments.upload.chunk');
        expect(calls[4]?.method).toBe('attachments.upload.chunk');
        expect(calls[5]?.method).toBe('attachments.upload.finalize');

        expect(calls[1]?.payload).toMatchObject({ name: 'hello.txt', sizeBytes: 5, mimeType: 'text/plain', messageLocalId: 'm1' });
        expect(calls[2]?.payload).toMatchObject({ uploadId: 'u1', index: 0, contentBase64: 'aGU=' });
        expect(calls[3]?.payload).toMatchObject({ uploadId: 'u1', index: 1, contentBase64: 'bGw=' });
        expect(calls[4]?.payload).toMatchObject({ uploadId: 'u1', index: 2, contentBase64: 'bw==' });
    });

    it('uploads a native file by reading bytes from an expo-file-system FileHandle', async () => {
        const { sessionAttachmentsUploadFile } = await import('./sessionAttachmentsUpload');

        sessionRPCSpy.mockImplementation(async (_sessionId: string, method: string) => {
            if (method === 'attachments.configure') return { success: true };
            if (method === 'attachments.upload.init') return { success: true, uploadId: 'u1', chunkSizeBytes: 2 };
            if (method === 'attachments.upload.chunk') return { success: true };
            if (method === 'attachments.upload.finalize') return { success: true, path: 'p1', sizeBytes: 5, sha256: 'h1' };
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
                uploadTtlMs: 5 * 60 * 1000,
                chunkSizeBytes: 256 * 1024,
            },
        });

        expect(res).toMatchObject({ success: true });
        expect((res as any).path).toBe('p1');

        const calls = sessionRPCSpy.mock.calls.map((c) => ({ method: c[1], payload: c[2] }));
        expect(calls[1]?.payload).toMatchObject({ name: 'hello.txt', sizeBytes: 5, mimeType: 'text/plain', messageLocalId: 'm1' });
        expect(calls[2]?.payload).toMatchObject({ uploadId: 'u1', index: 0, contentBase64: 'aGU=' });
        expect(calls[3]?.payload).toMatchObject({ uploadId: 'u1', index: 1, contentBase64: 'bGw=' });
        expect(calls[4]?.payload).toMatchObject({ uploadId: 'u1', index: 2, contentBase64: 'bw==' });
    });

    it('aborts the upload when a chunk fails', async () => {
        const { sessionAttachmentsUploadFile } = await import('./sessionAttachmentsUpload');

        sessionRPCSpy.mockImplementation(async (_sessionId: string, method: string, payload: any) => {
            if (method === 'attachments.configure') return { success: true };
            if (method === 'attachments.upload.init') return { success: true, uploadId: 'u1', chunkSizeBytes: 2 };
            if (method === 'attachments.upload.chunk' && payload?.index === 0) return { success: true };
            if (method === 'attachments.upload.chunk' && payload?.index === 1) return { success: false, error: 'write failed' };
            if (method === 'attachments.upload.abort') return { success: true };
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
                uploadTtlMs: 5 * 60 * 1000,
                chunkSizeBytes: 256 * 1024,
            },
        });

        expect(res).toMatchObject({ success: false });
        expect(String((res as any).error ?? '')).toContain('write failed');
        expect(sessionRPCSpy.mock.calls.some((c) => c[1] === 'attachments.upload.abort')).toBe(true);
    });
});
