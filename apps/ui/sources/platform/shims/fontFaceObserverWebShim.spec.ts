import { describe, expect, it, vi } from 'vitest';

describe('fontFaceObserverWebShim', () => {
    it('does not reject when font loading times out', async () => {
        vi.useFakeTimers();
        const fontsLoad = vi.fn(() => new Promise<FontFace[]>(() => {}));
        vi.stubGlobal('document', { fonts: { load: fontsLoad } });
        try {
            const { default: FontFaceObserver } = await import('./fontFaceObserverWebShim');
            const observer = new FontFaceObserver('TestFont');
            let settled = false;
            const loadPromise = observer.load(null, 50).then((result) => {
                settled = true;
                return result;
            });
            expect(fontsLoad).toHaveBeenCalled();

            await vi.advanceTimersByTimeAsync(49);
            expect(settled).toBe(false);
            await vi.advanceTimersByTimeAsync(1);
            await expect(loadPromise).resolves.toBe(observer);
        } finally {
            vi.unstubAllGlobals();
            vi.useRealTimers();
        }
    });
});
