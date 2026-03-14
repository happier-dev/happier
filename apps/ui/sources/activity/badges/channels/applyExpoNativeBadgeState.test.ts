import { beforeEach, describe, expect, it, vi } from 'vitest';

const setBadgeCountAsync = vi.hoisted(() => vi.fn(async () => true));

vi.mock('expo-notifications', () => ({
    setBadgeCountAsync,
}));

describe('applyExpoNativeBadgeState', () => {
    beforeEach(() => {
        setBadgeCountAsync.mockClear();
    });

    it('applies the numeric badge count', async () => {
        const { applyExpoNativeBadgeState } = await import('./applyExpoNativeBadgeState');

        await applyExpoNativeBadgeState({ count: 4, showNonNumericDot: false });

        expect(setBadgeCountAsync).toHaveBeenCalledWith(4);
    });

    it('clears the badge when only non-numeric attention exists', async () => {
        const { applyExpoNativeBadgeState } = await import('./applyExpoNativeBadgeState');

        await applyExpoNativeBadgeState({ count: 0, showNonNumericDot: true });

        expect(setBadgeCountAsync).toHaveBeenCalledWith(0);
    });
});
