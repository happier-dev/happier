import { describe, expect, it } from 'vitest';

import {
    resolveWebKeyboardReferenceViewportHeight,
    updateWebVisualViewportKeyboardReference,
    type WebVisualViewportKeyboardReference,
} from './webVisualViewportKeyboardReference';

function read(width: number, visualBottom: number, isEditableElementFocused = false, layoutViewportHeight = 846) {
    return { width, visualBottom, layoutViewportHeight, isEditableElementFocused };
}

function bounds(layoutViewportHeight: number, currentVisualBottom: number) {
    return { layoutViewportHeight, currentVisualBottom };
}

describe('updateWebVisualViewportKeyboardReference', () => {
    it('uses the unoccluded visual bottom as the keyboard reference', () => {
        let state: WebVisualViewportKeyboardReference | null = null;
        state = updateWebVisualViewportKeyboardReference(state, read(480, 820));
        state = updateWebVisualViewportKeyboardReference(state, read(480, 533, true));

        expect(resolveWebKeyboardReferenceViewportHeight(state, bounds(846, 533))).toBe(820);
    });

    it('falls back to the layout viewport height until an unoccluded reading exists', () => {
        let state: WebVisualViewportKeyboardReference | null = null;
        state = updateWebVisualViewportKeyboardReference(state, read(480, 533, true));

        expect(resolveWebKeyboardReferenceViewportHeight(state, bounds(846, 533))).toBe(846);

        // After the keyboard closes once, the unoccluded visual bottom becomes authoritative.
        state = updateWebVisualViewportKeyboardReference(state, read(480, 820));
        expect(resolveWebKeyboardReferenceViewportHeight(state, bounds(846, 820))).toBe(820);
    });

    it('lets focused readings grow the layout fallback but never the unoccluded reference', () => {
        let state: WebVisualViewportKeyboardReference | null = null;
        state = updateWebVisualViewportKeyboardReference(state, read(480, 533, true, 700));

        // Focused readings must not pollute the visual reference even when larger.
        expect(state.maxUnfocusedVisualBottom).toBeNull();
        expect(resolveWebKeyboardReferenceViewportHeight(state, bounds(700, 533))).toBe(700);
    });

    it('drops an unoccluded reference from before a width change (rotation)', () => {
        let state: WebVisualViewportKeyboardReference | null = null;
        state = updateWebVisualViewportKeyboardReference(state, read(480, 820));

        // Landscape: no unoccluded reading yet in the new width; the layout viewport (which
        // rotates synchronously with the window) is the only sound reference.
        state = updateWebVisualViewportKeyboardReference(state, read(844, 390, true, 600));
        expect(state.maxUnfocusedVisualBottom).toBeNull();
        expect(resolveWebKeyboardReferenceViewportHeight(state, bounds(600, 390))).toBe(600);
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
        expect(resolveWebKeyboardReferenceViewportHeight(after, bounds(846, 533))).toBe(820);
        expect(resolveWebKeyboardReferenceViewportHeight(
            updateWebVisualViewportKeyboardReference(null, { width: 0, visualBottom: 0, layoutViewportHeight: 0, isEditableElementFocused: false }),
            bounds(0, 0),
        )).toBe(0);
    });
});

describe('resolveWebKeyboardReferenceViewportHeight clamp to the current layout bottom', () => {
    it('ignores the dynamic-toolbar overshoot: toolbar-hidden visual bottom never exceeds the layout viewport', () => {
        // Firefox Android, measured on-device: innerHeight 678 regardless of the URL toolbar,
        // visual bottom 742 with the toolbar hidden, visual bottom 380.5 with the keyboard up
        // (toolbar shown again). The true keyboard occupancy is 678 - 380.5, so the reference
        // must resolve to 678, not 742.
        let state: WebVisualViewportKeyboardReference | null = null;
        state = updateWebVisualViewportKeyboardReference(state, read(384, 742, false, 678));
        state = updateWebVisualViewportKeyboardReference(state, read(384, 380.5, true, 678));

        expect(resolveWebKeyboardReferenceViewportHeight(state, bounds(678, 380.5))).toBe(678);
    });

    it('collapses to the shrunken layout viewport on content-resizing browsers', () => {
        // Chrome/iOS resize the layout viewport itself for the keyboard: innerHeight and the
        // visual bottom both land at the keyboard top. The reference must follow the layout
        // bottom (380), yielding a ~0 inset — the resized canvas already ends at the keyboard.
        let state: WebVisualViewportKeyboardReference | null = null;
        state = updateWebVisualViewportKeyboardReference(state, read(384, 678, false, 678));
        state = updateWebVisualViewportKeyboardReference(state, read(384, 380, true, 380));

        expect(resolveWebKeyboardReferenceViewportHeight(state, bounds(380, 380))).toBe(380);
    });

    it('follows a partially resized layout viewport', () => {
        // A browser that resizes the layout only part of the keyboard height still ends the
        // canvas at the shrunken layout bottom; the reference must not exceed it either.
        let state: WebVisualViewportKeyboardReference | null = null;
        state = updateWebVisualViewportKeyboardReference(state, read(384, 678, false, 678));
        state = updateWebVisualViewportKeyboardReference(state, read(384, 380.5, true, 550));

        expect(resolveWebKeyboardReferenceViewportHeight(state, bounds(550, 380.5))).toBe(550);
    });
});
