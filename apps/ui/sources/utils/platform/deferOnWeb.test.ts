import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('deferOnWeb', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.unstubAllGlobals();
    });

    it('defers execution on web', async () => {
        vi.doMock('react-native', () => ({
            Platform: { OS: 'web' },
        }));

        const { deferOnWeb } = await import('./deferOnWeb');
        const action = vi.fn();
        let deferredFrame: FrameRequestCallback | null = null;

        vi.stubGlobal('requestAnimationFrame', ((callback: FrameRequestCallback) => {
            deferredFrame = callback;
            return 1;
        }) as typeof requestAnimationFrame);

        deferOnWeb(action);

        expect(action).not.toHaveBeenCalled();
        expect(deferredFrame).not.toBeNull();
        deferredFrame?.(0);
        expect(action).toHaveBeenCalledTimes(1);
    });

    it('runs immediately off web', async () => {
        vi.doMock('react-native', () => ({
            Platform: { OS: 'ios' },
        }));

        const { deferOnWeb } = await import('./deferOnWeb');
        const action = vi.fn();
        deferOnWeb(action);
        expect(action).toHaveBeenCalledTimes(1);
    });

    it('blurs the active element before navigating on web', async () => {
        const blurSpy = vi.fn();
        vi.doMock('react-native', () => ({
            Platform: { OS: 'web' },
        }));
        vi.stubGlobal('document', {
            activeElement: { blur: blurSpy },
        });

        const { navigateWithBlurOnWeb } = await import('./deferOnWeb');
        const action = vi.fn();

        navigateWithBlurOnWeb(action);

        expect(blurSpy).toHaveBeenCalledTimes(1);
        expect(action).toHaveBeenCalledTimes(1);
    });
});
