import { describe, expect, it } from 'vitest';

import { resolvePlacement } from './positioning';

describe('resolvePlacement', () => {
    it('keeps auto-vertical placement below when there is enough bottom space', () => {
        expect(resolvePlacement({
            placement: 'auto-vertical',
            preferredMinAvailable: 320,
            available: {
                top: 520,
                bottom: 320,
                left: 320,
                right: 480,
            },
        })).toBe('bottom');
    });

    it('limits auto-vertical placement to the side with more vertical space', () => {
        expect(resolvePlacement({
            placement: 'auto-vertical',
            preferredMinAvailable: 320,
            available: {
                top: 240,
                bottom: 24,
                left: 320,
                right: 480,
            },
        })).toBe('top');
    });
});
