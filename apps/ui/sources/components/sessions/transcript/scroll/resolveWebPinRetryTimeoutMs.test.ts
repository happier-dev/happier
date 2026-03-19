import { describe, expect, it } from 'vitest';

import { resolveWebPinRetryTimeoutMs } from './resolveWebPinRetryTimeoutMs';

describe('resolveWebPinRetryTimeoutMs', () => {
    it('returns the remaining time until a milestone', () => {
        expect(resolveWebPinRetryTimeoutMs({ startedAtMs: 1000, nowMs: 1000, milestoneMs: 50 })).toBe(50);
        expect(resolveWebPinRetryTimeoutMs({ startedAtMs: 1000, nowMs: 1020, milestoneMs: 50 })).toBe(30);
    });

    it('clamps to 0 when the milestone already passed', () => {
        expect(resolveWebPinRetryTimeoutMs({ startedAtMs: 1000, nowMs: 1200, milestoneMs: 50 })).toBe(0);
    });
});
