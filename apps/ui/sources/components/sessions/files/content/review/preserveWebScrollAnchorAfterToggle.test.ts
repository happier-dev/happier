import { describe, expect, it, vi } from 'vitest';

import { preserveWebScrollAnchorAfterToggle } from './preserveWebScrollAnchorAfterToggle';

describe('preserveWebScrollAnchorAfterToggle', () => {
    it('waits for layout and applies the final displacement only once', () => {
        const frames: FrameRequestCallback[] = [];
        const requestFrame = vi.fn((callback: FrameRequestCallback) => {
            frames.push(callback);
            return frames.length;
        });
        const scrollRoot = { scrollTop: 100 };
        const readAnchorY = vi.fn(() => 140);

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
        expect(scrollRoot.scrollTop).toBe(200);
        expect(frames).toHaveLength(0);
        expect(readAnchorY).toHaveBeenCalledTimes(1);
    });
});
