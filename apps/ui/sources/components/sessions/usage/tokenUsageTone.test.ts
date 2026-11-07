import { describe, expect, it } from 'vitest';

import { resolveRemainingUsageColor } from './tokenUsageTone';

const colors = { fullColor: '#00ff00', midColor: '#ffff00', emptyColor: '#ff0000' };

describe('resolveRemainingUsageColor', () => {
    it('is the full colour at 100% and the empty colour at 0%', () => {
        expect(resolveRemainingUsageColor({ remainingPct: 100, ...colors })).toBe('rgb(0, 255, 0)');
        expect(resolveRemainingUsageColor({ remainingPct: 0, ...colors })).toBe('rgb(255, 0, 0)');
    });

    it('blends through the mid colour and clamps out-of-range input', () => {
        expect(resolveRemainingUsageColor({ remainingPct: 50, ...colors })).toBe('rgb(255, 255, 0)');
        expect(resolveRemainingUsageColor({ remainingPct: 250, ...colors })).toBe('rgb(0, 255, 0)');
        expect(resolveRemainingUsageColor({ remainingPct: -5, ...colors })).toBe('rgb(255, 0, 0)');
    });
});
