import { describe, expect, it } from 'vitest';

import { resolveWebHotColdScrollDecision } from './resolveWebHotColdScrollDecision';

describe('resolveWebHotColdScrollDecision', () => {
    it('scrolls to the cold index when the target is within cold items', () => {
        expect(resolveWebHotColdScrollDecision({ fullIndex: 3, coldCount: 10 })).toEqual({ kind: 'cold', index: 3 });
    });

    it('scrolls to the last cold index when the target is in the hot tail', () => {
        expect(resolveWebHotColdScrollDecision({ fullIndex: 10, coldCount: 10 })).toEqual({ kind: 'cold', index: 9 });
        expect(resolveWebHotColdScrollDecision({ fullIndex: 999, coldCount: 2 })).toEqual({ kind: 'cold', index: 1 });
    });

    it('pins to bottom when there are no cold items', () => {
        expect(resolveWebHotColdScrollDecision({ fullIndex: 0, coldCount: 0 })).toEqual({ kind: 'pin_to_bottom' });
    });
});
