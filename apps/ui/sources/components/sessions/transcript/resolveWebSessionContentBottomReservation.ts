// On web, the browser owns the visual viewport's safe-area and keyboard geometry. The session
// composer's keyboard scaffold already lifts the composer via the **shared** floating-chrome
// band (`layoutBottomInset`), so adding the raw browser **safe-area inset** on top re-creates
// the oversized gap reported on mobile web, and the doubled offset corrupts keyboard-open
// geometry (the composer is squeezed off-screen, disabling the send/expand controls until the
// keyboard closes). The web scaffold must therefore zero out **only** the browser safe area —
// the keyboard inset remains the canonical lifter (see
// `useComposerKeyboardLayout.web.ts#resolveWebVisualViewportKeyboardInset`).

function normalizeNonNegativeNumber(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, value);
}

/**
 * Safe-area bottom the web scaffold may use for its own geometry.
 *
 * On web, the browser already positions the composer above the visual viewport's safe area, so
 * the scaffold must not include it in its bottom offset. Returns 0 unconditionally on web; kept
 * as a named resolver so the input contract (`layoutBottomInset`, `safeAreaBottom`) cannot
 * silently re-couple a consumer to the raw inset value later.
 */
export function resolveWebScaffoldSafeAreaBottom(params: Readonly<{
    layoutBottomInset: number;
    safeAreaBottom: number;
}>): number {
    const layoutBottomInset = normalizeNonNegativeNumber(params.layoutBottomInset);
    const safeAreaBottom = normalizeNonNegativeNumber(params.safeAreaBottom);

    // The scaffold already reserves the floating bottom chrome via `layoutBottomInset`; adding
    // the safe area on top would double-reserve the same visual band.
    if (layoutBottomInset > 0) return 0;

    // With no floating chrome, the browser's visual viewport already places the composer above
    // the safe area; the scaffold must not push it up again (the persistent oversized gap).
    if (safeAreaBottom > 0) return 0;

    return 0;
}
