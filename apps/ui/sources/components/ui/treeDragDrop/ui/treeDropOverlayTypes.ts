/**
 * Generic tree drop overlay contracts.
 *
 * Phase 0.5 interface freeze (`session-list-drag-geometry-performance-unification.md`,
 * section 3.4). Pure type file: no behaviour lives here.
 *
 * The list-level drop overlay (`TreeDropOverlay`, Lane A; `SessionListDropOverlay`,
 * Lane C) renders ONE viewport-positioned indicator driven by numeric shared
 * values. The moving line position never requires a list-wide React rerender:
 * geometry flows through Reanimated shared values, and React state only changes
 * on drag start/end or a non-frame semantic transition.
 */

/**
 * A single numeric Reanimated shared value.
 *
 * Structurally compatible with `SharedValue<T>` from `react-native-reanimated`
 * and with the lightweight `{ value }` test doubles used in the UI testkit.
 */
export type TreeDropOverlaySharedValue<T> = {
    value: T;
};

/** Discrete overlay visual kind, encoded numerically for worklet-friendliness. */
export const TREE_DROP_OVERLAY_KIND_NONE = 0;
export const TREE_DROP_OVERLAY_KIND_LINE = 1;
export const TREE_DROP_OVERLAY_KIND_OUTLINE = 2;

export type TreeDropOverlayKind =
    | typeof TREE_DROP_OVERLAY_KIND_NONE
    | typeof TREE_DROP_OVERLAY_KIND_LINE
    | typeof TREE_DROP_OVERLAY_KIND_OUTLINE;

/**
 * Numeric overlay geometry shared-values shape.
 *
 * This replaces the old semantic `SessionInlineDragVisualSharedValues`
 * (`visualKind`/`visualTargetId`/`visualEdge`/`visualDepth`), which could not
 * express a list-level overlay because the overlay needs actual top/height.
 *
 * All fields are numeric so they can be written from a worklet and consumed by
 * `useAnimatedStyle` without crossing the JS bridge:
 * - `overlayVisible` 0 = hidden, 1 = visible.
 * - `overlayKind`    `TreeDropOverlayKind` (line vs outline vs none).
 * - `overlayTop`     top edge in viewport-overlay coordinates.
 * - `overlayHeight`  rectangle height.
 * - `overlayLeft`    left edge in viewport-overlay coordinates.
 * - `overlayRight`   right inset in viewport-overlay coordinates.
 * - `overlayDepth`   resolved tree depth; drives the indicator indent.
 */
export type TreeDropOverlaySharedValues = Readonly<{
    overlayVisible: TreeDropOverlaySharedValue<number>;
    overlayKind: TreeDropOverlaySharedValue<TreeDropOverlayKind>;
    overlayTop: TreeDropOverlaySharedValue<number>;
    overlayHeight: TreeDropOverlaySharedValue<number>;
    overlayLeft: TreeDropOverlaySharedValue<number>;
    overlayRight: TreeDropOverlaySharedValue<number>;
    overlayDepth: TreeDropOverlaySharedValue<number>;
}>;

/**
 * Motion contract for overlay glides between targets.
 *
 * The overlay glides smoothly between targets for normal motion and snaps
 * immediately under reduced motion. Lane A/C derive concrete `withTiming`/
 * `withSpring` configs from `motionTokens`; this type pins the contract so all
 * overlay motion is reduced-motion aware.
 */
export type TreeDropOverlayMotionContract = Readonly<{
    /** When `true`, position changes snap immediately (no animation). */
    reducedMotion: boolean;
    /** Glide duration in ms for normal motion (from `motionTokens.durationMs`). */
    glideDurationMs: number;
}>;
