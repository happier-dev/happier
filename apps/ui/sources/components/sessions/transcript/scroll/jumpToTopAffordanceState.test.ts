import { describe, expect, it } from 'vitest';

import { resolveJumpToTopAffordanceState } from './jumpToTopAffordanceState';

describe('resolveJumpToTopAffordanceState', () => {
    const base = { distanceFromTop: 0, enabled: true, hasMoreOlder: false, revealThresholdPx: 500 };

    it('stays hidden when disabled', () => {
        expect(resolveJumpToTopAffordanceState({ ...base, enabled: false, hasMoreOlder: true, distanceFromTop: 9000 }).isVisible).toBe(false);
    });

    it('stays hidden at the very top with nothing older to load', () => {
        expect(resolveJumpToTopAffordanceState(base).isVisible).toBe(false);
        expect(resolveJumpToTopAffordanceState({ ...base, distanceFromTop: 499 }).isVisible).toBe(false);
    });

    it('shows once the reader is past the reveal threshold from the top', () => {
        expect(resolveJumpToTopAffordanceState({ ...base, distanceFromTop: 500 }).isVisible).toBe(true);
    });

    it('shows whenever older history is still unloaded, even at the loaded top', () => {
        expect(resolveJumpToTopAffordanceState({ ...base, hasMoreOlder: true }).isVisible).toBe(true);
    });
});
