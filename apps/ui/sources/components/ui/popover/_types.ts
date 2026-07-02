import type * as React from 'react';
import type { View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';

export type ResolvedPopoverPlacement = 'top' | 'bottom' | 'left' | 'right';
export type PopoverPlacement = ResolvedPopoverPlacement | 'auto' | 'auto-vertical' | 'auto-horizontal';
export type PopoverBackdropEffect = 'none' | 'dim' | 'blur';
export type PopoverOutsidePointerEventsMode = 'full' | 'above-anchor';

type WindowRect = Readonly<{ x: number; y: number; width: number; height: number }>;
export type PopoverWindowRect = WindowRect;

export type PopoverAnchor =
    | { readonly kind: 'view'; readonly ref: React.RefObject<View | null> }
    | {
        readonly kind: 'rect';
        readonly rect: Readonly<{
            readonly left: number;
            readonly top: number;
            readonly width?: number;
            readonly height: number;
        }>;
        readonly coordinateSpace?: 'window';
    };

export type PopoverPortalOptions = Readonly<{
    /**
     * Web only: render the popover in a portal using fixed positioning.
     * Useful when the anchor is inside overflow-clipped containers.
     */
    web?: boolean | Readonly<{ target?: 'body' | 'boundary' | 'modal' }>;
    /**
     * Native only: render the popover in a portal host mounted near the app root.
     * This allows popovers to escape overflow clipping from lists/rows/scrollviews.
     */
    native?: boolean;
    /**
     * When true, the popover width is capped to the anchor width for top/bottom placements.
     * Defaults to true to preserve historical behavior.
     */
    matchAnchorWidth?: boolean;
    /**
     * Horizontal alignment relative to the anchor for top/bottom placements.
     * Defaults to 'start' to preserve historical behavior.
     */
    anchorAlign?: 'start' | 'center' | 'end';
    /**
     * Vertical alignment relative to the anchor for left/right placements.
     * Defaults to 'center' for menus/tooltips.
     */
    anchorAlignVertical?: 'start' | 'center' | 'end';
    /**
     * Layout strategy for top/bottom placements in portal mode.
     * - anchored: position and size the popover relative to the anchor
     * - boundary: align the popover to the effective boundary's left edge and width
     */
    topBottomLayout?: 'anchored' | 'boundary';
}>;

export type PopoverBackdropOptions = Readonly<{
    /**
     * Whether to render a full-screen layer behind the popover that intercepts taps.
     * Defaults to true.
     *
     * NOTE: when enabled, `onRequestClose` must be provided (Popover is controlled).
     */
    enabled?: boolean;
    /**
     * When true, blocks interactions outside the popover while it's open.
     *
     * - Web: defaults to `false` (popover behaves like a non-modal menu; outside clicks close it but
     *   still allow the underlying target to receive the event).
     * - Native: defaults to `true` (outside taps are intercepted by a full-screen Pressable).
     */
    blockOutsidePointerEvents?: boolean | 'above-anchor';
    /** Optional visual effect for the backdrop layer. */
    effect?: PopoverBackdropEffect;
    /**
     * Web-only options for `effect="blur"` (CSS `backdrop-filter`).
     * This does not affect native, where `expo-blur` controls intensity/tint.
     */
    blurOnWeb?: Readonly<{ px?: number; tintColor?: string }>;
    /**
     * When enabled (and when `effect` is `dim|blur`), keeps the anchor area visually “uncovered”
     * by the effect so the trigger stays crisp/visible.
     *
     * This is mainly intended for context-menu style popovers.
     */
    spotlight?: boolean | Readonly<{ padding?: number }>;
    /**
     * When provided (and when `effect` is `dim|blur` in portal mode), renders a visual overlay
     * positioned over the anchor *above* the backdrop effect. This avoids “cutout seams”
     * from spotlight-hole techniques and keeps the trigger crisp.
     *
     * Note: this overlay is visual-only and always uses `pointerEvents="none"`.
     */
    anchorOverlay?: React.ReactNode | ((params: Readonly<{ rect: WindowRect }>) => React.ReactNode);
    /** Extra styles applied to the backdrop layer. */
    style?: StyleProp<ViewStyle>;
    /**
     * When enabled, dragging on the backdrop will close the popover.
     * Useful for context-menu style popovers in scrollable screens.
     */
    closeOnPan?: boolean;
}>;

export type PopoverRenderProps = Readonly<{
    maxHeight: number;
    maxWidth: number;
    placement: ResolvedPopoverPlacement;
}>;
