/** Physical window focus, shared by local desktop presence and sync publication. */
export function readHostWindowFocus(): boolean | undefined {
    const doc = (globalThis as unknown as { document?: { hasFocus?: () => boolean } }).document;
    if (typeof doc?.hasFocus !== 'function') return undefined;
    try {
        return doc.hasFocus();
    } catch {
        // The host cannot establish focus: callers preserve their existing unknown-state policy.
        return undefined;
    }
}

/**
 * Whether this document host's window holds the user's attention: a browser tab or a desktop
 * window that has focus. Suppressing a redundant notification depends on this, not on
 * visibility, because a window left on a second monitor still reports `visible`. A host that
 * publishes no `hasFocus` falls back to visibility, the strongest fact it offers.
 */
export function isHostWindowFocused(): boolean {
    const focused = readHostWindowFocus();
    if (focused !== undefined) return focused;
    const doc = (globalThis as unknown as { document?: { visibilityState?: string } }).document;
    return doc?.visibilityState !== 'hidden';
}
