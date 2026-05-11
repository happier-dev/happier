import { afterEach, describe, expect, it, vi } from 'vitest';

describe('createNativeCacheFileSink', () => {
    afterEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
    });

    it('deletes a stale deterministic cache file before creating a replacement', async () => {
        const deleteFile = vi.fn();
        const create = vi.fn();
        const close = vi.fn();
        const writeBytes = vi.fn();
        const open = vi.fn(() => ({ close, writeBytes, offset: null }));

        class File {
            readonly uri: string;

            constructor(uri: string) {
                this.uri = uri;
            }

            delete = deleteFile;
            create = create;
            open = open;
        }

        vi.doMock('expo-file-system', () => ({
            cacheDirectory: 'file:///cache/',
            makeDirectoryAsync: vi.fn(async () => undefined),
            File,
        }));

        const { createNativeCacheFileSink } = await import('./nativeCacheFileSink');
        const sink = await createNativeCacheFileSink({
            directoryName: 'happier-session-file-previews',
            fileName: 'same-preview.png',
        });

        expect(sink.ok).toBe(true);
        expect(deleteFile.mock.invocationCallOrder[0]).toBeLessThan(create.mock.invocationCallOrder[0] ?? 0);
        expect(create).toHaveBeenCalledTimes(1);
    });
});
