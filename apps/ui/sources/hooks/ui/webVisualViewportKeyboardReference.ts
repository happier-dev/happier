// Reference height for the mobile-web software-keyboard inset.
//
// `window.innerHeight` is NOT a trustworthy unoccluded-viewport reference on every mobile
// browser: on Firefox Android it reports a layout viewport taller than the visual viewport can
// ever reach even with no keyboard open (reproduced on-device: a ~90 CSS px phantom band), so
// `innerHeight - visualViewport.height - offsetTop` counts browser chrome as keyboard and the
// composer floats above the keyboard top.
//
// The visual viewport is authoritative for what is actually visible. The unoccluded reference
// is therefore the largest visual bottom (`height + offsetTop`) observed while NO editable was
// focused — a state in which the software keyboard cannot be covering the window — at the
// current viewport width. The fallback for the one state where no unoccluded observation can
// exist yet (a scaffold mounting while the keyboard is already open) is the layout viewport
// height, which restores the previous best-effort behavior rather than leaving the composer
// under the keyboard.

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
 * The reference the keyboard inset is measured against. The unoccluded visual bottom is the
 * canonical reference; the layout viewport is only the mount-with-open-keyboard fallback.
 */
export function resolveWebKeyboardReferenceViewportHeight(state: WebVisualViewportKeyboardReference): number {
    return state.maxUnfocusedVisualBottom ?? state.maxLayoutViewportHeight ?? 0;
}
