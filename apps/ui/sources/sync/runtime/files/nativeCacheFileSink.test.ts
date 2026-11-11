import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('createNativeCacheFileSink', () => {
    afterEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
    });

    it('reports an iOS activity-sheet dismissal as cancellation', async () => {
        const share = vi.fn(async () => ({ action: 'dismissedAction' }));
        vi.doMock('react-native', async () => ({
            ...(await (await import('@/dev/testkit/mocks/reactNative')).createReactNativeNativeMock({ platformOS: 'ios' })),
            Share: { share, sharedAction: 'sharedAction', dismissedAction: 'dismissedAction' },
        }));
        vi.doMock('expo-sharing', () => ({ isAvailableAsync: async () => true, shareAsync: async () => {} }));
        const { shareNativeCacheFile } = await import('./nativeCacheFileSink');
        expect(await shareNativeCacheFile({ fileUri: 'file:///cache/recap.png', name: 'recap.png', mimeType: 'image/png' }))
            .toEqual({ status: 'canceled' });
    });

    it('opens an iOS file in Quick Look and keeps it until dismissal, else falls back to the share sheet', async () => {
        const share = vi.fn(async () => ({ action: 'sharedAction' }));
        vi.doMock('react-native', async () => ({
            ...(await (await import('@/dev/testkit/mocks/reactNative')).createReactNativeNativeMock({ platformOS: 'ios' })),
            Share: { share, sharedAction: 'sharedAction', dismissedAction: 'dismissedAction' },
        }));
        vi.doMock('expo-sharing', () => ({ isAvailableAsync: async () => true, shareAsync: async () => {} }));
        let native: { previewFile: (uri: string) => Promise<{ status: string }> } | null = {
            previewFile: vi.fn(async (uri: string) => ({ status: uri.endsWith('.bin') ? 'unsupported' : 'dismissed' })),
        };
        vi.doMock('expo-modules-core', () => ({ requireOptionalNativeModule: () => native }));
        const { shareNativeCacheFile } = await import('./nativeCacheFileSink');
        const report = { fileUri: 'file:///cache/report.html', name: 'report.html', mimeType: 'text/html', action: 'open' as const };
        await expect(shareNativeCacheFile(report)).resolves.toEqual({ status: 'shared', retainCacheFile: false, completion: 'confirmed' });
        expect(native!.previewFile).toHaveBeenCalledWith(report.fileUri);
        expect(share).not.toHaveBeenCalled();
        // A kind Quick Look can't render, or an installed app built before the module, still reaches other apps.
        await shareNativeCacheFile({ ...report, fileUri: 'file:///cache/blob.bin', name: 'blob.bin' });
        expect(share).toHaveBeenLastCalledWith({ url: 'file:///cache/blob.bin' });
        native = null;
        await shareNativeCacheFile(report);
        expect(share).toHaveBeenLastCalledWith({ url: report.fileUri });
        // Share keeps its own sheet.
        native = { previewFile: vi.fn() };
        await shareNativeCacheFile({ ...report, action: 'share' });
        expect(native.previewFile).not.toHaveBeenCalled();
    });

    it('offers a local PDF to the iOS share sheet and reports unavailable sharing', async () => {
        const share = vi.fn(async () => ({ action: 'sharedAction' }));
        vi.doMock('react-native', async () => ({
            ...(await (await import('@/dev/testkit/mocks/reactNative')).createReactNativeNativeMock({ platformOS: 'ios' })),
            Share: { share, sharedAction: 'sharedAction', dismissedAction: 'dismissedAction' },
        }));
        let available = true;
        vi.doMock('expo-sharing', () => ({ isAvailableAsync: async () => available, shareAsync: share }));
        const { shareNativeCacheFile } = await import('./nativeCacheFileSink');
        const input = { fileUri: 'file:///cache/document.pdf', name: 'document.pdf', mimeType: 'application/pdf' };
        await expect(shareNativeCacheFile(input)).resolves.toEqual({ status: 'shared', retainCacheFile: false, completion: 'confirmed' });
        expect(share).toHaveBeenCalledWith({ url: input.fileUri });
        const zip = { fileUri: 'file:///cache/package.zip', name: 'package.zip', mimeType: 'application/zip', UTI: 'public.zip-archive', dialogTitle: 'Export package' };
        await expect(shareNativeCacheFile(zip)).resolves.toEqual({ status: 'shared', retainCacheFile: false, completion: 'confirmed' });
        expect(share).toHaveBeenLastCalledWith({ url: zip.fileUri });
        available = false;
        await expect(shareNativeCacheFile(input)).resolves.toEqual({ status: 'unavailable' });
        expect(share).toHaveBeenCalledTimes(2);
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
            .rejects.toMatchObject({ cause: { message: 'native file system unavailable' } });
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
            get exists() { return files.has(this.uri); }
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

    it('stages binary upload chunks through the native file owner and removes custody on request failure', async () => {
        vi.doMock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeNativeMock({ platformOS: 'ios' }));
        const { requestDiscussionAttachmentUpload } = await import('@/sync/api/discussions/discussionAttachmentTransport');
        const { DiscussionAttachmentUploadRequestV1Schema } = await import('@happier-dev/protocol/discussions/attachmentsUpload');
        const blobId = 'e8eb80ae-7e18-4bbe-8c0e-c9d762787a86';
        let reads = 0;
        async function* bytes() {
            reads++;
            expect(files.size).toBe(1);
            yield new Uint8Array([1]);
            expect([...files.values()][0]?.at(-1)).toBe(1);
            reads++;
            yield new Uint8Array([2]);
        }
        const metadata = DiscussionAttachmentUploadRequestV1Schema.parse({ operation: 'encryption-conversion',
            input: { discussionId: 'discussion', messageId: 'message', blobId },
            attachments: [{ blobId, t: 'plain', storedSizeBytes: 2 }] });
        await expect(requestDiscussionAttachmentUpload({ request: async (_path, init) => {
            expect(init?.body).toHaveProperty('uri');
            expect([...files.values()][0]?.slice(-2)).toEqual([1, 2]);
            throw new Error('interrupted upload');
        } }, metadata, [{ storedSizeBytes: 2, bytes: bytes() }])).rejects.toMatchObject({ code: 'outcome_unknown' });
        expect(reads).toBe(2);
        expect(files.size).toBe(0);
    });

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
    it('accepts confirmed absence after the native copy boundary removed its closed destination', async () => {
        const { createNativeCacheFileSink } = await import('./nativeCacheFileSink');
        const result = await createNativeCacheFileSink({ directoryName: 'happier-downloads', fileName: 'recap.png' });
        if (!result.ok) throw new Error(result.error);
        await result.close();
        // SDK55 iOS copyFrom removes an existing destination before attempting the copy.
        files.delete(result.fileUri);
        await expect(result.cleanup()).resolves.toBeUndefined();
        await expect(result.cleanup()).resolves.toBeUndefined();
    });

});
