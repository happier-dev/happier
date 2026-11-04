import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createDeferred, renderHook, standardCleanup } from '@/dev/testkit';
import type { NativeRecentCaptureEntry } from '@/desktop/capture/nativeCapture';
import { readRecentCaptureThumbnail, useRecentCaptureThumbnail } from './thumbnail';

const entry: NativeRecentCaptureEntry = { path: '/library/a.png', name: 'a.png', kind: 'still', byteSize: 4, modifiedAt: 1, modifiedAtNanos: '1' };

describe('recent thumbnail resource lifetime', () => {
    afterEach(async () => { await standardCleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

    it('releases the previous still on replacement and the held still on picker close', async () => {
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke: async () => [1, 2, 3] });
        const create = vi.spyOn(URL, 'createObjectURL').mockReturnValueOnce('blob:first').mockReturnValueOnce('blob:second');
        const release = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
        const hook = await renderHook(({ item }) => useRecentCaptureThumbnail(item, readRecentCaptureThumbnail, true), { initialProps: { item: entry } });
        expect(hook.getCurrent()?.uri).toBe('blob:first');
        await hook.rerender({ item: { ...entry, modifiedAt: 2, modifiedAtNanos: '2' } });
        expect(hook.getCurrent()?.uri).toBe('blob:second');
        expect(release.mock.calls).toEqual([['blob:first']]);
        await hook.unmount();
        expect(create).toHaveBeenCalledTimes(2);
        expect(release.mock.calls).toEqual([['blob:first'], ['blob:second']]);
    });

    it('does not allocate a URL after a native read completes beyond picker close', async () => {
        const bytes = createDeferred<number[]>();
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke: () => bytes.promise });
        const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:late');
        const release = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
        const hook = await renderHook(() => useRecentCaptureThumbnail(entry, readRecentCaptureThumbnail, true));
        await hook.unmount();
        await act(async () => { bytes.resolve([1, 2, 3]); });
        expect(create).not.toHaveBeenCalled();
        expect(release).not.toHaveBeenCalled();
    });

    it('releases the video source even when the platform decoder cannot start', async () => {
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke: async () => [1, 2, 3] });
        vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:video');
        const release = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
        // Node has no web media decoder: this is the real owner's SDK failure path.
        await expect(readRecentCaptureThumbnail({ ...entry, kind: 'video' })).rejects.toThrow();
        expect(release.mock.calls).toEqual([['blob:video']]);
    });
});
