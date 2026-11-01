import { describe, expect, it, vi } from 'vitest';
import { ignoreNextRowPress } from './ignoreNextRowPress';

describe('ignoreNextRowPress', () => {
    it.each([1, 2])('resets the ignore flag on the next tick after %i calls', async (callCount) => {
        vi.useFakeTimers();
        const ref = { current: false };
        try {
            for (let index = 0; index < callCount; index += 1) ignoreNextRowPress(ref);
            expect(ref.current).toBe(true);
            await Promise.resolve();
            expect(ref.current).toBe(true);
            await vi.advanceTimersByTimeAsync(0);
            expect(ref.current).toBe(false);
        } finally {
            vi.useRealTimers();
        }
    });
});
