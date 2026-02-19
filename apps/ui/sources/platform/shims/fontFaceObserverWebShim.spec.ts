import { describe, expect, it, vi } from 'vitest';

describe('fontFaceObserverWebShim', () => {
    it('does not reject when font loading times out', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-02-19T00:00:00.000Z'));

        const fontsLoad = vi.fn(async () => []);

        (globalThis as any).window = {
            navigator: {
                vendor: 'Google Inc.',
                userAgent: 'Mozilla/5.0 Chrome/121.0.0.0 Safari/537.36',
            },
        };
        (globalThis as any).document = {
            fonts: {
                load: fontsLoad,
            },
            hidden: false,
            createElement: () => ({ style: {} }),
        };
        (globalThis as any).window.document = (globalThis as any).document;

        const { default: FontFaceObserver } = await import('./fontFaceObserverWebShim');
        const observer = new FontFaceObserver('TestFont');

        const loadPromise = observer.load(null, 50);

        await vi.advanceTimersByTimeAsync(100);
        await expect(loadPromise).resolves.toBeDefined();
        expect(fontsLoad).toHaveBeenCalled();
    });
});
