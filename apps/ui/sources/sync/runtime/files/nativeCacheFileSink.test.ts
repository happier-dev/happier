import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('createNativeCacheFileSink', () => {
    afterEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
    });

    it('offers a local PDF to the native OS share/open boundary and reports unavailable sharing', async () => {
        const shareAsync = vi.fn(async () => {});
        let available = true;
        vi.doMock('expo-sharing', () => ({ isAvailableAsync: async () => available, shareAsync }));
        const { shareNativeCacheFile } = await import('./nativeCacheFileSink');
        await expect(shareNativeCacheFile('file:///cache/document.pdf', 'application/pdf')).resolves.toBe(true);
        expect(shareAsync).toHaveBeenCalledWith('file:///cache/document.pdf', { mimeType: 'application/pdf' });
        available = false;
        await expect(shareNativeCacheFile('file:///cache/document.pdf', 'application/pdf')).resolves.toBe(false);
        expect(shareAsync).toHaveBeenCalledTimes(1);
    });

    it('surfaces exact cache-file removal failures and accepts a later confirmed absence', async () => {
        const deleteFile = vi.fn()
            .mockImplementationOnce(() => { throw new Error('file busy'); })
            .mockImplementationOnce(() => { throw new Error('already absent'); });
        let exists = true;
        class File {
            readonly uri: string;
            constructor(uri: string) { this.uri = uri; }
            get exists() { return exists; }
            delete = deleteFile;
        }
        vi.doMock('expo-file-system', () => ({ File }));

        const { removeNativeCacheFileCustody } = await import('./nativeCacheFileSink');
        await expect(removeNativeCacheFileCustody('file:///cache/sensitive.zip')).rejects.toThrow('file busy');

        exists = false;
        await expect(removeNativeCacheFileCustody('file:///cache/sensitive.zip')).resolves.toBeUndefined();
        expect(deleteFile).toHaveBeenCalledTimes(2);
    });

    it('surfaces native file-system import failures instead of claiming custody was removed', async () => {
        vi.doMock('expo-file-system', () => { throw new Error('native file system unavailable'); });
        const { removeNativeCacheFileCustody } = await import('./nativeCacheFileSink');
        await expect(removeNativeCacheFileCustody('file:///cache/sensitive.zip'))
            .rejects.toThrow();
    });
});


describe('native cache sink resource ownership', () => {
    const files = new Map<string, number[]>();
    let closeError: Error | null;
    let openError: Error | null;
    let deleteError: Error | null;
    beforeEach(() => {
        files.clear(); closeError = null; openError = null; deleteError = null;
        class Directory {
            readonly uri: string;
            constructor(parent: { uri: string } | string, name?: string) {
                this.uri = `${(typeof parent === 'string' ? parent : parent.uri).replace(/\/+$/, '')}/${name ?? ''}`;
            }
            create() {}
        }
        class File {
            readonly uri: string;
            constructor(parent: { uri: string } | string, name?: string) {
                this.uri = name ? `${(typeof parent === 'string' ? parent : parent.uri).replace(/\/+$/, '')}/${name}` : String(parent);
            }
            create() {
                if (new TextEncoder().encode(this.uri.split('/').at(-1)!).byteLength > 255) throw new Error('Filename exceeds filesystem component limit');
                if (files.has(this.uri)) throw new Error('File already exists');
                files.set(this.uri, []);
            }
            open() {
                if (openError) throw openError;
                return { offset: 0, writeBytes: (bytes: Uint8Array) => files.get(this.uri)!.push(...bytes), close: () => { if (closeError) throw closeError; } };
            }
            delete() {
                if (deleteError) throw deleteError;
                if (!files.delete(this.uri)) throw new Error('File already removed');
            }
        }
        vi.doMock('expo-file-system', () => ({ Directory, File, Paths: { cache: 'file:///cache' } }));
    });
    afterEach(() => { vi.resetModules(); vi.restoreAllMocks(); });

    it('isolates repeated destinations without replacing a live cache file', async () => {
        const { createNativeCacheFileSink } = await import('./nativeCacheFileSink');
        const input = { directoryName: 'happier-downloads', fileName: 'recording.mp4' };
        const first = await createNativeCacheFileSink(input);
        if (!first.ok) throw new Error(first.error);
        await first.writeBytes(new Uint8Array([1, 2]));
        const second = await createNativeCacheFileSink(input);
        const third = await createNativeCacheFileSink(input);
        if (!second.ok || !third.ok) throw new Error('expected sinks');
        expect(new Set([first.fileUri, second.fileUri, third.fileUri]).size).toBe(3);
        expect(files.get(first.fileUri)).toEqual([1, 2]);
        await second.writeBytes(new Uint8Array([3]));
        await first.cleanup(); await first.cleanup();
        expect(files.get(second.fileUri)).toEqual([3]);
    });

    it.each(['界'.repeat(83), '😀'.repeat(62)])('preserves Unicode and media extensions within the filesystem byte boundary', async stem => {
        const { createNativeCacheFileSink } = await import('./nativeCacheFileSink');
        const result = await createNativeCacheFileSink({ directoryName: 'happier-previews', fileName: `${stem}.mp4` });
        if (!result.ok) throw new Error(result.error);
        const name = result.fileUri.split('/').at(-1)!;
        expect(new TextEncoder().encode(name).byteLength).toBeLessThanOrEqual(255);
        expect(name).toMatch(/\.mp4$/);
        expect(name).toContain(stem[0]);
        expect(name).not.toContain('\uFFFD');
    });

    it('deletes the created destination when opening its handle fails', async () => {
        const { createNativeCacheFileSink } = await import('./nativeCacheFileSink');
        openError = new Error('File open failed');
        expect(await createNativeCacheFileSink({ directoryName: 'downloads', fileName: 'a.mp4' })).toEqual({ ok: false, error: openError.message });
        expect(files.size).toBe(0);
    });

    it('rejects a failed close and still deletes its destination during cleanup', async () => {
        const { createNativeCacheFileSink } = await import('./nativeCacheFileSink');
        const result = await createNativeCacheFileSink({ directoryName: 'downloads', fileName: 'a.mp4' });
        if (!result.ok) throw new Error(result.error);
        closeError = new Error('File close failed');
        await expect(result.close()).rejects.toBe(closeError);
        await expect(result.cleanup()).rejects.toBe(closeError);
        expect(files.size).toBe(0);
    });

    it('exposes and reports deletion failure instead of silently losing custody', async () => {
        const { createNativeCacheFileSink } = await import('./nativeCacheFileSink');
        const result = await createNativeCacheFileSink({ directoryName: 'downloads', fileName: 'a.mp4' });
        if (!result.ok) throw new Error(result.error);
        const diagnostic = vi.spyOn(console, 'log').mockImplementation(() => {});
        deleteError = new Error('File deletion failed');
        await expect(result.cleanup()).rejects.toBe(deleteError);
        expect(files.has(result.fileUri)).toBe(true);
        expect(diagnostic.mock.calls.flat().join(' ')).toContain(deleteError.message);
    });
});
