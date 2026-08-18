import { describe, expect, it } from 'vitest';

import {
    resolveWebKeyboardReferenceViewportHeight,
    updateWebVisualViewportKeyboardReference,
    type WebVisualViewportKeyboardReference,
} from './webVisualViewportKeyboardReference';

function read(width: number, visualBottom: number, isEditableElementFocused = false, layoutViewportHeight = 846) {
    return { width, visualBottom, layoutViewportHeight, isEditableElementFocused };
}

describe('updateWebVisualViewportKeyboardReference', () => {
    it('uses the unoccluded visual bottom as the keyboard reference', () => {
        let state: WebVisualViewportKeyboardReference | null = null;
        state = updateWebVisualViewportKeyboardReference(state, read(480, 820));
        state = updateWebVisualViewportKeyboardReference(state, read(480, 533, true));

        expect(resolveWebKeyboardReferenceViewportHeight(state)).toBe(820);
    });

    it('falls back to the layout viewport height until an unoccluded reading exists', () => {
        let state: WebVisualViewportKeyboardReference | null = null;
        state = updateWebVisualViewportKeyboardReference(state, read(480, 533, true));

        expect(resolveWebKeyboardReferenceViewportHeight(state)).toBe(846);

        // After the keyboard closes once, the unoccluded visual bottom becomes authoritative.
        state = updateWebVisualViewportKeyboardReference(state, read(480, 820));
        expect(resolveWebKeyboardReferenceViewportHeight(state)).toBe(820);
    });

    it('lets focused readings grow the layout fallback but never the unoccluded reference', () => {
        let state: WebVisualViewportKeyboardReference | null = null;
        state = updateWebVisualViewportKeyboardReference(state, read(480, 533, true, 700));

        // Focused readings must not pollute the visual reference even when larger.
        expect(state.maxUnfocusedVisualBottom).toBeNull();
        expect(resolveWebKeyboardReferenceViewportHeight(state)).toBe(700);
    });

    it('drops an unoccluded reference from before a width change (rotation)', () => {
        let state: WebVisualViewportKeyboardReference | null = null;
        state = updateWebVisualViewportKeyboardReference(state, read(480, 820));

        // Landscape: no unoccluded reading yet in the new width; the layout viewport (which
        // rotates synchronously with the window) is the only sound reference.
        state = updateWebVisualViewportKeyboardReference(state, read(844, 390, true, 600));
        expect(state.maxUnfocusedVisualBottom).toBeNull();
        expect(resolveWebKeyboardReferenceViewportHeight(state)).toBe(600);
    });

    it('ignores non-positive or non-finite readings without losing the reference', () => {
        let state: WebVisualViewportKeyboardReference | null = null;
        state = updateWebVisualViewportKeyboardReference(state, read(480, 820));
        const after = updateWebVisualViewportKeyboardReference(state, {
            width: Number.NaN,
            visualBottom: 533,
            layoutViewportHeight: 846,
            isEditableElementFocused: true,
        });

        expect(after).toBe(state);
        expect(resolveWebKeyboardReferenceViewportHeight(after)).toBe(820);
        expect(resolveWebKeyboardReferenceViewportHeight(
            updateWebVisualViewportKeyboardReference(null, { width: 0, visualBottom: 0, layoutViewportHeight: 0, isEditableElementFocused: false }),
        )).toBe(0);
    });
});
