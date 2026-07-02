import { describe, expect, it } from 'vitest';

import { resolveInitialWebPinRetryDelays } from './resolveInitialWebPinRetryDelays';

describe('resolveInitialWebPinRetryDelays', () => {
    it('returns no delays when stabilization is disabled', () => {
        expect(resolveInitialWebPinRetryDelays({
            milestonesMs: null,
            stabilizeMaxMs: 0,
            retryIntervalMs: 250,
        })).toEqual([]);
    });

    it('uses default early milestones and interval retries up to the stabilization window', () => {
        expect(resolveInitialWebPinRetryDelays({
            milestonesMs: null,
            stabilizeMaxMs: 1500,
            retryIntervalMs: 250,
        })).toEqual([16, 50, 100, 200, 400, 800, 1000, 1250, 1500]);
    });

    it('filters invalid custom milestones and clamps to the stabilization window', () => {
        expect(resolveInitialWebPinRetryDelays({
            milestonesMs: [80, Number.NaN, -1, 250, 900, 'bad'],
            stabilizeMaxMs: 300,
            retryIntervalMs: 250,
        })).toEqual([80, 250, 300]);
    });

    it('normalizes malformed retry intervals without producing sub-frame loops', () => {
        expect(resolveInitialWebPinRetryDelays({
            milestonesMs: [],
            stabilizeMaxMs: 1040,
            retryIntervalMs: 0,
        })).toEqual([16, 50, 100, 200, 400, 800, 1000, 1016, 1032, 1040]);
    });
});
