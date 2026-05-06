import { beforeEach, describe, expect, it, vi } from 'vitest';

const setBadgeCount = vi.hoisted(() => vi.fn(async () => {}));
const setBadgeLabel = vi.hoisted(() => vi.fn(async () => {}));

vi.mock('@tauri-apps/api/window', () => ({
    getCurrentWindow: () => ({
        setBadgeCount,
        setBadgeLabel,
    }),
}));

describe('applyTauriBadgeState', () => {
    beforeEach(() => {
        vi.resetModules();
        setBadgeCount.mockClear();
        setBadgeLabel.mockClear();
        setBadgeCount.mockImplementation(async () => {});
        setBadgeLabel.mockImplementation(async () => {});
    });

    it('sets a numeric badge without immediately clearing the macOS dock label', async () => {
        const { applyTauriBadgeState } = await import('./applyTauriBadgeState');

        await applyTauriBadgeState({ count: 3, showNonNumericDot: true });

        expect(setBadgeCount).toHaveBeenCalledWith(3);
        expect(setBadgeLabel).not.toHaveBeenCalled();
    });

    it('shows a dot label on macOS when only non-numeric attention exists', async () => {
        const { applyTauriBadgeState } = await import('./applyTauriBadgeState');

        await applyTauriBadgeState({ count: 0, showNonNumericDot: true });

        expect(setBadgeCount).toHaveBeenCalledWith(undefined);
        expect(setBadgeLabel).toHaveBeenCalledWith('•');
    });

    it('serializes writes and coalesces queued intermediate badge states', async () => {
        let releaseFirstCount: (() => void) | null = null;
        setBadgeCount.mockImplementationOnce(
            async () => new Promise<void>((resolve) => {
                releaseFirstCount = resolve;
            }),
        );

        const { applyTauriBadgeState } = await import('./applyTauriBadgeState');

        const first = applyTauriBadgeState({ count: 3, showNonNumericDot: false });
        const second = applyTauriBadgeState({ count: 0, showNonNumericDot: true });
        const third = applyTauriBadgeState({ count: 5, showNonNumericDot: false });

        await Promise.resolve();

        expect(setBadgeCount).toHaveBeenCalledTimes(1);
        expect(setBadgeCount).toHaveBeenNthCalledWith(1, 3);

        const release = releaseFirstCount as (() => void) | null;
        if (!release) throw new Error('first badge count write did not start');
        release();
        await Promise.all([first, second, third]);

        expect(setBadgeCount).toHaveBeenCalledTimes(2);
        expect(setBadgeCount).toHaveBeenNthCalledWith(2, 5);
        expect(setBadgeLabel).not.toHaveBeenCalled();
    });
});
