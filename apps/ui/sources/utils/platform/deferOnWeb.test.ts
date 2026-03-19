import { describe, expect, it, vi } from 'vitest';

describe('deferOnWeb', () => {
    it('defers execution on web', async () => {
        vi.resetModules();
        vi.useFakeTimers();

        vi.doMock('react-native', () => ({
            Platform: { OS: 'web' },
        }));

        const { deferOnWeb } = await import('./deferOnWeb');
        const action = vi.fn();
        deferOnWeb(action);

        expect(action).not.toHaveBeenCalled();

        // requestAnimationFrame path (preferred)
        vi.runAllTimers();
        expect(action).toHaveBeenCalledTimes(1);
    });

    it('runs immediately off web', async () => {
        vi.resetModules();

        vi.doMock('react-native', () => ({
            Platform: { OS: 'ios' },
        }));

        const { deferOnWeb } = await import('./deferOnWeb');
        const action = vi.fn();
        deferOnWeb(action);
        expect(action).toHaveBeenCalledTimes(1);
    });

    it('blurs the active element before navigating on web', async () => {
        vi.resetModules();

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
