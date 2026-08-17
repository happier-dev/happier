import { afterEach, describe, expect, it, vi } from 'vitest';

const downloadDaemonWorkspaceFileToDestinationMock = vi.hoisted(() => vi.fn());
const inspectComposerContentMock = vi.hoisted(() => vi.fn());
const createNativeCacheFileSinkMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/domains/transfers/runtime/transferRuntime', () => ({
    downloadDaemonWorkspaceFileToDestination: (...args: unknown[]) => downloadDaemonWorkspaceFileToDestinationMock(...args),
    inspectComposerContent: (...args: unknown[]) => inspectComposerContentMock(...args),
}));

vi.mock('@/sync/runtime/files/nativeCacheFileSink', () => ({
    createNativeCacheFileSink: (...args: unknown[]) => createNativeCacheFileSinkMock(...args),
}));

describe('createSessionFilePreviewSource', () => {
    afterEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        vi.unstubAllGlobals();
    });

    it('creates revocable Blob object URLs on web', async () => {
        vi.doMock('react-native', () => ({ Platform: { OS: 'web' } }));

        const createObjectURL = vi.fn(() => 'blob:preview-1');
        const revokeObjectURL = vi.fn();
        vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
        vi.stubGlobal('Blob', class Blob {
            readonly parts: unknown[];
            readonly type: string;

            constructor(parts: unknown[], options?: { type?: string }) {
                this.parts = parts;
                this.type = options?.type ?? '';
            }
        });

        downloadDaemonWorkspaceFileToDestinationMock.mockImplementation(async (params: {
            destination: {
                writeBytes: (bytes: Uint8Array) => Promise<void>;
                close: () => Promise<void>;
            };
            onInit?: ((init: { name: string; sizeBytes: number }) => Promise<void | { success: false; error: string }>) | null;
        }) => {
            await params.onInit?.({ name: 'image.png', sizeBytes: 4 });
            await params.destination.writeBytes(new Uint8Array([1, 2]));
            await params.destination.writeBytes(new Uint8Array([3, 4]));
            await params.destination.close();
            return { ok: true, name: 'image.png', sizeBytes: 4 };
        });

        const { createSessionFilePreviewSource } = await import('./createSessionFilePreviewSource');
        const source = await createSessionFilePreviewSource({
            scope: { serverId: 'server-1', machineId: 'm1', rootPath: '/repo' },
            filePath: '.happier/uploads/messages/m1/image.png',
            mimeType: 'image/png',
            maxBytes: 16,
            cacheIdentity: 'sha-1',
        });

        expect(source.ok).toBe(true);
        if (!source.ok) throw new Error(source.error);
        expect(source.source).toMatchObject({
            kind: 'object-url',
            uri: 'blob:preview-1',
            byteLength: 4,
            mimeType: 'image/png',
        });
        expect(createObjectURL).toHaveBeenCalledTimes(1);
        if (source.source.kind !== 'object-url') throw new Error('Expected object-url preview source');

        source.source.revoke();
        expect(revokeObjectURL).toHaveBeenCalledWith('blob:preview-1');
    });

    it('creates a bounded preview from an exact opaque staged-media inspection without a workspace path', async () => {
        vi.doMock('react-native', () => ({ Platform: { OS: 'web' } }));

        const createObjectURL = vi.fn(() => 'blob:composer-stage-preview');
        const revokeObjectURL = vi.fn();
        vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
        vi.stubGlobal('Blob', class Blob {
            readonly parts: unknown[];
            readonly type: string;

            constructor(parts: unknown[], options?: { type?: string }) {
                this.parts = parts;
                this.type = options?.type ?? '';
            }
        });

        const handle = {
            v: 1,
            id: 'stage_42',
            executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
            owner: { pluginId: 'acme.images', localId: 'image' },
            mediaKind: 'image',
            mimeType: 'image/png',
            name: 'incident.png',
            sizeBytes: 4,
            sha256: 'a'.repeat(64),
        } as const;
        inspectComposerContentMock.mockResolvedValue({
            success: true,
            result: { offset: 0, bytesBase64: 'AQIDBA==', eof: true },
        });

        const module = await import('./createSessionFilePreviewSource');
        const createComposerStagedMediaPreviewSource = (module as unknown as Readonly<{
            createComposerStagedMediaPreviewSource?: (input: Readonly<{
                handle: typeof handle;
                maxBytes: number;
                signal?: AbortSignal | null;
            }>) => Promise<unknown>;
        }>).createComposerStagedMediaPreviewSource;
        expect(createComposerStagedMediaPreviewSource).toBeTypeOf('function');

        const source = await createComposerStagedMediaPreviewSource!({ handle, maxBytes: 16 });

        expect(inspectComposerContentMock).toHaveBeenCalledWith(
            handle,
            { offset: 0, maxBytes: 4 },
            { signal: null },
        );
        expect(downloadDaemonWorkspaceFileToDestinationMock).not.toHaveBeenCalled();
        expect(source).toMatchObject({
            ok: true,
            source: {
                kind: 'object-url',
                uri: 'blob:composer-stage-preview',
                byteLength: 4,
                mimeType: 'image/png',
            },
        });
    });

    it('rejects an incomplete staged-media inspection before it can create a preview source', async () => {
        vi.doMock('react-native', () => ({ Platform: { OS: 'web' } }));

        const createObjectURL = vi.fn(() => 'blob:should-not-exist');
        vi.stubGlobal('URL', { createObjectURL, revokeObjectURL: vi.fn() });
        vi.stubGlobal('Blob', class Blob {
            constructor(_parts: unknown[], _options?: { type?: string }) {}
        });

        const handle = {
            v: 1,
            id: 'stage_partial',
            executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
            owner: { pluginId: 'acme.images', localId: 'image' },
            mediaKind: 'image',
            mimeType: 'image/png',
            name: 'incident.png',
            sizeBytes: 4,
            sha256: 'b'.repeat(64),
        } as const;
        inspectComposerContentMock.mockResolvedValue({
            success: true,
            result: { offset: 0, bytesBase64: 'AQI=', eof: false },
        });

        const { createComposerStagedMediaPreviewSource } = await import('./createSessionFilePreviewSource');
        const source = await createComposerStagedMediaPreviewSource({ handle, maxBytes: 16 });

        expect(source).toEqual({
            ok: false,
            error: 'Composer media inspection returned an incomplete preview',
        });
        expect(createObjectURL).not.toHaveBeenCalled();
    });

    it('does not create an object URL when the preview request is cancelled after transfer settlement', async () => {
        vi.doMock('react-native', () => ({ Platform: { OS: 'web' } }));

        const createObjectURL = vi.fn(() => 'blob:cancelled-preview');
        vi.stubGlobal('URL', { createObjectURL, revokeObjectURL: vi.fn() });
        vi.stubGlobal('Blob', class Blob {
            constructor(_parts: unknown[], _options?: { type?: string }) {}
        });

        const controller = new AbortController();
        downloadDaemonWorkspaceFileToDestinationMock.mockImplementation(async (params: {
            destination: {
                writeBytes: (bytes: Uint8Array) => Promise<void>;
                close: () => Promise<void>;
            };
        }) => {
            await params.destination.writeBytes(new Uint8Array([1, 2]));
            await params.destination.close();
            controller.abort();
            return { ok: true, name: 'image.png', sizeBytes: 2 };
        });

        const { createSessionFilePreviewSource } = await import('./createSessionFilePreviewSource');
        const source = await createSessionFilePreviewSource({
            scope: { serverId: 'server-1', machineId: 'm1', rootPath: '/repo' },
            filePath: '.happier/uploads/messages/m1/image.png',
            mimeType: 'image/png',
            maxBytes: 16,
            signal: controller.signal,
        });

        expect(source.ok).toBe(false);
        expect(createObjectURL).not.toHaveBeenCalled();
    });

    it('creates revocable Blob object URLs for supported video evidence references on web', async () => {
        vi.doMock('react-native', () => ({ Platform: { OS: 'web' } }));

        const createObjectURL = vi.fn(() => 'blob:recording-preview-1');
        const revokeObjectURL = vi.fn();
        vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
        vi.stubGlobal('Blob', class Blob {
            readonly parts: unknown[];
            readonly type: string;

            constructor(parts: unknown[], options?: { type?: string }) {
                this.parts = parts;
                this.type = options?.type ?? '';
            }
        });

        downloadDaemonWorkspaceFileToDestinationMock.mockImplementation(async (params: {
            destination: {
                writeBytes: (bytes: Uint8Array) => Promise<void>;
                close: () => Promise<void>;
            };
            onInit?: ((init: { name: string; sizeBytes: number }) => Promise<void | { success: false; error: string }>) | null;
        }) => {
            await params.onInit?.({ name: 'recording.webm', sizeBytes: 8 });
            await params.destination.writeBytes(new Uint8Array([1, 2, 3, 4]));
            await params.destination.writeBytes(new Uint8Array([5, 6, 7, 8]));
            await params.destination.close();
            return { ok: true, name: 'recording.webm', sizeBytes: 8 };
        });

        const { createSessionFilePreviewSource } = await import('./createSessionFilePreviewSource');
        const source = await createSessionFilePreviewSource({
            scope: { serverId: 'server-1', machineId: 'm1', rootPath: '/repo' },
            filePath: '.happier/uploads/artifacts/session-1/message-1/recording.webm',
            mimeType: 'video/webm',
            maxBytes: 16,
            cacheIdentity: 'sha-video-1',
        });

        expect(source.ok).toBe(true);
        if (!source.ok) throw new Error(source.error);
        expect(source.source).toMatchObject({
            kind: 'object-url',
            uri: 'blob:recording-preview-1',
            byteLength: 8,
            mimeType: 'video/webm',
        });
        if (source.source.kind !== 'object-url') throw new Error('Expected object-url preview source');

        source.source.revoke();
        expect(revokeObjectURL).toHaveBeenCalledWith('blob:recording-preview-1');
    });

    it('writes native previews through the shared cache file sink and deletes them on cleanup', async () => {
        vi.doMock('react-native', () => ({ Platform: { OS: 'ios' } }));

        const writeBytes = vi.fn(async () => undefined);
        const close = vi.fn(async () => undefined);
        const cleanup = vi.fn(async () => undefined);
        createNativeCacheFileSinkMock.mockResolvedValue({
            ok: true,
            fileUri: 'file:///cache/happier-session-file-previews/image.png',
            writeBytes,
            close,
            cleanup,
        });
        downloadDaemonWorkspaceFileToDestinationMock.mockImplementation(async (params: {
            destination: {
                writeBytes: (bytes: Uint8Array) => Promise<void>;
                close: () => Promise<void>;
            };
            onInit?: ((init: { name: string; sizeBytes: number }) => Promise<void | { success: false; error: string }>) | null;
        }) => {
            await params.onInit?.({ name: 'image.png', sizeBytes: 3 });
            await params.destination.writeBytes(new Uint8Array([1, 2, 3]));
            await params.destination.close();
            return { ok: true, name: 'image.png', sizeBytes: 3 };
        });

        const { createSessionFilePreviewSource } = await import('./createSessionFilePreviewSource');
        const source = await createSessionFilePreviewSource({
            scope: { serverId: 'server-1', machineId: 'm1', rootPath: '/repo' },
            filePath: '.happier/uploads/messages/m1/image.png',
            mimeType: 'image/png',
            maxBytes: 16,
            cacheIdentity: 'sha-1',
        });

        expect(source.ok).toBe(true);
        if (!source.ok) throw new Error(source.error);
        expect(createNativeCacheFileSinkMock).toHaveBeenCalledWith(expect.objectContaining({
            directoryName: 'happier-session-file-previews',
        }));
        expect(writeBytes).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]));
        expect(close).toHaveBeenCalledTimes(1);
        expect(source.source).toMatchObject({
            kind: 'cache-file',
            uri: 'file:///cache/happier-session-file-previews/image.png',
            byteLength: 3,
            mimeType: 'image/png',
        });
        if (source.source.kind !== 'cache-file') throw new Error('Expected cache-file preview source');

        await source.source.delete();
        expect(cleanup).toHaveBeenCalledTimes(1);
    });

    it('rejects svg previews under the V1 session-media image policy', async () => {
        vi.doMock('react-native', () => ({ Platform: { OS: 'web' } }));

        const { createSessionFilePreviewSource } = await import('./createSessionFilePreviewSource');
        const source = await createSessionFilePreviewSource({
            scope: { serverId: 'server-1', machineId: 'm1', rootPath: '/repo' },
            filePath: '.happier/uploads/messages/m1/icon.svg',
            mimeType: 'image/svg+xml',
            maxBytes: 16,
            cacheIdentity: 'sha-svg',
        });

        expect(source).toEqual({ ok: false, error: 'Unsupported preview type' });
        expect(downloadDaemonWorkspaceFileToDestinationMock).not.toHaveBeenCalled();
    });
});
