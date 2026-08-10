import * as React from 'react';
import type { ViewStyle } from 'react-native';
import Animated, { useAnimatedStyle, withTiming } from 'react-native-reanimated';
import { StyleSheet } from 'react-native-unistyles';

import { resolveMotionPresentation } from '@/components/ui/motion/reducedMotionTable';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';

/**
 * The keyboard focus indicator.
 *
 * It paints `theme.colors.focus.ring`, a DEDICATED token rather than an alias of `state.active`:
 * the ring's whole promise is that it clears 3:1 against every surface either theme can put behind
 * it, and an accent hue re-tuned for brand reasons cannot carry that promise.
 * `focusRingContrast.test.ts` holds the table.
 *
 * Visibility is the host's decision, and the host must gate it on keyboard modality
 * (`inputModalityStore`) — React Native has no `:focus-visible`, and a ring that appears on every
 * tap is worse than none.
 *
 * It appears in 0 ms because a focus indicator that animates in is a focus indicator that is late,
 * and leaves over 90 ms so that traversing a list does not strobe.
 */
export const FOCUS_RING_WIDTH_PX = 2;
export const FOCUS_RING_OFFSET_PX = 2;
const FOCUS_RING_EXIT_MS = 90;

/**
 * Suppresses the browser's own focus ring on a host that mounts a {@link FocusRing}, so keyboard
 * focus shows exactly one indicator — ours, which is theme-driven, contrast-verified and gated on
 * keyboard modality, where the browser's also fires for click-focus.
 *
 * `outline-style: none` rather than a zero width or a transparent colour: Chromium draws the
 * default ring with `outline-style: auto`, whose geometry the UA owns, so `outline-width` is not
 * reliably honoured. React Native types `outlineStyle` for its NATIVE renderer, where an outline is
 * a drawn border and `none` does not exist — hence the one suppression below. If a future React
 * Native widens the union, the directive turns into an unused-directive error and this goes away.
 */
export const WEB_FOCUS_OUTLINE_RESET: ViewStyle = {
    // @ts-expect-error — web-only CSS value absent from React Native's native-renderer typing.
    outlineStyle: 'none',
};

export type FocusRingCornerRadii = Readonly<Pick<
    ViewStyle,
    'borderTopLeftRadius' | 'borderTopRightRadius' | 'borderBottomLeftRadius' | 'borderBottomRightRadius'
>>;

/**
 * `outside` is the default and the honest one for a bounded control: the ring sits clear of the
 * chrome so it does not eat into the glyph. `inside` exists for a control whose parent clips —
 * a grouped list row inside an `overflow: hidden` group would lose an outside ring entirely.
 */
export type FocusRingPlacement = 'inside' | 'outside';

export type FocusRingProps = Readonly<{
    visible: boolean;
    /** Uniform corner radius of the control the ring traces. */
    radius?: number;
    /** Per-corner radii, for a control whose corners differ — a first/last grouped row. Wins over `radius`. */
    cornerRadii?: FocusRingCornerRadii;
    placement?: FocusRingPlacement;
    testID?: string;
}>;

export function resolveFocusRingTimingMs(params: Readonly<{ visible: boolean; reducedMotion: boolean }>): number {
    // Through the shared table rather than a local `if (reducedMotion)`, so the ring's fallback is
    // stated in the same place as every other animation's and cannot quietly diverge from them.
    // `settleInstantly` keeps both directions visible and removes only the travel.
    if (resolveMotionPresentation('focusRing', params.reducedMotion) === 'settleInstantly') return 0;
    return params.visible ? 0 : FOCUS_RING_EXIT_MS;
}

const stylesheet = StyleSheet.create((theme) => ({
    ring: {
        position: 'absolute',
        borderWidth: FOCUS_RING_WIDTH_PX,
        borderColor: theme.colors.focus.ring,
    },
}));

function resolveGeometry(placement: FocusRingPlacement, radius: number | undefined, cornerRadii: FocusRingCornerRadii | undefined): ViewStyle {
    const spread = placement === 'inside' ? 0 : FOCUS_RING_OFFSET_PX + FOCUS_RING_WIDTH_PX;
    const edge = placement === 'inside' ? 0 : -(FOCUS_RING_OFFSET_PX + FOCUS_RING_WIDTH_PX);

    const corners: ViewStyle = cornerRadii
        ? Object.fromEntries(
            Object.entries(cornerRadii)
                .filter(([, value]) => typeof value === 'number')
                .map(([key, value]) => [key, (value as number) + spread]),
        )
        : {
            borderTopLeftRadius: (radius ?? 0) + spread,
            borderTopRightRadius: (radius ?? 0) + spread,
            borderBottomLeftRadius: (radius ?? 0) + spread,
            borderBottomRightRadius: (radius ?? 0) + spread,
        };

    return { top: edge, right: edge, bottom: edge, left: edge, ...corners };
}

export const FocusRing = React.memo((props: FocusRingProps) => {
    const styles = stylesheet;
    const reducedMotion = useReducedMotionPreference();
    const visible = props.visible;

    // Mount on the SAME commit as focus, so the 0 ms entry is real rather than one frame late, and
    // stay mounted afterwards so the exit fade has something to fade. A control that is never
    // focused renders nothing at all, which is what keeps this free in a long list.
    const hasBeenVisibleRef = React.useRef(visible);
    if (visible) hasBeenVisibleRef.current = true;

    // Resolved on the JS thread, deliberately. `useAnimatedStyle`'s callback is a worklet running on
    // the UI thread, and calling a plain function from there throws
    // `[Worklets] Tried to synchronously call a non-worklet function`. Hoisting it lets the worklet
    // close over a plain number instead, which also does strictly less work on the UI thread than
    // marking the function `'worklet'` would — and keeps `resolveFocusRingTimingMs` an ordinary
    // exported function for its other callers and tests.
    const timingMs = resolveFocusRingTimingMs({ visible, reducedMotion });

    const animatedStyle = useAnimatedStyle(() => ({
        opacity: withTiming(visible ? 1 : 0, { duration: timingMs }),
    }), [visible, timingMs]);

    const geometry = React.useMemo(
        () => resolveGeometry(props.placement ?? 'outside', props.radius, props.cornerRadii),
        [props.placement, props.radius, props.cornerRadii],
    );

    if (!hasBeenVisibleRef.current) return null;

    return (
        <Animated.View
            testID={props.testID}
            pointerEvents="none"
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={[styles.ring, geometry, animatedStyle]}
        />
    );
});

FocusRing.displayName = 'FocusRing';
