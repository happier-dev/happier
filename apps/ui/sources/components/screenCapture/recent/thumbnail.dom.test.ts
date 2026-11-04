// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createDeferred, renderHook, standardCleanup } from '@/dev/testkit';
import type { NativeRecentCaptureEntry } from '@/desktop/capture/nativeCapture';
import { readRecentCaptureThumbnail, useRecentCaptureThumbnail } from './thumbnail';

const entry: NativeRecentCaptureEntry = { path: '/library/video.mp4', name: 'video.mp4', kind: 'video', byteSize: 4, modifiedAt: 1, modifiedAtNanos: '1' };

describe('recent video thumbnail decoder lifetime', () => {
    afterEach(async () => { await standardCleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

    it('retires a waiting decoder on replacement and closes its replacement on picker close', async () => {
        const created: HTMLVideoElement[] = [];
        const requested = createDeferred<void>();
        const createElement = document.createElement.bind(document);
        // Only HTML media decode/transport is substituted; thumbnail and finite decoder owners are real.
        vi.spyOn<{ createElement(tagName: string, options?: ElementCreationOptions): HTMLElement }, 'createElement'>(document, 'createElement').mockImplementation((tag, options) => {
            const element = createElement(tag, options);
            if (tag === 'video') {
                const video = element as HTMLVideoElement;
                vi.spyOn(video, 'pause').mockImplementation(() => undefined);
                vi.spyOn(video, 'load').mockImplementation(() => video.dispatchEvent(new Event('emptied')));
                created.push(video);
                requested.resolve();
            }
            return element;
        });
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke: async () => [1, 2, 3] });
        const createUrl = vi.fn().mockReturnValueOnce('blob:one').mockReturnValueOnce('blob:two');
        const revoke = vi.fn();
        vi.stubGlobal('URL', class extends URL {
            static createObjectURL = createUrl;
            static revokeObjectURL = revoke;
        });
        const hook = await renderHook(({ item }) => useRecentCaptureThumbnail(item, readRecentCaptureThumbnail, true), { initialProps: { item: entry } });
        await requested.promise;
        expect(created[0]?.getAttribute('src')).toBe('blob:one');
        await hook.rerender({ item: { ...entry, modifiedAtNanos: '2' } });
        expect(created[0]?.hasAttribute('src')).toBe(false);
        expect(revoke.mock.calls).toEqual([['blob:one']]);
        await act(async () => { await hook.unmount(); });
        expect(created).toHaveLength(2);
        expect(created[1]?.hasAttribute('src')).toBe(false);
        expect(revoke.mock.calls).toEqual([['blob:one'], ['blob:two']]);
        expect(hook.getCurrent()).toBeNull();
    });
});
