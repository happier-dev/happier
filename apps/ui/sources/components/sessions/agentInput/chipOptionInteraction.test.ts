import { describe, expect, it } from 'vitest';

import { resolveChipOptionInteraction, shouldRenderChipForOptions } from './chipOptionInteraction';

describe('chipOptionInteraction', () => {
    // DESIGN.md: never tap-to-cycle. Two or more choices always open a visible picker, so one stray
    // tap never silently changes how the agent works.
    it('opens the picker for two choices instead of cycling', () => {
        expect(resolveChipOptionInteraction({
            currentOptionId: 'claude',
            selectableOptionIds: ['claude', 'opencode'],
        })).toEqual({
            kind: 'picker',
            selectableOptionIds: ['claude', 'opencode'],
        });
    });

    it('opens the picker for three choices including the empty clear choice', () => {
        expect(resolveChipOptionInteraction({
            currentOptionId: 'plan',
            selectableOptionIds: ['', 'default', 'plan'],
        })).toEqual({
            kind: 'picker',
            selectableOptionIds: ['', 'default', 'plan'],
        });
    });

    it('offers nothing to choose when the only choice is the current one', () => {
        expect(resolveChipOptionInteraction({
            currentOptionId: 'claude',
            selectableOptionIds: ['claude'],
        })).toEqual({
            kind: 'none',
            selectableOptionIds: ['claude'],
        });
    });

    it('returns no-op when there are no selectable options', () => {
        expect(resolveChipOptionInteraction({
            currentOptionId: 'claude',
            selectableOptionIds: [],
        })).toEqual({
            kind: 'none',
            selectableOptionIds: [],
        });
    });

    it('supports chip visibility policies for reusable option chips', () => {
        expect(shouldRenderChipForOptions({
            optionCount: 0,
            showWhenNoOptions: true,
            showWhenSingleOption: true,
        })).toBe(true);
        expect(shouldRenderChipForOptions({
            optionCount: 1,
            showWhenNoOptions: false,
            showWhenSingleOption: false,
        })).toBe(false);
    });
});
