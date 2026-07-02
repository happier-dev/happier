/**
 * Motion policy for the list-level tree drop overlay.
 *
 * The overlay glides smoothly between targets *during* a drag, but must NOT
 * animate into its first target. Its position shared values (`overlayTop` /
 * `overlayLeft`) retain a stale value while hidden — the initial `0`, or the
 * previous drag's last target — so gliding on the first appearance makes the
 * indicator visibly slide in from the top of the list (or across from a far
 * prior position) before it starts tracking the pointer.
 *
 * `TreeDropOverlay` drives its displayed position from a `useAnimatedReaction`
 * that consults this policy each frame: it SNAPS when this returns `true` and
 * GLIDES (`withTiming`) otherwise.
 */
export type TreeDropOverlayMotionState = Readonly<{
    /** Whether the overlay is currently visible. */
    visible: boolean;
    /**
     * Whether the overlay was visible on the previous reaction run. `null` means
     * unknown (mount / first run) and is treated as "was hidden".
     */
    previousVisible: boolean | null;
    /** Accessibility preference: when `true`, position never animates. */
    reducedMotion: boolean;
}>;

/**
 * Returns `true` when the overlay should SNAP to its new position rather than
 * glide to it. Snaps when:
 *  - reduced motion is on (never animate position);
 *  - the overlay is hidden (keep the displayed position synced to the latest
 *    target so the next appearance starts with no offset);
 *  - this is the first appearance of the current drag (previously hidden or
 *    unknown) — so the indicator appears AT its first target.
 * Otherwise (a subsequent move within the same drag) it returns `false`.
 */
export function shouldSnapTreeDropOverlay(state: TreeDropOverlayMotionState): boolean {
    'worklet';
    if (state.reducedMotion) return true;
    if (!state.visible) return true;
    return state.previousVisible !== true;
}
