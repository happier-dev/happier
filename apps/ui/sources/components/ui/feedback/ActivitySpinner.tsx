import * as React from 'react';
import {
    ActivityIndicator as NativeActivityIndicator,
    Platform,
    View,
    type ActivityIndicatorProps,
    type ViewStyle,
} from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { useIsHostVisible } from '@/hooks/ui/useIsHostVisible';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import {
    normalizeLoadingIndicatorStyleId,
    normalizeLoadingIndicatorTiming,
    type LoadingIndicatorStyleId,
} from '@/sync/domains/settings/registry/local/loadingIndicatorStyleSetting';
import { useLocalSetting } from '@/sync/store/hooks';
import { t } from '@/text';
import { DotSpinnerNative } from './activitySpinner/DotSpinnerNative';
import { DotSpinnerWeb } from './activitySpinner/DotSpinnerWeb';
import type { DotSpinnerInk } from './activitySpinner/dotSpinnerFrames';
import { DOT_SPINNER_STYLES } from './activitySpinner/dotSpinnerStyles';
import { resolveSpinnerMotion } from './activitySpinner/dotSpinnerMotion';

const DEFAULT_SMALL_SPINNER_SIZE = 20;
const DEFAULT_LARGE_SPINNER_SIZE = 36;
const DEFAULT_NUMERIC_SPINNER_SIZE = 20;

/**
 * The spinner that stands alone on an otherwise empty screen or pane: a session opening cold, the
 * session list before its first load. Inline and status spinners keep `small`.
 *
 * 54 keeps the dot styles on whole pixels: a dot is a sixth of the size (9 px) on a pitch of a third
 * (18 px), so the mark is the small one scaled up, not a softer redraw of it.
 */
export const HERO_SPINNER_SIZE = 54;
const STEPPED_WEB_SPINNER_MAX_SIZE = DEFAULT_SMALL_SPINNER_SIZE;
const STEPPED_WEB_SPINNER_TIMING_FUNCTION = 'steps(6, end)';
const SPINNER_ANIMATION_NAME = 'happierActivitySpinnerSpin';

type WebActivitySpinnerStyle = ViewStyle & {
    animationDuration?: string;
    animationIterationCount?: string;
    animationName?: string;
    animationTimingFunction?: string;
    borderTopColor?: string;
    willChange?: string;
};

export type ActivitySpinnerProps = Omit<ActivityIndicatorProps, 'size'> & {
    size?: ActivityIndicatorProps['size'] | number;
    /**
     * Keep the spinner visible but stop it turning.
     *
     * Used wherever ambient motion must pause without the mark disappearing: a mounted offscreen
     * list row, an entry that has stopped reporting. Honoured on every platform and style — dot
     * styles hold the full chosen mark still (web drops its per-dot animations, native stops its
     * frame clock), and
     * the classic ring stops turning while keeping a still mark on screen. A
     * paused spinner still says "this is the running state"; a missing one says the work ended.
     */
    animationEnabled?: boolean;
    /**
     * Draw this style instead of the one chosen in Settings → Appearance. Only for surfaces that
     * show the styles themselves, such as that picker's previews.
     */
    variant?: LoadingIndicatorStyleId;
};

function resolveSpinnerSize(size: ActivityIndicatorProps['size']): number {
    if (typeof size === 'number' && Number.isFinite(size)) {
        return Math.max(1, size);
    }
    if (size === 'large') {
        return DEFAULT_LARGE_SPINNER_SIZE;
    }
    return DEFAULT_SMALL_SPINNER_SIZE;
}

function resolveSpinnerBorderWidth(size: number): number {
    return Math.max(1.5, Math.min(3, size / 8));
}

/**
 * A vector icon draws its circle INSET in its em box, but a spinner's diameter IS its box. So a
 * spinner and an Ionicons `checkmark-circle` given the same number render at visibly different
 * sizes, and a status slot that swaps one for the other appears to change size as it settles.
 *
 * Measured from a rendered transcript at matched scale: a filled circle glyph declared at 16 draws
 * ~12.8px of ink, next to a `size="small"` spinner's full 20px ring — the running state read 1.55x
 * the size of the success state it turns into.
 *
 * Every status slot that pairs a spinner with a glyph derives the spinner from the glyph size here.
 * Before this existed, four of them each guessed separately and all four disagreed.
 */
export const ICON_CIRCLE_INK_RATIO = 0.8;

export function iconMatchedSpinnerSize(iconSize: number): number {
    return Math.round(iconSize * ICON_CIRCLE_INK_RATIO);
}

/**
 * Every loading spinner in the app. Draws the style chosen in Settings → Appearance: one of the dot
 * styles (the Happier mark or H with light moving through it) or the classic ring, at the speed and pause
 * between loops chosen there.
 */
export function ActivitySpinner(props: ActivitySpinnerProps) {
    // Native hidden spinners retain their layout host; that placeholder must not announce work.
    const normalizedProps = {
        ...props,
        accessibilityLabel: props.accessibilityLabel ?? t('common.loading'),
        ...(Platform.OS !== 'web' && props.animating === false && props.hidesWhenStopped !== false ? {
            accessible: false,
            accessibilityElementsHidden: true,
            importantForAccessibility: 'no-hide-descendants' as const,
        } : null),
    };
    const { theme } = useUnistyles();
    const storedStyle = useLocalSetting('loadingIndicatorStyle');
    const storedSpeed = useLocalSetting('loadingIndicatorSpeed');
    const storedPause = useLocalSetting('loadingIndicatorPause');
    const reduceMotion = useReducedMotionPreference();
    // A window nobody can see (a hidden tab, a backgrounded app) gets a still spinner: every
    // animation loop declares its stop condition (`apps/ui/AGENTS.md`).
    const hostVisible = useIsHostVisible();
    const {
        animating = true,
        animationEnabled = true,
        color,
        hidesWhenStopped,
        size,
        variant,
        ...viewProps
    } = normalizedProps;
    const styleId = variant ?? normalizeLoadingIndicatorStyleId(storedStyle);
    // Previews (`variant`) play at the chosen speed and pause too, so they show the real spinner.
    const { speed, pause } = normalizeLoadingIndicatorTiming(storedSpeed, storedPause);
    const timing = React.useMemo(() => ({ speed, pause }), [pause, speed]);
    const resolvedColor = color ?? theme.colors.text.secondary;
    const inkColor = typeof resolvedColor === 'string' ? resolvedColor : theme.colors.text.secondary;
    const { indigo, purple, orange } = theme.colors.accent;
    // Aurora uses the theme accents, but only when the caller left the color to us: an explicit
    // color usually means a tinted surface (a filled button) where accent colors would not read.
    const useAurora = styleId !== 'classicRing' && DOT_SPINNER_STYLES[styleId].ink === 'aurora' && color == null;
    const ink = React.useMemo<DotSpinnerInk>(
        () => (useAurora ? { aurora: [indigo, purple, orange] } : { color: inkColor }),
        [indigo, inkColor, orange, purple, useAurora],
    );

    if (styleId === 'classicRing') {
        return <ClassicRingSpinner {...normalizedProps} color={resolvedColor} reduceMotion={reduceMotion} hostVisible={hostVisible} />;
    }

    const hidden = !animating && hidesWhenStopped !== false;
    const motion = resolveSpinnerMotion({ paused: !animating || !animationEnabled || !hostVisible, reduceMotion });
    const resolvedSize = resolveSpinnerSize(size ?? DEFAULT_NUMERIC_SPINNER_SIZE);
    const accessibleViewProps = { ...viewProps, accessibilityRole: normalizedProps.accessibilityRole ?? 'progressbar' as const };

    if (Platform.OS !== 'web') {
        return (
            <DotSpinnerNative
                styleId={styleId}
                timing={timing}
                size={resolvedSize}
                ink={ink}
                motion={motion}
                hidden={hidden}
                viewProps={accessibleViewProps}
            />
        );
    }
    if (hidden) return null;
    return <DotSpinnerWeb styleId={styleId} timing={timing} size={resolvedSize} ink={ink} motion={motion} viewProps={accessibleViewProps} />;
}

function ClassicRingSpinner(props: ActivitySpinnerProps & { reduceMotion: boolean; hostVisible: boolean }) {
    // The platform ring stops with its window on its own, so only the web ring reads `hostVisible`.
    const { reduceMotion, hostVisible, variant: _variant, ...spinnerProps } = props;
    const resolvedColor = spinnerProps.color;

    if (Platform.OS !== 'web' && Platform.OS !== 'android') {
        const { animationEnabled: nativeAnimationEnabled = true, ...nativeProps } = spinnerProps;
        const pauseForMotion = nativeProps.animating !== false && (!nativeAnimationEnabled || reduceMotion);
        return (
            <NativeActivityIndicator
                {...nativeProps}
                color={resolvedColor}
                // Explicit stops retain the caller's hiding choice; motion pauses stay visible.
                {...(pauseForMotion ? { animating: false, hidesWhenStopped: false } : null)}
            />
        );
    }

    const {
        animating = true,
        animationEnabled = true,
        hidesWhenStopped = true,
        size,
        style,
        color: _color,
        ...viewProps
    } = spinnerProps;

    if (Platform.OS === 'web' && !animating && hidesWhenStopped) {
        return null;
    }

    const resolvedSize = resolveSpinnerSize(size ?? DEFAULT_NUMERIC_SPINNER_SIZE);
    const spinnerStyle: WebActivitySpinnerStyle = {
        width: resolvedSize,
        height: resolvedSize,
        alignSelf: 'center',
        borderRadius: resolvedSize / 2,
        borderWidth: resolveSpinnerBorderWidth(resolvedSize),
        borderColor: Platform.OS === 'web'
            ? (typeof resolvedColor === 'string' ? resolvedColor : 'currentColor')
            : resolvedColor,
        borderTopColor: 'transparent',
        ...(Platform.OS === 'web' && animating && animationEnabled && !reduceMotion && hostVisible ? {
            animationDuration: '850ms',
            animationIterationCount: 'infinite',
            animationName: SPINNER_ANIMATION_NAME,
            animationTimingFunction: resolvedSize <= STEPPED_WEB_SPINNER_MAX_SIZE
                ? STEPPED_WEB_SPINNER_TIMING_FUNCTION
                : 'linear',
            willChange: 'transform',
        } : null),
        opacity: 1,
    };

    if (Platform.OS === 'android') {
        const nativeAnimating = animating && animationEnabled && !reduceMotion;
        const showStillRing = !nativeAnimating && (animating || !hidesWhenStopped);
        // Android hides its stopped widget regardless of hidesWhenStopped. Keep both layers
        // mounted so motion pauses preserve the native instance and its intrinsic layout box.
        return (
            <View
                {...viewProps}
                accessibilityRole={spinnerProps.accessibilityRole ?? 'progressbar'}
                style={[{ alignItems: 'center', justifyContent: 'center' }, style]}
            >
                <NativeActivityIndicator
                    animating={nativeAnimating}
                    color={resolvedColor}
                    size={size}
                    accessible={false}
                    importantForAccessibility="no-hide-descendants"
                />
                <View
                    pointerEvents="none"
                    accessible={false}
                    importantForAccessibility="no-hide-descendants"
                    style={[spinnerStyle, { position: 'absolute', opacity: showStillRing ? 1 : 0 }]}
                />
            </View>
        );
    }

    return (
        <View
            {...viewProps}
            accessibilityRole={spinnerProps.accessibilityRole ?? 'progressbar'}
            style={[spinnerStyle, style]}
        />
    );
}
