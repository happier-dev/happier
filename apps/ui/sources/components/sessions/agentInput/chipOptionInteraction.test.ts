import { describe, expect, it } from 'vitest';

import { resolveChipOptionInteraction, shouldRenderChipForOptions } from './chipOptionInteraction';

describe('chipOptionInteraction', () => {
    it('cycles when selectable options are within the cycle threshold', () => {
        expect(resolveChipOptionInteraction({
            currentOptionId: 'claude',
            selectableOptionIds: ['claude', 'opencode'],
            cycleMaxOptions: 3,
        })).toEqual({
            kind: 'cycle',
            selectableOptionIds: ['claude', 'opencode'],
            nextOptionId: 'opencode',
        });
    });

    it('opens picker when selectable options exceed the cycle threshold', () => {
        expect(resolveChipOptionInteraction({
            currentOptionId: 'claude',
            selectableOptionIds: ['claude', 'codex', 'opencode', 'gemini'],
            cycleMaxOptions: 3,
        })).toEqual({
            kind: 'picker',
            selectableOptionIds: ['claude', 'codex', 'opencode', 'gemini'],
        });
    });

    it('returns no-op when there are no selectable options', () => {
        expect(resolveChipOptionInteraction({
            currentOptionId: 'claude',
            selectableOptionIds: [],
            cycleMaxOptions: 3,
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
