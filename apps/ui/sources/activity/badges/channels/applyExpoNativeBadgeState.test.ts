import { beforeEach, describe, expect, it, vi } from 'vitest';

const setBadgeCountAsync = vi.hoisted(() => vi.fn(async () => true));
const notificationNativeState = vi.hoisted(() => ({ unavailable: false }));

vi.mock('expo-notifications', () => {
    if (notificationNativeState.unavailable) {
        throw new Error('expo-notifications native module unavailable');
    }
    return {
        setBadgeCountAsync,
    };
});

describe('applyExpoNativeBadgeState', () => {
    beforeEach(() => {
        vi.resetModules();
        notificationNativeState.unavailable = false;
        setBadgeCountAsync.mockClear();
        setBadgeCountAsync.mockResolvedValue(true);
    });

    it('does not load expo-notifications while importing the badge channel module', async () => {
        notificationNativeState.unavailable = true;

        await expect(import('./applyExpoNativeBadgeState')).resolves.toHaveProperty('applyExpoNativeBadgeState');
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

    it('recovers from a stalled native badge update instead of dropping every later update', async () => {
        vi.useFakeTimers();
        try {
            const { applyExpoNativeBadgeState } = await import('./applyExpoNativeBadgeState');
            setBadgeCountAsync.mockImplementationOnce(() => new Promise(() => {}));

            const stalled = applyExpoNativeBadgeState({ count: 1, showNonNumericDot: false });
            await vi.advanceTimersByTimeAsync(30_000);
            expect(await stalled).toBe(false);

            // The in-flight guard must have cleared, otherwise later counts are silently dropped
            // for the lifetime of the process.
            setBadgeCountAsync.mockResolvedValue(true);
            await expect(applyExpoNativeBadgeState({ count: 2, showNonNumericDot: false })).resolves.toBe(true);
            expect(setBadgeCountAsync).toHaveBeenLastCalledWith(2);
        } finally {
            vi.useRealTimers();
        }
    });

    it('returns false when the native platform refuses the badge update', async () => {
        setBadgeCountAsync.mockResolvedValueOnce(false);
        const { applyExpoNativeBadgeState } = await import('./applyExpoNativeBadgeState');

        const result = await applyExpoNativeBadgeState({ count: 2, showNonNumericDot: false });

        expect(result).toBe(false);
    });
});
