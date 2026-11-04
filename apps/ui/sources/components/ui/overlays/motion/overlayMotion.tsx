import * as React from 'react';
import { Animated, Dimensions, Platform, type StyleProp, type ViewStyle } from 'react-native';

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
    /** A sheet rising from its edge: the web measures its frame and travels that far; `fromTranslateY` is the other platforms' travel. */
    risesByOwnHeight?: boolean;
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
    /** `panel`, and a `modal` that rises from `bottom`: how far it travels in, usually its own size along `direction`. */
    travelPx?: number;
}>): OverlayMotionPreset {
    const direction = params.direction ?? 'center';

    if (params.kind === 'panel' && direction === 'center') {
        // Standing in another panel's place: nothing travels, the two cross-fade over the same time both ways.
        return {
            enterMs: motionTokens.overlay.panel.crossfadeMs,
            exitMs: motionTokens.overlay.panel.crossfadeMs,
            fromOpacity: 0,
            fromScale: 1,
            fromTranslateX: 0,
            fromTranslateY: 0,
            reducedMotionFadeMs: motionTokens.overlay.panel.reducedMotionFadeMs,
        };
    }

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

    if (params.kind === 'modal' && direction === 'bottom') {
        // A phone sheet rises whole, paper and content together, and is never see-through on the way.
        return {
            enterMs: motionTokens.overlay.modal.enterMs,
            exitMs: motionTokens.overlay.modal.exitMs,
            fromOpacity: 1,
            fromScale: 1,
            fromTranslateX: 0,
            fromTranslateY: params.travelPx ?? 0,
            reducedMotionFadeMs: motionTokens.durationMs.fast,
            risesByOwnHeight: true,
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
    disabled?: boolean;
    preset: OverlayMotionPreset;
    /** Web frames animate as a whole; one holding material paint moves by transform, and on exit fades its paint and content, never the frame. */
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
        if (params.disabled) {
            progress.setValue(params.visible ? 1 : 0);
            return;
        }
        if (webElementMotion) return;
        Animated.timing(progress, {
            toValue: params.visible ? 1 : 0,
            duration: reducedMotion
                ? reducedMs
                : (params.visible ? params.preset.enterMs : params.preset.exitMs),
            easing: motionTokens.easing.standard,
            useNativeDriver: Platform.OS !== 'web',
        }).start();
    }, [params.disabled, params.preset.enterMs, params.preset.exitMs, params.visible, progress, reducedMotion, reducedMs, webElementMotion]);

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
        exitMs: params.disabled ? 0 : reducedMotion ? reducedMs : params.preset.exitMs,
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

type WebMotionTarget = Readonly<{ element: HTMLElement; paint: boolean }>;

/**
 * A frame holding material paint moves whole, by transform alone: opacity on the paint's ancestors would
 * empty the backdrop its blur samples, while a transform does not (Chromium, observed in DESIGN-18). Moving
 * the frame, not only the paint and its content siblings, carries the edges and fills the paint's ancestors
 * draw (a sheet's rim, a hold card's tinted ring) with it; leaving them behind showed an empty card shell
 * standing still while the content travelled (DESIGN-17 R3, DESIGN-18 M1). A frame with no material paint
 * (a plain popover) also fades, as its preset says.
 */
function webOverlayMotionTargets(element: HTMLElement): WebMotionTarget[] {
    const material = element.matches(GLASS_BACKDROP_SELECTOR) || element.querySelector(GLASS_BACKDROP_SELECTOR) !== null;
    return [{ element, paint: material }];
}

/**
 * What a leaving material frame fades: every glass paint layer itself and every subtree beside the paint
 * (content, the directional rim, a card's tinted ring), never an ancestor of a paint. The surface thins
 * out as it travels, while each paint keeps sampling the page through its own blur.
 */
function webMaterialFadeLayers(frame: HTMLElement): Element[] {
    if (frame.matches(GLASS_BACKDROP_SELECTOR)) return [frame];
    const layers: Element[] = [];
    const visit = (parent: Element) => {
        for (const child of Array.from(parent.children)) {
            if (child.matches(GLASS_BACKDROP_SELECTOR) || child.querySelector(GLASS_BACKDROP_SELECTOR) === null) layers.push(child);
            else visit(child);
        }
    };
    visit(frame);
    return layers;
}

/**
 * The elevation a leaving material frame drops: a card's shadow is drawn on an ancestor of its paint (the
 * paint clips, so the shadow cannot move onto it). It fades by the shadow itself, never by opacity, so no
 * shadow is left standing where the card was while the blur keeps its backdrop.
 */
function webMaterialShadowLayers(frame: HTMLElement): Element[] {
    const ancestors = new Set<Element>();
    for (const paint of Array.from(frame.querySelectorAll(GLASS_BACKDROP_SELECTOR))) {
        for (let node = paint.parentElement; node; node = node.parentElement) {
            if (!node.matches(GLASS_BACKDROP_SELECTOR)) ancestors.add(node);
            if (node === frame) break;
        }
    }
    return Array.from(ancestors).filter(element => { const shadow = getComputedStyle(element).boxShadow; return shadow !== '' && shadow !== 'none'; });
}

type MaterialFade = Readonly<{ animation: Animation; property: 'opacity' | 'boxShadow' }>;

type WebContentMotionTarget = {
    animation: Animation | null;
    opacity: string;
    transform: string;
    shownOpacity: string;
    shownTransform: string;
};

function useWebOverlayContentMotion(params: Readonly<{
    visible: boolean;
    disabled?: boolean;
    preset: OverlayMotionPreset;
    elementRef?: React.RefObject<unknown>;
}>, reducedMotion: boolean): void {
    const targetsRef = React.useRef(new Map<HTMLElement, WebContentMotionTarget>());
    const fadesRef = React.useRef(new Map<Element, MaterialFade>());
    const presetRef = React.useRef(params.preset);
    presetRef.current = params.preset;
    React.useLayoutEffect(() => {
        if (Platform.OS !== 'web' || params.disabled) return;
        const element = params.elementRef?.current;
        if (!element || typeof HTMLElement === 'undefined' || !(element instanceof HTMLElement)) return;
        const preset = presetRef.current;
        const fadeOnly = reducedMotion;
        const duration = reducedMotion ? preset.reducedMotionFadeMs : params.visible ? preset.enterMs : preset.exitMs;
        // A sheet rises by the height of its own frame, the same distance for the paint and every content block.
        const rise = preset.risesByOwnHeight ? element.getBoundingClientRect().height : preset.fromTranslateY;
        const targets = webOverlayMotionTargets(element);
        const hasMaterial = targets.some(target => target.paint);
        // Reduced motion cross-fades; over material paint that would show an empty card, so it changes at once.
        if (hasMaterial && fadeOnly) return;
        for (const { element: target, paint } of targets) {
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
                opacity: fadeOnly ? '0' : String(hasMaterial ? Number(shown.opacity) : preset.fromOpacity * Number(shown.opacity)),
                transform: fadeOnly ? shown.transform
                    : `translate(${preset.fromTranslateX}px, ${rise}px) scale(${preset.fromScale})${shown.transform !== 'none' ? ` ${shown.transform}` : ''}`,
            };
            // Read the current composited frame before cancelling or changing the resting styles.
            const computed = state.animation?.playState === 'running' ? getComputedStyle(target) : null;
            const from = computed ? { opacity: computed.opacity, transform: fadeOnly ? shown.transform : computed.transform } : params.visible ? hidden : shown;
            state.animation?.cancel();
            state.animation = null;
            if (!paint) target.style.opacity = params.visible ? state.opacity : hidden.opacity;
            target.style.transform = params.visible ? state.transform : hidden.transform;
            if (duration > 0 && typeof target.animate === 'function') {
                const frame = (values: typeof shown): Keyframe => paint ? { transform: values.transform } : values;
                state.animation = target.animate([frame(from), frame(params.visible ? shown : hidden)], {
                    duration,
                    easing: motionTokens.easingCss.standard,
                });
            }
        }
        if (hasMaterial) fadeMaterialLayers(element, fadesRef.current, params.visible, duration);
    }, [params.disabled, params.elementRef, params.visible, reducedMotion]);
    React.useEffect(() => () => {
        for (const fade of fadesRef.current.values()) fade.animation.cancel();
        fadesRef.current.clear();
        for (const [target, state] of targetsRef.current) {
            state.animation?.cancel();
            target.style.opacity = state.opacity;
            target.style.transform = state.transform;
        }
        targetsRef.current.clear();
    }, []);
}

/**
 * A material frame enters by transform alone (it is never see-through on the way in). On the way out its
 * paint and content fade, and its elevation drops, while it travels, so it does not end in a cut; the fade
 * holds until the overlay unmounts. Opening again mid-way fades back from where each layer is.
 */
function fadeMaterialLayers(frame: HTMLElement, fades: Map<Element, MaterialFade>, visible: boolean, duration: number): void {
    const layers: [Element, MaterialFade['property']][] = visible
        ? Array.from(fades, ([layer, fade]) => [layer, fade.property])
        : [
            ...webMaterialFadeLayers(frame).map(layer => [layer, 'opacity'] as [Element, MaterialFade['property']]),
            ...webMaterialShadowLayers(frame).map(layer => [layer, 'boxShadow'] as [Element, MaterialFade['property']]),
        ];
    for (const [layer, property] of layers) {
        const previous = fades.get(layer);
        const current = previous?.animation.playState === 'running' ? getComputedStyle(layer)[property] : null;
        previous?.animation.cancel();
        fades.delete(layer);
        if (duration <= 0 || typeof layer.animate !== 'function') continue;
        if (visible) {
            // A finished fade only needs cancelling; a running one turns around from where it is.
            if (current !== null) fades.set(layer, { property, animation: layer.animate([{ [property]: current, offset: 0 }], { duration, easing: motionTokens.easingCss.standard }) });
            continue;
        }
        const gone = property === 'opacity' ? 0 : 'none';
        const leave: Keyframe[] = current === null ? [{ [property]: gone, offset: 1 }] : [{ [property]: current }, { [property]: gone }];
        fades.set(layer, { property, animation: layer.animate(leave, { duration, easing: motionTokens.easingCss.exit, fill: 'forwards' }) });
    }
}

type OverlayPanelMotionParams = Readonly<{
    visible: boolean;
    preset: OverlayMotionPreset;
    /** The panel's element (a web `HTMLElement`); the web motion animates it directly. */
    elementRef: React.RefObject<unknown>;
    /** `false`: a panel already standing when it mounts (the open column's content) rests there; only changes move it. */
    appear?: boolean;
}>;

type OverlayPanelMotion = Readonly<{ exitMs: number; style: StyleProp<ViewStyle> }>;

/** A panel standing in another's place (`direction: 'center'`) cross-fades instead of travelling. */
function panelCrossfades(preset: OverlayMotionPreset): boolean {
    return preset.fromOpacity < 1 && preset.fromTranslateX === 0 && preset.fromTranslateY === 0;
}

/** Where a panel rests: in place when shown, one travel out (or transparent, when it only fades) when not. */
function panelRestingFrame(preset: OverlayMotionPreset, shown: boolean, fadeOnly: boolean): Record<string, string | number> {
    if (fadeOnly || panelCrossfades(preset)) return { opacity: shown ? 1 : 0 };
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
    // A cross-fading panel moves by opacity alone, with or without reduced motion.
    const fades = fadeOnly || panelCrossfades(params.preset);
    const presetRef = React.useRef(params.preset);
    presetRef.current = params.preset;
    const animationRef = React.useRef<Animation | null>(null);
    const restsOnMountRef = React.useRef(params.appear === false);
    React.useLayoutEffect(() => {
        const element = params.elementRef.current as HTMLElement | null;
        if (restsOnMountRef.current) {
            restsOnMountRef.current = false;
            return;
        }
        if (!element || typeof element.animate !== 'function') return;
        const preset = presetRef.current;
        const previous = animationRef.current;
        const property = fades ? 'opacity' : 'transform';
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
    }, [fadeOnly, fades, params.elementRef, params.visible, reducedMotion]);
    React.useEffect(() => () => animationRef.current?.cancel(), []);
    const { fromTranslateX, fromTranslateY } = params.preset;
    const style = React.useMemo<ViewStyle>(() => {
        if (fades) return { opacity: params.visible ? 1 : 0 };
        return params.visible ? {} : { transform: [{ translateX: fromTranslateX }, { translateY: fromTranslateY }] };
    }, [fades, fromTranslateX, fromTranslateY, params.visible]);
    return { exitMs: reducedMotion ? params.preset.reducedMotionFadeMs : params.preset.exitMs, style };
}

function useNativeOverlayPanelMotion(params: OverlayPanelMotionParams): OverlayPanelMotion {
    // A panel that rests on mount takes its first state at once; later changes animate.
    const [restsOnMount] = React.useState(params.appear === false);
    const [mounted, setMounted] = React.useState(false);
    React.useEffect(() => setMounted(true), []);
    return useOverlayMotionAnimation({ visible: params.visible, preset: params.preset, disabled: restsOnMount && !mounted });
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
    // A rising sheet clears the screen on the other platforms; the web measures the frame itself.
    const preset = React.useMemo(() => resolveOverlayMotionPreset({
        kind: props.kind,
        direction: props.direction,
        travelPx: props.direction === 'bottom' ? Dimensions.get('window').height : undefined,
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
