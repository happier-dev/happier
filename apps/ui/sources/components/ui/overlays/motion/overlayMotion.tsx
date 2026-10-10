import * as React from 'react';
import { Animated, Platform, type StyleProp, type ViewStyle } from 'react-native';

import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { resolveOverlayPointerEvents } from '../resolveOverlayPointerEvents';

/** `panel`: a surface sliding in from the edge it stands on, over what is there (the rail's column peek). */
export type OverlayMotionKind = 'popover' | 'modal' | 'panel';
export type OverlayMotionDirection = 'top' | 'bottom' | 'left' | 'right' | 'center';

export type OverlayMotionPreset = Readonly<{
    enterMs: number;
    exitMs: number;
    fromOpacity: number;
    fromScale: number;
    fromTranslateX: number;
    fromTranslateY: number;
    /** Under reduced motion: `0` changes at once; otherwise the overlay only fades, over this long. */
    reducedMotionFadeMs: number;
}>;

export function resolveOverlayMotionDirectionFromPlacement(placement: string): OverlayMotionDirection {
    switch (placement) {
        case 'top':
        case 'bottom':
        case 'left':
        case 'right':
            return placement;
        default:
            return 'center';
    }
}

export function resolveOverlayMotionPreset(params: Readonly<{
    kind: OverlayMotionKind;
    /** Where the overlay stands relative to its source; it arrives from the source's side. */
    direction?: OverlayMotionDirection;
    /** `panel` only: how far it travels in, usually its own size along `direction`. */
    travelPx?: number;
}>): OverlayMotionPreset {
    const direction = params.direction ?? 'center';

    if (params.kind === 'panel') {
        const travel = params.travelPx ?? 0;
        return {
            enterMs: motionTokens.overlay.panel.enterMs,
            exitMs: motionTokens.overlay.panel.exitMs,
            fromOpacity: 1,
            fromScale: 1,
            fromTranslateX: direction === 'left' ? travel : direction === 'right' ? -travel : 0,
            fromTranslateY: direction === 'top' ? travel : direction === 'bottom' ? -travel : 0,
            reducedMotionFadeMs: motionTokens.overlay.panel.reducedMotionFadeMs,
        };
    }

    if (params.kind === 'modal') {
        return {
            enterMs: motionTokens.overlay.modal.enterMs,
            exitMs: motionTokens.overlay.modal.exitMs,
            fromOpacity: 0,
            fromScale: motionTokens.overlay.modal.fromScale,
            fromTranslateX: 0,
            fromTranslateY: motionTokens.overlay.modal.fromTranslateY,
            reducedMotionFadeMs: motionTokens.durationMs.fast,
        };
    }

    const fromDistance = motionTokens.overlay.popover.fromDistance;

    return {
        enterMs: motionTokens.overlay.popover.enterMs,
        exitMs: motionTokens.overlay.popover.exitMs,
        fromOpacity: 0,
        fromScale: motionTokens.overlay.popover.fromScale,
        fromTranslateX:
            direction === 'left'
                ? fromDistance
                : direction === 'right'
                    ? -fromDistance
                    : 0,
        fromTranslateY:
            direction === 'top'
                ? fromDistance
                : direction === 'bottom'
                    ? -fromDistance
                    : 0,
        reducedMotionFadeMs: motionTokens.durationMs.fast,
    };
}

export function useOverlayPresence(visible: boolean, exitMs: number): Readonly<{
    present: boolean;
    exiting: boolean;
}> {
    const [presentState, setPresentState] = React.useState(visible);
    const timeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

    React.useEffect(() => {
        return () => {
            if (timeoutRef.current) {
                clearTimeout(timeoutRef.current);
                timeoutRef.current = null;
            }
        };
    }, []);

    React.useEffect(() => {
        if (timeoutRef.current) {
            clearTimeout(timeoutRef.current);
            timeoutRef.current = null;
        }

        if (visible) {
            setPresentState(true);
            return;
        }

        if (!presentState) return;

        if (exitMs <= 0) {
            setPresentState(false);
            return;
        }

        timeoutRef.current = setTimeout(() => {
            timeoutRef.current = null;
            setPresentState(false);
        }, exitMs);
    }, [exitMs, presentState, visible]);

    const present = visible || presentState;
    return {
        present,
        exiting: present && !visible,
    };
}

export function useOverlayMotionAnimation(params: Readonly<{
    visible: boolean;
    preset: OverlayMotionPreset;
    /** Web frames animate their unblurred content, leaving material paint and its ancestors still. */
    elementRef?: React.RefObject<unknown>;
}>): Readonly<{
    exitMs: number;
    progress: Animated.Value;
    style: StyleProp<ViewStyle>;
}> {
    const reducedMotion = useReducedMotionPreference();
    const progress = React.useRef(new Animated.Value(0)).current;
    const reducedMs = params.preset.reducedMotionFadeMs;
    const webElementMotion = Platform.OS === 'web' && params.elementRef !== undefined;
    useWebOverlayContentMotion(params, reducedMotion);

    // Each change animates from where the overlay is now, so a reversal mid-way turns around in place.
    React.useLayoutEffect(() => {
        if (webElementMotion) return;
        Animated.timing(progress, {
            toValue: params.visible ? 1 : 0,
            duration: reducedMotion
                ? reducedMs
                : (params.visible ? params.preset.enterMs : params.preset.exitMs),
            easing: motionTokens.easing.standard,
            useNativeDriver: Platform.OS !== 'web',
        }).start();
    }, [params.preset.enterMs, params.preset.exitMs, params.visible, progress, reducedMotion, reducedMs, webElementMotion]);

    const opacity = progress.interpolate({
        inputRange: [0, 1],
        outputRange: [params.preset.fromOpacity, 1],
    });
    const scale = progress.interpolate({
        inputRange: [0, 1],
        outputRange: [params.preset.fromScale, 1],
    });
    const translateX = progress.interpolate({
        inputRange: [0, 1],
        outputRange: [params.preset.fromTranslateX, 0],
    });
    const translateY = progress.interpolate({
        inputRange: [0, 1],
        outputRange: [params.preset.fromTranslateY, 0],
    });

    const fadeOnly = reducedMotion && reducedMs > 0;
    return {
        exitMs: reducedMotion ? reducedMs : params.preset.exitMs,
        progress,
        style: webElementMotion
            ? {}
            : fadeOnly
            ? { opacity: progress }
            : {
                opacity,
                transform: [{ translateX }, { translateY }, { scale }],
            },
    };
}

const GLASS_BACKDROP_SELECTOR = '[data-happy-glass-backdrop]';

/** Keep the existing layout: descend only through material branches and move their content siblings. */
function webOverlayContentTargets(element: HTMLElement): HTMLElement[] {
    if (element.matches(GLASS_BACKDROP_SELECTOR)) return [];
    if (!element.querySelector(GLASS_BACKDROP_SELECTOR)) return [element];
    return Array.from(element.children).flatMap(child => child instanceof HTMLElement ? webOverlayContentTargets(child) : []);
}

type WebContentMotionTarget = {
    animation: Animation | null;
    opacity: string;
    transform: string;
    shownOpacity: string;
    shownTransform: string;
};

function useWebOverlayContentMotion(params: Readonly<{
    visible: boolean;
    preset: OverlayMotionPreset;
    elementRef?: React.RefObject<unknown>;
}>, reducedMotion: boolean): void {
    const targetsRef = React.useRef(new Map<HTMLElement, WebContentMotionTarget>());
    const presetRef = React.useRef(params.preset);
    presetRef.current = params.preset;
    React.useLayoutEffect(() => {
        if (Platform.OS !== 'web') return;
        const element = params.elementRef?.current;
        if (!element || typeof HTMLElement === 'undefined' || !(element instanceof HTMLElement)) return;
        const preset = presetRef.current;
        const fadeOnly = reducedMotion;
        const duration = reducedMotion ? preset.reducedMotionFadeMs : params.visible ? preset.enterMs : preset.exitMs;
        for (const target of webOverlayContentTargets(element)) {
            let state = targetsRef.current.get(target);
            if (!state) {
                const authored = getComputedStyle(target);
                state = {
                    animation: null, opacity: target.style.opacity, transform: target.style.transform,
                    shownOpacity: authored.opacity || '1', shownTransform: authored.transform || 'none',
                };
                targetsRef.current.set(target, state);
            }
            const shown = { opacity: state.shownOpacity, transform: state.shownTransform };
            const hidden = {
                opacity: fadeOnly ? '0' : String(preset.fromOpacity * Number(shown.opacity)),
                transform: fadeOnly ? shown.transform
                    : `translate(${preset.fromTranslateX}px, ${preset.fromTranslateY}px) scale(${preset.fromScale})${shown.transform !== 'none' ? ` ${shown.transform}` : ''}`,
            };
            // Read the current composited frame before cancelling or changing the resting styles.
            const computed = state.animation?.playState === 'running' ? getComputedStyle(target) : null;
            const from = computed ? { opacity: computed.opacity, transform: fadeOnly ? shown.transform : computed.transform } : params.visible ? hidden : shown;
            state.animation?.cancel();
            state.animation = null;
            target.style.opacity = params.visible ? state.opacity : hidden.opacity;
            target.style.transform = params.visible ? state.transform : hidden.transform;
            if (duration > 0 && typeof target.animate === 'function') {
                state.animation = target.animate([from, params.visible ? shown : hidden], {
                    duration,
                    easing: motionTokens.easingCss.standard,
                });
            }
        }
    }, [params.elementRef, params.visible, reducedMotion]);
    React.useEffect(() => () => {
        for (const [target, state] of targetsRef.current) {
            state.animation?.cancel();
            target.style.opacity = state.opacity;
            target.style.transform = state.transform;
        }
        targetsRef.current.clear();
    }, []);
}

type OverlayPanelMotionParams = Readonly<{
    visible: boolean;
    preset: OverlayMotionPreset;
    /** The panel's element (a web `HTMLElement`); the web motion animates it directly. */
    elementRef: React.RefObject<unknown>;
}>;

type OverlayPanelMotion = Readonly<{ exitMs: number; style: StyleProp<ViewStyle> }>;

/** Where a panel rests: in place when shown, one travel out (or transparent, when it only fades) when not. */
function panelRestingFrame(preset: OverlayMotionPreset, shown: boolean, fadeOnly: boolean): Record<string, string | number> {
    if (fadeOnly) return { opacity: shown ? 1 : 0 };
    return { transform: shown ? 'none' : `translate(${preset.fromTranslateX}px, ${preset.fromTranslateY}px)` };
}

/**
 * The web runs a panel's motion as a Web Animation on its element, which the browser composites off
 * the main thread: a panel that mounts heavy content (the rail's column peek) keeps its pace while that
 * content renders, where the Animated path stalled (lanes/shell-polish.md: a 220 ms slide took ~900 ms
 * on the dev build). Each change starts from where the panel is, so a reversal turns around in place;
 * the element's own style holds the resting state.
 */
function useWebOverlayPanelMotion(params: OverlayPanelMotionParams): OverlayPanelMotion {
    const reducedMotion = useReducedMotionPreference();
    const fadeOnly = reducedMotion && params.preset.reducedMotionFadeMs > 0;
    const presetRef = React.useRef(params.preset);
    presetRef.current = params.preset;
    const animationRef = React.useRef<Animation | null>(null);
    React.useLayoutEffect(() => {
        const element = params.elementRef.current as HTMLElement | null;
        if (!element || typeof element.animate !== 'function') return;
        const preset = presetRef.current;
        const previous = animationRef.current;
        const property = fadeOnly ? 'opacity' : 'transform';
        const turning = previous?.playState === 'running' && (previous.effect as KeyframeEffect | null)?.target === element;
        const from = turning
            ? { [property]: getComputedStyle(element)[property] }
            : panelRestingFrame(preset, !params.visible, fadeOnly);
        previous?.cancel();
        animationRef.current = null;
        const duration = reducedMotion ? preset.reducedMotionFadeMs : (params.visible ? preset.enterMs : preset.exitMs);
        if (duration <= 0) return;
        animationRef.current = element.animate(
            [from, panelRestingFrame(preset, params.visible, fadeOnly)],
            { duration, easing: motionTokens.easingCss.standard },
        );
    }, [fadeOnly, params.elementRef, params.visible, reducedMotion]);
    React.useEffect(() => () => animationRef.current?.cancel(), []);
    const { fromTranslateX, fromTranslateY } = params.preset;
    const style = React.useMemo<ViewStyle>(() => {
        if (fadeOnly) return { opacity: params.visible ? 1 : 0 };
        return params.visible ? {} : { transform: [{ translateX: fromTranslateX }, { translateY: fromTranslateY }] };
    }, [fadeOnly, fromTranslateX, fromTranslateY, params.visible]);
    return { exitMs: reducedMotion ? params.preset.reducedMotionFadeMs : params.preset.exitMs, style };
}

function useNativeOverlayPanelMotion(params: OverlayPanelMotionParams): OverlayPanelMotion {
    return useOverlayMotionAnimation({ visible: params.visible, preset: params.preset });
}

/**
 * Motion for a `panel` overlay (`resolveOverlayMotionPreset({ kind: 'panel' })`): spread `style` on the
 * panel's element (an `Animated.View`), give it `elementRef`, and keep it mounted for `exitMs` after it
 * hides (`useOverlayPresence`).
 */
export const useOverlayPanelMotion: (params: OverlayPanelMotionParams) => OverlayPanelMotion =
    Platform.OS === 'web' ? useWebOverlayPanelMotion : useNativeOverlayPanelMotion;

export function OverlayMotionFrame(props: Readonly<{
    visible: boolean;
    kind: OverlayMotionKind;
    direction?: OverlayMotionDirection;
    style?: StyleProp<ViewStyle>;
    pointerEvents?: 'box-none' | 'none' | 'auto' | 'box-only';
    children: React.ReactNode;
}>): React.ReactElement {
    const elementRef = React.useRef<React.ComponentRef<typeof Animated.View>>(null);
    const preset = React.useMemo(() => resolveOverlayMotionPreset({
        kind: props.kind,
        direction: props.direction,
    }), [props.direction, props.kind]);
    const motion = useOverlayMotionAnimation({
        visible: props.visible,
        preset,
        elementRef,
    });
    const pointerEvents = resolveOverlayPointerEvents(
        props.pointerEvents ?? (props.visible ? 'auto' : 'none'),
    );

    return (
        <Animated.View
            ref={elementRef}
            pointerEvents={pointerEvents.nativePointerEvents}
            // The final style retains the old prop's precedence over caller/motion styles.
            style={[props.style, motion.style, pointerEvents.webStyle]}
        >
            {props.children}
        </Animated.View>
    );
}
