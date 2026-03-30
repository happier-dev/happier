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
        setBadgeCount.mockClear();
        setBadgeLabel.mockClear();
    });

    it('sets a numeric badge and clears the label when count is positive', async () => {
        const { applyTauriBadgeState } = await import('./applyTauriBadgeState');

        await applyTauriBadgeState({ count: 3, showNonNumericDot: true });

        expect(setBadgeCount).toHaveBeenCalledWith(3);
        expect(setBadgeLabel).toHaveBeenCalledWith(undefined);
    });

    it('shows a dot label on macOS when only non-numeric attention exists', async () => {
        const { applyTauriBadgeState } = await import('./applyTauriBadgeState');

        await applyTauriBadgeState({ count: 0, showNonNumericDot: true });

        expect(setBadgeCount).toHaveBeenCalledWith(undefined);
        expect(setBadgeLabel).toHaveBeenCalledWith('•');
    });
});
