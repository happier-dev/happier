import { describe, expect, it } from 'vitest';

import { resolveShimmerAnimationEnabled } from './shimmerMotion';

describe('resolveShimmerAnimationEnabled', () => {
    it('disables decorative shimmer for reduced motion and explicit opt-out', () => {
        expect(resolveShimmerAnimationEnabled({ reducedMotion: true })).toBe(false);
        expect(resolveShimmerAnimationEnabled({ reducedMotion: false, animationEnabled: false })).toBe(false);
        expect(resolveShimmerAnimationEnabled({ reducedMotion: false })).toBe(true);
    });
});
