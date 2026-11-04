import { describe, expect, it } from 'vitest';

import { capturePillLeavesOnItsOwn } from './CaptureDeliveryPill';

describe('capturePillLeavesOnItsOwn', () => {
    it('holds a failure and anything still under way; a settled line leaves', () => {
        expect(capturePillLeavesOnItsOwn({ kind: 'failed', session: 'A', cause: 'x' })).toBe(false);
        expect(capturePillLeavesOnItsOwn({ kind: 'sending', session: 'A' })).toBe(false);
        expect(capturePillLeavesOnItsOwn({ kind: 'adding', session: 'A' })).toBe(false);
        expect(capturePillLeavesOnItsOwn({ kind: 'sent', session: 'A', detail: 'B' })).toBe(true);
        expect(capturePillLeavesOnItsOwn({ kind: 'added', session: 'A', imageNumber: 2, waiting: 2 })).toBe(true);
        expect(capturePillLeavesOnItsOwn({ kind: 'discarded' })).toBe(true);
    });
});
