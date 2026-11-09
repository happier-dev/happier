import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createExpoFileSystemFileMock } from '@/dev/testkit/mocks/expoFileSystem';

const boundary = vi.hoisted(() => ({ fileSystem: null as null | ReturnType<typeof createExpoFileSystemFileMock>,
    action: vi.fn<(input: { fileUri: string; action: string }) => Promise<{ canceled: boolean }>>() }));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeNativeMock({ platformOS: 'android' }));
vi.mock('expo-file-system', async () => {
    boundary.fileSystem = (await import('@/dev/testkit/mocks/expoFileSystem')).createExpoFileSystemFileMock();
    return boundary.fileSystem.module;
});
// The adapter is the native chooser/intent boundary; custody and file copying remain real.
vi.mock('./nativeFileActions', () => ({ performAndroidFileAction: boundary.action }));

beforeEach(async () => {
    await import('expo-file-system');
    boundary.fileSystem!.files.clear();
    boundary.fileSystem!.copies.mockClear();
    boundary.fileSystem!.writes.mockClear();
    boundary.fileSystem!.files.set('file:///cache/current.mp4', [1, 2, 3]);
    boundary.action.mockReset().mockResolvedValue({ canceled: false });
});

afterEach(() => vi.unstubAllGlobals());

describe('completed file handoff', () => {
    it.each([
        ['data:image/png;base64,iVBORwD%2F', [137, 80, 78, 71, 0, 255]],
        ['data:text/plain;charset=utf-8,hello%20%F0%9F%8C%8D', [...new TextEncoder().encode('hello 🌍')]],
    ] as const)('shares inline URI bytes without a native network request: %s', async (uri, expected) => {
        const fetchBoundary = vi.fn().mockRejectedValue(new TypeError('Network request failed'));
        vi.stubGlobal('fetch', fetchBoundary);
        const { saveFileUri } = await import('./saveFileBytes');
        await expect(saveFileUri({ uri, fileName: 'inline.png', mimeType: 'image/png', action: 'share' })).resolves.toBe('saved');
        const handoff = boundary.action.mock.calls[0]![0];
        expect(boundary.fileSystem!.files.get(handoff.fileUri)).toEqual(expected);
        expect(fetchBoundary).not.toHaveBeenCalled();
    });

    it('preserves exact Action file bytes, chooser cancellation and typed platform failure', async () => {
        const { saveClientFile } = await import('./saveFileBytes');
        const text = 'redacted token=***\r\npart 🌍\n';
        const input = { bytes: new TextEncoder().encode(text), fileName: 'worker.log' };
        const written: number[][] = [];
        boundary.action.mockImplementation(async ({ fileUri }) => {
            written.push([...boundary.fileSystem!.files.get(fileUri)!]);
            return { canceled: false };
        });
        await expect(saveClientFile(input)).resolves.toEqual({ status: 'saved' });
        expect(written).toEqual([[...new TextEncoder().encode(text)]]);
        expect([...boundary.fileSystem!.files.keys()]).toEqual(['file:///cache/current.mp4']);
        boundary.action.mockResolvedValue({ canceled: true });
        await expect(saveClientFile(input)).resolves.toEqual({ status: 'canceled' });
        expect([...boundary.fileSystem!.files.keys()]).toEqual(['file:///cache/current.mp4']);
        boundary.action.mockRejectedValue(new Error('Native save failed'));
        await expect(saveClientFile(input)).resolves.toMatchObject({ ok: false, errorCode: 'file_save_unavailable' });
        expect([...boundary.fileSystem!.files.keys()]).toEqual(['file:///cache/current.mp4']);
        const beforeRetirement = boundary.action.mock.calls.length;
        const retired = new AbortController();
        retired.abort();
        await expect(saveClientFile({ ...input, signal: retired.signal })).resolves.toEqual({ status: 'canceled' });
        expect(boundary.action.mock.calls).toHaveLength(beforeRetirement);
    });

    it('copies a local preview without reading video bytes into JS and retains only the handed-off Android copy', async () => {
        const { saveFileUri } = await import('./saveFileBytes');
        await expect(saveFileUri({ uri: 'file:///cache/current.mp4', fileName: 'clip.mp4', mimeType: 'video/mp4', action: 'open' })).resolves.toBe('saved');
        const handoff = boundary.action.mock.calls[0]![0];
        expect(handoff.action).toBe('open');
        expect(handoff.fileUri).not.toBe('file:///cache/current.mp4');
        expect(boundary.fileSystem!.files.get(handoff.fileUri)).toEqual([1, 2, 3]);
        expect(boundary.fileSystem!.files.get('file:///cache/current.mp4')).toEqual([1, 2, 3]);
        expect(boundary.fileSystem!.copies).toHaveBeenCalledOnce();
        expect(boundary.fileSystem!.writes).not.toHaveBeenCalled();
    });

    it('cleans up its local copy when the chooser cancels without deleting the preview', async () => {
        boundary.action.mockResolvedValue({ canceled: true });
        const { saveFileUri } = await import('./saveFileBytes');
        await expect(saveFileUri({ uri: 'file:///cache/current.mp4', fileName: 'clip.mp4', mimeType: 'video/mp4' })).resolves.toBe('canceled');
        expect([...boundary.fileSystem!.files.keys()]).toEqual(['file:///cache/current.mp4']);
    });
});
