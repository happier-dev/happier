import * as React from 'react';
import {
    Platform,
    View,
    type AccessibilityActionEvent,
    type GestureResponderEvent,
    type LayoutChangeEvent,
} from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { useItemRowAccessibleName } from '@/components/ui/lists/ItemRowAccessibleName';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { shadowLevelStyle } from '@/shadowElevation';
import { HAPPIER_FOCUS_RING_DELEGATED_STYLE, HAPPIER_SLIDER_METRICS, isHappierFocusVisible, useHappierHitArea } from '@happier-dev/plugin-ui/presentation';

export type SliderProps = Readonly<{
    value: number;
    min: number;
    max: number;
    /** Values snap to `min + n * step`. Discrete settings use their option index with a step of 1. */
    step: number;
    onValueChange: (next: number) => void;
    /** Transient drag value; undefined withdraws the preview on release, cancellation or unmount. */
    onValuePreview?: (next: number | undefined) => void;
    /** Defaults to the enclosing `Item` row's title. */
    accessibilityLabel?: string;
    /** What assistive technology announces for a value ("Large", "120%"). */
    formatValueText?: (value: number) => string;
    /** Marks at either end of the track (a small and a large "A"). Decorative. */
    leading?: React.ReactNode;
    trailing?: React.ReactNode;
    /** A fixed track width for a row's right slot. Omit to fill the available width. */
    trackWidth?: number;
    disabled?: boolean;
    /** The slider's test id; the track is `${testID}-track`. */
    testID?: string;
}>;

// The slider's geometry is plugin-ui's, shared with the hosted HTML kit's slider.
const { trackHeightPx, thumbSizePx, thumbRingWidthPx, trackHitHeightPx, disabledOpacity } = HAPPIER_SLIDER_METRICS;
const TRACK_FRAME_STYLE = { height: trackHitHeightPx } as const;
/** The track scrubs along its own width; the hit area extends above and below only. */
const TRACK_HIT_REACH = { left: 0, right: 0 } as const;
/** Page Up/Down move a tenth of the range, at least one step. */
const PAGE_FRACTION = 0.1;

function stepDecimals(step: number): number {
    const text = String(step);
    const dot = text.indexOf('.');
    return dot === -1 ? 0 : text.length - dot - 1;
}

function snapToStep(raw: number, min: number, max: number, step: number): number {
    const clamped = Math.min(max, Math.max(min, raw));
    const snapped = min + Math.round((clamped - min) / step) * step;
    return Number(Math.min(max, Math.max(min, snapped)).toFixed(stepDecimals(step)));
}

function readFinite(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * A horizontal slider over a stepped numeric range: the canonical control for a setting whose values
 * lie on a scale (text size, a companion's size). It is an adjustable control for assistive technology
 * (increment/decrement actions and a spoken value), takes arrow/Home/End/Page keys on the web, and
 * follows a press or drag anywhere on the track. Put it in an `Item`'s right slot; the row's title
 * names it.
 */
export function Slider(props: SliderProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const reducedMotion = useReducedMotionPreference();
    const rowAccessibleName = useItemRowAccessibleName();
    const { min, max, step, disabled } = props;
    const trackHitArea = useHappierHitArea({ restingStyle: () => TRACK_FRAME_STYLE, hitReach: TRACK_HIT_REACH });
    const [draft, setDraft] = React.useState<number | null>(null);
    const value = snapToStep(draft ?? props.value, min, max, step);
    const progress = max > min ? (value - min) / (max - min) : 0;
    const [focused, setFocused] = React.useState(false);
    const [dragging, setDragging] = React.useState(false);
    const trackWidthRef = React.useRef(0);
    const trackPageXRef = React.useRef<number | null>(null);
    const valueRef = React.useRef(value);
    valueRef.current = value;
    const onValueChangeRef = React.useRef(props.onValueChange);
    onValueChangeRef.current = props.onValueChange;
    const onValuePreviewRef = React.useRef(props.onValuePreview);
    onValuePreviewRef.current = props.onValuePreview;
    const gesture = React.useRef<{ start: number; value: number } | null>(null);

    const commit = React.useCallback((raw: number) => {
        const next = snapToStep(raw, min, max, step);
        if (next === valueRef.current) return;
        onValueChangeRef.current(next);
    }, [max, min, step]);

    const previewAtX = React.useCallback((x: number) => {
        const width = trackWidthRef.current;
        if (width <= 0 || !gesture.current) return;
        const next = snapToStep(min + Math.min(1, Math.max(0, x / width)) * (max - min), min, max, step);
        if (gesture.current.value === next) return;
        gesture.current.value = next;
        valueRef.current = next;
        setDraft(next);
        onValuePreviewRef.current?.(next);
    }, [max, min, step]);

    const handleGrant = React.useCallback((event: GestureResponderEvent) => {
        if (disabled) return;
        const locationX = readFinite(event.nativeEvent.locationX);
        const pageX = readFinite(event.nativeEvent.pageX);
        // Remember where the track starts on the page: later moves are measured from it, because a
        // pointer that leaves the track reports its position relative to whatever it is over.
        trackPageXRef.current = locationX !== null && pageX !== null ? pageX - locationX : null;
        gesture.current = { start: valueRef.current, value: valueRef.current };
        setDragging(true);
        if (locationX !== null) previewAtX(locationX);
    }, [previewAtX, disabled]);

    const handleMove = React.useCallback((event: GestureResponderEvent) => {
        if (disabled) return;
        const pageX = readFinite(event.nativeEvent.pageX);
        const x = pageX !== null && trackPageXRef.current !== null
            ? pageX - trackPageXRef.current
            : readFinite(event.nativeEvent.locationX);
        if (x !== null) previewAtX(x);
    }, [previewAtX, disabled]);

    const handleRelease = React.useCallback(() => {
        const current = gesture.current;
        gesture.current = null;
        trackPageXRef.current = null;
        setDragging(false);
        setDraft(null);
        if (current && current.value !== current.start) onValueChangeRef.current(current.value);
        onValuePreviewRef.current?.(undefined);
    }, []);

    const cancelGesture = React.useCallback(() => {
        if (!gesture.current) return;
        gesture.current = null;
        trackPageXRef.current = null;
        setDragging(false);
        setDraft(null);
        onValuePreviewRef.current?.(undefined);
    }, []);
    React.useEffect(() => { if (disabled) cancelGesture(); }, [disabled, cancelGesture]);
    React.useEffect(() => () => {
        if (gesture.current) onValuePreviewRef.current?.(undefined);
    }, []);

    const hitAreaOnLayout = trackHitArea.onLayout;
    const handleTrackLayout = React.useCallback((event: LayoutChangeEvent) => {
        trackWidthRef.current = event.nativeEvent.layout.width;
        hitAreaOnLayout?.(event);
    }, [hitAreaOnLayout]);

    const pageStep = Math.max(step, Math.round(((max - min) * PAGE_FRACTION) / step) * step);
    const handleKeyDown = React.useCallback((event: { key?: string; nativeEvent?: { key?: string }; preventDefault?: () => void }) => {
        if (disabled) return;
        const key = event?.nativeEvent?.key ?? event?.key;
        const current = valueRef.current;
        const next = key === 'ArrowRight' || key === 'ArrowUp' ? current + step
            : key === 'ArrowLeft' || key === 'ArrowDown' ? current - step
            : key === 'PageUp' ? current + pageStep
            : key === 'PageDown' ? current - pageStep
            : key === 'Home' ? min
            : key === 'End' ? max
            : null;
        if (next === null) return;
        event?.preventDefault?.();
        commit(next);
    }, [commit, disabled, max, min, pageStep, step]);

    const handleAccessibilityAction = React.useCallback((event: AccessibilityActionEvent) => {
        if (disabled) return;
        if (event.nativeEvent.actionName === 'increment') commit(valueRef.current + step);
        if (event.nativeEvent.actionName === 'decrement') commit(valueRef.current - step);
    }, [commit, disabled, step]);

    const accessibleName = props.accessibilityLabel ?? rowAccessibleName;
    const valueText = props.formatValueText?.(value);
    const percent = `${Math.round(progress * 1000) / 10}%` as const;
    const motion = reducedMotion || dragging ? null : TRANSITION_STYLE;
    const webKeyboardProps = Platform.OS === 'web'
        ? {
            onKeyDown: handleKeyDown,
            // React Native Web projects the individual ARIA value props, not native accessibilityValue.
            'aria-valuemin': min,
            'aria-valuemax': max,
            'aria-valuenow': value,
            'aria-valuetext': valueText,
        }
        : {};

    return (
        <View
            testID={props.testID}
            focusable={Platform.OS === 'web' && !disabled}
            accessible
            accessibilityRole="adjustable"
            accessibilityLabel={accessibleName}
            accessibilityState={{ disabled: disabled === true }}
            accessibilityValue={{
                min,
                max,
                now: value,
                text: valueText,
            }}
            accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
            onAccessibilityAction={handleAccessibilityAction}
            onFocus={(event) => setFocused(isHappierFocusVisible(event?.target))}
            onBlur={() => setFocused(false)}
            {...webKeyboardProps}
            style={[styles.root, props.trackWidth === undefined ? styles.rootFill : null, disabled ? styles.disabled : null]}
        >
            {props.leading ? <View style={styles.adornment} importantForAccessibility="no-hide-descendants">{props.leading}</View> : null}
            <View
                testID={props.testID ? `${props.testID}-track` : undefined}
                onLayout={handleTrackLayout}
                hitSlop={trackHitArea.hitSlop}
                onStartShouldSetResponder={() => !disabled}
                onMoveShouldSetResponder={() => !disabled}
                onResponderTerminationRequest={() => false}
                onResponderGrant={handleGrant}
                onResponderMove={handleMove}
                onResponderRelease={handleRelease}
                onResponderTerminate={cancelGesture}
                style={[
                    styles.trackHitArea,
                    TRACK_FRAME_STYLE,
                    props.trackWidth === undefined ? styles.trackHitAreaFill : { width: props.trackWidth },
                ]}
            >
                {trackHitArea.frame}
                <View pointerEvents="none" style={[styles.track, { backgroundColor: theme.colors.switch.track.inactive }]}>
                    <View style={[styles.fill, { width: percent, backgroundColor: theme.colors.text.primary }, motion]} />
                </View>
                <View
                    pointerEvents="none"
                    style={[
                        styles.thumb,
                        {
                            top: (trackHitHeightPx - thumbSizePx) / 2,
                            left: percent,
                            backgroundColor: theme.colors.text.primary,
                            borderColor: theme.colors.surface.base,
                        },
                        focusRingStyle({ focused, color: theme.colors.border.focus }),
                        motion ? THUMB_TRANSITION_STYLE : null,
                    ]}
                />
            </View>
            {props.trailing ? <View style={styles.adornment} importantForAccessibility="no-hide-descendants">{props.trailing}</View> : null}
        </View>
    );
}

// A keyboard or tap step glides; a drag follows the pointer directly.
const TRANSITION_STYLE = Platform.OS === 'web'
    ? ({
        transitionProperty: 'width',
        transitionDuration: `${motionTokens.durationMs.fast}ms`,
        transitionTimingFunction: motionTokens.easingCss.standard,
    } as object)
    : null;
const THUMB_TRANSITION_STYLE = Platform.OS === 'web'
    ? ({
        transitionProperty: 'left',
        transitionDuration: `${motionTokens.durationMs.fast}ms`,
        transitionTimingFunction: motionTokens.easingCss.standard,
    } as object)
    : null;

const stylesheet = StyleSheet.create((theme) => ({
    root: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s10,
        borderRadius: 8,
        // The thumb draws the ring.
        ...HAPPIER_FOCUS_RING_DELEGATED_STYLE,
    },
    rootFill: {
        alignSelf: 'stretch',
        flexGrow: 1,
    },
    disabled: {
        opacity: disabledOpacity,
    },
    adornment: {
        alignItems: 'center',
        justifyContent: 'center',
    },
    trackHitArea: {
        justifyContent: 'center',
        // The thumb overhangs both ends by half its width at the extremes.
        marginHorizontal: thumbSizePx / 2,
        ...(Platform.OS === 'web' ? ({ cursor: 'pointer', touchAction: 'none', userSelect: 'none' } as object) : null),
    },
    trackHitAreaFill: {
        flexGrow: 1,
        flexShrink: 1,
        minWidth: 80,
    },
    track: {
        height: trackHeightPx,
        borderRadius: trackHeightPx / 2,
        overflow: 'hidden',
    },
    fill: {
        height: trackHeightPx,
    },
    thumb: {
        position: 'absolute',
        width: thumbSizePx,
        height: thumbSizePx,
        marginLeft: -thumbSizePx / 2,
        borderRadius: thumbSizePx / 2,
        borderWidth: thumbRingWidthPx,
        ...shadowLevelStyle(theme.colors.shadowLevels[1]),
    },
}));
