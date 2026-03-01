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
});
