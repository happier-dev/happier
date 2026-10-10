import { describe, expect, it } from 'vitest';

import { resolveUsageCostModeLabel } from './resolveUsageCostModeLabel';

describe('resolveUsageCostModeLabel', () => {
    it('returns Auto when only auto mode is available', () => {
        expect(resolveUsageCostModeLabel({
            availableCostModes: ['auto'],
            mode: 'auto',
        })).toBe('Auto');
    });

    it('returns the translated label for the requested non-auto mode', () => {
        expect(resolveUsageCostModeLabel({
            availableCostModes: ['auto', 'reported', 'estimated'],
            mode: 'reported',
        })).toBe('Reported');

        expect(resolveUsageCostModeLabel({
            availableCostModes: ['auto', 'reported', 'estimated'],
            mode: 'estimated',
        })).toBe('Estimated');
    });
});
