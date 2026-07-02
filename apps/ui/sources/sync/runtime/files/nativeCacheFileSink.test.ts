import { afterEach, describe, expect, it, vi } from 'vitest';

describe('createNativeCacheFileSink', () => {
    afterEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
    });

    it('deletes a stale deterministic cache file before creating a replacement', async () => {
        const createDirectory = vi.fn();
        const deleteFile = vi.fn();
        const create = vi.fn();
        const close = vi.fn();
        const writeBytes = vi.fn();
        const open = vi.fn(() => ({ close, writeBytes, offset: null }));

        class Directory {
            readonly uri: string;

            constructor(parent: { uri: string } | string, path?: string) {
                const parentUri = typeof parent === 'string' ? parent : parent.uri;
                this.uri = `${parentUri.replace(/\/+$/, '')}/${path ?? ''}`;
            }

            create = createDirectory;
        }

        class File {
            readonly uri: string;

            constructor(parent: { uri: string } | string, path?: string) {
                const parentUri = typeof parent === 'string' ? parent : parent.uri;
                this.uri = path ? `${parentUri.replace(/\/+$/, '')}/${path}` : parentUri;
            }

            delete = deleteFile;
            create = create;
            open = open;
        }

        vi.doMock('expo-file-system', () => ({
            Paths: { cache: { uri: 'file:///cache/' } },
            Directory,
            File,
            makeDirectoryAsync: vi.fn(() => {
                throw new Error('deprecated makeDirectoryAsync must not be used');
            }),
        }));

        const { createNativeCacheFileSink } = await import('./nativeCacheFileSink');
        const sink = await createNativeCacheFileSink({
            directoryName: 'happier-session-file-previews',
            fileName: 'same-preview.png',
        });

        expect(sink.ok).toBe(true);
        expect(createDirectory).toHaveBeenCalledWith({ intermediates: true, idempotent: true });
        expect(deleteFile.mock.invocationCallOrder[0]).toBeLessThan(create.mock.invocationCallOrder[0] ?? 0);
        expect(create).toHaveBeenCalledTimes(1);
    });
});
