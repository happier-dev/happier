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

    it('keeps auto-horizontal placement to the right when there is enough right space', () => {
        expect(resolvePlacement({
            placement: 'auto-horizontal',
            preferredMinAvailable: 240,
            available: {
                top: 240,
                bottom: 120,
                left: 320,
                right: 240,
            },
        })).toBe('right');
    });

    it('limits auto-horizontal placement to the side with more horizontal space', () => {
        expect(resolvePlacement({
            placement: 'auto-horizontal',
            preferredMinAvailable: 240,
            available: {
                top: 240,
                bottom: 120,
                left: 320,
                right: 24,
            },
        })).toBe('left');
    });
});
