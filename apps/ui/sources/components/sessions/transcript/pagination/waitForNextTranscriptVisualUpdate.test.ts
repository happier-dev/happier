import { afterEach, describe, expect, it, vi } from 'vitest';

import { waitForNextTranscriptVisualUpdate } from './waitForNextTranscriptVisualUpdate';

const originalRequestAnimationFrame = globalThis.requestAnimationFrame;

afterEach(() => {
    Object.defineProperty(globalThis, 'requestAnimationFrame', {
        configurable: true,
        writable: true,
        value: originalRequestAnimationFrame,
    });
    vi.restoreAllMocks();
});

describe('waitForNextTranscriptVisualUpdate', () => {
    it('waits for two microtasks before requesting an animation frame', async () => {
        const requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
            callback(0);
            return 1;
        });
        Object.defineProperty(globalThis, 'requestAnimationFrame', {
            configurable: true,
            writable: true,
            value: requestAnimationFrame,
        });

        const pending = waitForNextTranscriptVisualUpdate();

        expect(requestAnimationFrame).not.toHaveBeenCalled();
        await Promise.resolve();
        expect(requestAnimationFrame).not.toHaveBeenCalled();
        await Promise.resolve();
        expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
        await pending;
    });

    it('resolves without an animation frame implementation', async () => {
        Object.defineProperty(globalThis, 'requestAnimationFrame', {
            configurable: true,
            writable: true,
            value: undefined,
        });

        await expect(waitForNextTranscriptVisualUpdate()).resolves.toBeUndefined();
    });

});
