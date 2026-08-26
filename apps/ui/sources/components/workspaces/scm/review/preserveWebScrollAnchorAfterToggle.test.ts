import { describe, expect, it, vi } from 'vitest';

import { preserveWebScrollAnchorAfterToggle } from './preserveWebScrollAnchorAfterToggle';

describe('preserveWebScrollAnchorAfterToggle', () => {
    it('keeps correcting delayed virtual-list layout displacement across bounded frames', () => {
        const frames: FrameRequestCallback[] = [];
        const requestFrame = vi.fn((callback: FrameRequestCallback) => {
            frames.push(callback);
            return frames.length;
        });
        const detachedScrollRoot = { scrollTop: 100 };
        const currentScrollRoot = { scrollTop: 100 };
        const scrollRoots = [detachedScrollRoot, detachedScrollRoot, currentScrollRoot];
        const anchorPositions = [40, 40, 140, 40];
        const readCurrentAnchor = vi.fn(() => ({
            scrollRoot: scrollRoots.shift() ?? currentScrollRoot,
            anchorY: anchorPositions.shift() ?? 40,
        }));
        const onRestored = vi.fn();

        preserveWebScrollAnchorAfterToggle({
            anchorY: 40,
            readCurrentAnchor,
            requestFrame,
            onRestored,
        });

        expect(detachedScrollRoot.scrollTop).toBe(100);
        expect(currentScrollRoot.scrollTop).toBe(100);
        frames.shift()?.(1);
        expect(currentScrollRoot.scrollTop).toBe(100);
        frames.shift()?.(2);
        expect(currentScrollRoot.scrollTop).toBe(100);
        frames.shift()?.(3);
        expect(detachedScrollRoot.scrollTop).toBe(100);
        expect(currentScrollRoot.scrollTop).toBe(200);
        frames.shift()?.(4);
        expect(currentScrollRoot.scrollTop).toBe(200);

        while (frames.length > 0) {
            frames.shift()?.(5);
        }
        expect(readCurrentAnchor).toHaveBeenCalledTimes(12);
        expect(requestFrame).toHaveBeenCalledTimes(12);
        expect(onRestored).toHaveBeenCalledWith(200);
    });
});
