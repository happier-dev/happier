import { describe, expect, it } from 'vitest';

import { resolveSessionModeChipPresentation } from './resolveSessionModeChipPresentation';

function control(selectedId: string, label = selectedId) {
    return {
        selectedId,
        label,
        options: [{ id: selectedId, name: label }],
    };
}

describe('resolveSessionModeChipPresentation', () => {
    it('draws build mode with the launching rocket', () => {
        // The plain `rocket` sits upright and reads as a static object next to the rest of the chip
        // row; `rocket-launch` is the angled one with the trail, which reads as an action.
        expect(resolveSessionModeChipPresentation(control('build')).iconName).toBe('rocket-launch');
    });

    it('draws plan mode with the list glyph', () => {
        expect(resolveSessionModeChipPresentation(control('plan')).iconName).toBe('list');
    });

    it('falls back to plan for an unknown mode', () => {
        expect(resolveSessionModeChipPresentation(control('whatever')).iconName).toBe('list');
    });

    it('prefers plan when a mode reads as both', () => {
        expect(resolveSessionModeChipPresentation({
            selectedId: 'build',
            label: 'plan',
            options: [{ id: 'build', name: 'build' }],
        }).iconName).toBe('list');
    });
});
