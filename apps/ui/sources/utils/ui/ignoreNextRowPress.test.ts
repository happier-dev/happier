import { describe, expect, it, vi } from 'vitest';
import { ignoreNextRowPress } from './ignoreNextRowPress';

describe('ignoreNextRowPress', () => {
    it('resets the ignore flag on the next tick', () => {
        const ref = { current: false };
        const scheduledCallbacks: Array<() => void> = [];

        const setTimeoutSpy = vi
            .spyOn(globalThis, 'setTimeout')
            .mockImplementation((callback: Parameters<typeof setTimeout>[0]) => {
                scheduledCallbacks.push(() => {
                    if (typeof callback === 'function') {
                        callback();
                    }
                });

                return 0 as unknown as ReturnType<typeof setTimeout>;
            });

        try {
            ignoreNextRowPress(ref);
            expect(ref.current).toBe(true);
            expect(scheduledCallbacks).toHaveLength(1);

            scheduledCallbacks[0]();
            expect(ref.current).toBe(false);
        } finally {
            setTimeoutSpy.mockRestore();
        }
    });

    it('remains ignored through repeated calls until timers flush', () => {
        const ref = { current: false };
        const scheduledCallbacks: Array<() => void> = [];

        const setTimeoutSpy = vi
            .spyOn(globalThis, 'setTimeout')
            .mockImplementation((callback: Parameters<typeof setTimeout>[0]) => {
                scheduledCallbacks.push(() => {
                    if (typeof callback === 'function') {
                        callback();
                    }
                });

                return 0 as unknown as ReturnType<typeof setTimeout>;
            });

        try {
            ignoreNextRowPress(ref);
            ignoreNextRowPress(ref);
            expect(ref.current).toBe(true);
            expect(scheduledCallbacks).toHaveLength(2);

            for (const callback of scheduledCallbacks) {
                callback();
            }

            expect(ref.current).toBe(false);
        } finally {
            setTimeoutSpy.mockRestore();
        }
    });
});
