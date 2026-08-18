// Reference height for the mobile-web software-keyboard inset.
//
// `window.innerHeight` is NOT a trustworthy unoccluded-viewport reference on every mobile
// browser: on Firefox Android it reports a layout viewport that ignores the dynamic URL
// toolbar, so the visual viewport with the toolbar HIDDEN (measured on-device: 742 CSS px)
// exceeds the layout viewport (678 CSS px it keeps even with the keyboard open).
// `innerHeight - visualViewport.height` therefore mixes browser chrome into the keyboard.
//
// The visual viewport is authoritative for what is actually visible. The unoccluded reference
// is the largest visual bottom (`height + offsetTop`) observed while NO editable was focused —
// a state in which the software keyboard cannot be covering the window — at the current
// viewport width. That reference is then CLAMPED by the current layout viewport bottom: the
// toolbar-hidden visual overshoot can exceed the layout viewport itself, but the keyboard can
// never lift the layout bottom, so the reference must not. The same clamp also keeps
// content-resizing browsers (Chrome Android, iOS Safari) at a near-zero inset, where the
// resized canvas already ends at the keyboard top.
//
// The fallback for the one state where no unoccluded observation can exist yet (a scaffold
// mounting while the keyboard is already open) is the layout viewport height, which restores
// the previous best-effort behavior rather than leaving the composer under the keyboard.

export type WebVisualViewportKeyboardReference = Readonly<{
    width: number;
    maxUnfocusedVisualBottom: number | null;
    maxLayoutViewportHeight: number | null;
}>;

export type WebVisualViewportKeyboardReading = Readonly<{
    width: number;
    /** `visualViewport.height + visualViewport.offsetTop` — the visible bottom edge. */
    visualBottom: number;
    layoutViewportHeight: number;
    isEditableElementFocused: boolean;
}>;

export type WebVisualViewportKeyboardReferenceBounds = Readonly<{
    /** Current layout viewport (`window.innerHeight`). */
    layoutViewportHeight: number;
    /** Current visual bottom (`visualViewport.height + offsetTop`). */
    currentVisualBottom: number;
}>;

function normalizePositive(value: number): number | null {
    return Number.isFinite(value) && value > 0 ? value : null;
}

export function updateWebVisualViewportKeyboardReference(
    previous: WebVisualViewportKeyboardReference | null,
    reading: WebVisualViewportKeyboardReading,
): WebVisualViewportKeyboardReference {
    const width = normalizePositive(reading.width ?? Number.NaN);
    const visualBottom = normalizePositive(reading.visualBottom ?? Number.NaN);
    const layoutViewportHeight = normalizePositive(reading.layoutViewportHeight ?? Number.NaN);
    if (width === null || visualBottom === null) {
        return previous ?? { width: 0, maxUnfocusedVisualBottom: null, maxLayoutViewportHeight: layoutViewportHeight };
    }

    // A width change (rotation, resize) invalidates any earlier height reference.
    if (previous === null || previous.width !== width) {
        return {
            width,
            maxUnfocusedVisualBottom: reading.isEditableElementFocused ? null : visualBottom,
            maxLayoutViewportHeight: layoutViewportHeight,
        };
    }

    const maxUnfocusedVisualBottom = reading.isEditableElementFocused
        ? previous.maxUnfocusedVisualBottom
        : Math.max(previous.maxUnfocusedVisualBottom ?? 0, visualBottom);
    const maxLayoutViewportHeight = Math.max(
        previous.maxLayoutViewportHeight ?? 0,
        layoutViewportHeight ?? 0,
    ) || null;

    return { width, maxUnfocusedVisualBottom, maxLayoutViewportHeight };
}

/**
 * The reference the keyboard inset is measured against: the observed unoccluded visual bottom
 * (the mount-with-open-keyboard fallback is the layout viewport), clamped to the current
 * layout viewport bottom. The clamp removes the dynamic-toolbar overshoot (the visual viewport
 * with hidden browser chrome can exceed the layout viewport on Firefox Android) while keeping
 * content-resizing browsers flush by construction.
 */
export function resolveWebKeyboardReferenceViewportHeight(
    state: WebVisualViewportKeyboardReference,
    bounds: WebVisualViewportKeyboardReferenceBounds,
): number {
    const reference = state.maxUnfocusedVisualBottom ?? state.maxLayoutViewportHeight ?? 0;
    const layoutViewportHeight = normalizePositive(bounds.layoutViewportHeight);
    const currentVisualBottom = normalizePositive(bounds.currentVisualBottom);
    const layoutBottom = Math.max(layoutViewportHeight ?? 0, currentVisualBottom ?? 0);
    if (layoutBottom <= 0) return reference;
    return Math.min(reference, layoutBottom);
}
