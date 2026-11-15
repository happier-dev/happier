import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('temporary session navigation data lifecycle', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(async () => {
        const { clearTempData } = await import('./tempDataStore');
        clearTempData();
        vi.clearAllTimers();
        vi.useRealTimers();
    });

    it('arms no timer while navigation data is pending (expiry is decided on read)', async () => {
        const { storeTempData, getTempData, peekTempData } = await import('./tempDataStore');
        const draft = { prompt: 'Continue this Session' };
        const key = storeTempData(draft);
        const abandoned = storeTempData({ prompt: 'Abandoned' });
        expect(vi.getTimerCount()).toBe(0);
        expect(peekTempData(key)).toBe(draft);
        expect(getTempData(key)).toBe(draft);
        expect(getTempData(key)).toBeNull();

        await vi.advanceTimersByTimeAsync(10 * 60_000);
        expect(peekTempData(abandoned)).toEqual({ prompt: 'Abandoned' });
        await vi.advanceTimersByTimeAsync(1);
        expect(peekTempData(abandoned)).toBeNull();
        expect(getTempData(abandoned)).toBeNull();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('releases cleanup when navigation data is explicitly cleared', async () => {
        const { storeTempData, clearTempData, peekTempData } = await import('./tempDataStore');
        const key = storeTempData({ prompt: 'Cancelled' });
        clearTempData();
        expect(peekTempData(key)).toBeNull();
        expect(vi.getTimerCount()).toBe(0);
    });
});
