import { describe, expect, it, vi } from 'vitest';

import { preserveWebScrollAnchorAfterToggle } from './preserveWebScrollAnchorAfterToggle';

describe('preserveWebScrollAnchorAfterToggle', () => {
    it('keeps correcting delayed virtual-list layout displacement across bounded frames', () => {
        const frames: FrameRequestCallback[] = [];
        const requestFrame = vi.fn((callback: FrameRequestCallback) => {
            frames.push(callback);
            return frames.length;
        });
        const scrollRoot = { scrollTop: 100 };
        const anchorPositions = [40, 40, 140, 40];
        const readAnchorY = vi.fn(() => anchorPositions.shift() ?? 40);

        preserveWebScrollAnchorAfterToggle({
            anchorY: 40,
            scrollRoot,
            readAnchorY,
            requestFrame,
        });

        expect(scrollRoot.scrollTop).toBe(100);
        frames.shift()?.(1);
        expect(scrollRoot.scrollTop).toBe(100);
        frames.shift()?.(2);
        expect(scrollRoot.scrollTop).toBe(100);
        frames.shift()?.(3);
        expect(scrollRoot.scrollTop).toBe(200);
        frames.shift()?.(4);
        expect(scrollRoot.scrollTop).toBe(200);

        while (frames.length > 0) {
            frames.shift()?.(5);
        }
        expect(readAnchorY).toHaveBeenCalledTimes(12);
        expect(requestFrame).toHaveBeenCalledTimes(12);
    });
});
