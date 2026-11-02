import * as React from 'react';
import type { View, ViewStyle } from 'react-native';
import Animated, {
    Easing,
    cancelAnimation,
    runOnJS,
    useAnimatedStyle,
    useDerivedValue,
    useSharedValue,
    withSequence,
    withSpring,
    withTiming,
} from 'react-native-reanimated';

import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';

import { motionTokens } from './motionTokens';
import { reanimatedMotionTokens } from './reanimatedMotionTokens';
import { interpolateRectFlip, rectFlipFrame, rectFlipLegProgress, rectFlipTransform, type RectFlipFrame, type RectFlipOrigin, type WindowFlightRect } from './rectFlipGeometry';

export { coverRectFlipOrigin } from './rectFlipGeometry';
export type { RectFlipFrame, RectFlipOrigin, WindowFlightRect } from './rectFlipGeometry';

/** Capture includes an in-flight browser transform, so the next flight can retarget from it. */
export function captureElementFlightRect(element: HTMLElement): WindowFlightRect {
    const rect = element.getBoundingClientRect();
    return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
}

export function cancelElementRectFlight(element: HTMLElement, animationId: string): void {
    for (const animation of element.getAnimations?.() ?? []) {
        if (animation.id === animationId) animation.cancel();
    }
}

/** The DOM adapter of the same destination-local FLIP geometry used by the shared-value flight. */
export function playElementRectFlight(element: HTMLElement, origin: WindowFlightRect, options: Readonly<{
    animationId: string;
    durationMs: number;
    /** Retained columns take their new size once before travelling; their contents never scale. */
    translateOnly?: boolean;
}>): Animation | null {
    cancelElementRectFlight(element, options.animationId);
    if (!element.isConnected || typeof element.animate !== 'function') return null;
    const target = captureElementFlightRect(element);
    if (target.width === 0 || target.height === 0) return null;
    const from = rectFlipTransform(options.translateOnly ? { ...origin, width: target.width, height: target.height } : origin, target);
    if (from.translateX === 0 && from.translateY === 0 && from.scaleX === 1 && from.scaleY === 1) return null;
    const animation = element.animate([
        { transform: `translate(${from.translateX}px, ${from.translateY}px) scale(${from.scaleX}, ${from.scaleY})`, transformOrigin: 'left top' },
        { transform: 'translate(0px, 0px) scale(1, 1)', transformOrigin: 'left top' },
    ], { duration: options.durationMs, easing: motionTokens.easingCss.standard });
    animation.id = options.animationId;
    return animation;
}

/** The same FLIP run forwards: the element leaves its place for `target` and stays there until cancelled. */
export function playElementRectDeparture(element: HTMLElement, target: WindowFlightRect, options: Readonly<{
    animationId: string;
    durationMs: number;
    easingCss: string;
    /** Fades over the flight's last `fadeMs`, so it lands as it goes (a success moment). */
    fadeMs?: number;
}>): Animation | null {
    cancelElementRectFlight(element, options.animationId);
    if (!element.isConnected || typeof element.animate !== 'function') return null;
    const from = captureElementFlightRect(element);
    if (from.width === 0 || from.height === 0) return null;
    const to = rectFlipTransform(target, from);
    const transform = `translate(${to.translateX}px, ${to.translateY}px) scale(${to.scaleX}, ${to.scaleY})`;
    const fadeStart = options.fadeMs === undefined ? null : 1 - options.fadeMs / options.durationMs;
    const animation = element.animate([
        { transform: 'translate(0px, 0px) scale(1, 1)', transformOrigin: 'left top', opacity: 1 },
        ...(fadeStart === null ? [] : [{ opacity: 1, offset: fadeStart }]),
        { transform, transformOrigin: 'left top', opacity: fadeStart === null ? 1 : 0 },
    ], { duration: options.durationMs, easing: options.easingCss, fill: 'forwards' });
    animation.id = options.animationId;
    return animation;
}

/** A rectangle in a container's coordinates. */
export type FlightRect = Readonly<{ x: number; y: number; w: number; h: number }>;

type Measurable = View & { measureLayout?: View['measureLayout'] };

/** Where `node` sits inside `container` (the same `measureLayout` the set-up morph uses); `null` when it can't be read. */
export function measureRectInContainer(node: View | null | undefined, container: View | null | undefined): Promise<FlightRect | null> {
    const measurable = node as Measurable | null | undefined;
    if (!measurable || !container || typeof measurable.measureLayout !== 'function') return Promise.resolve(null);
    return new Promise((resolve) => {
        try {
            measurable.measureLayout(
                container as never,
                (x, y, w, h) => resolve({ x, y, w, h }),
                () => resolve(null),
            );
        } catch {
            resolve(null);
        }
    });
}

/** The smallest rectangle holding every given one; `null` for none. */
export function unionFlightRects(rects: readonly (FlightRect | null)[]): FlightRect | null {
    const present = rects.filter((rect): rect is FlightRect => rect !== null);
    if (present.length === 0) return null;
    const left = Math.min(...present.map((rect) => rect.x));
    const top = Math.min(...present.map((rect) => rect.y));
    const right = Math.max(...present.map((rect) => rect.x + rect.w));
    const bottom = Math.max(...present.map((rect) => rect.y + rect.h));
    return { x: left, y: top, w: right - left, h: bottom - top };
}

export type RectFlightTimeline = Readonly<{ gatherMs: number; travelMs: number; landMs: number }>;

/**
 * Moves a snapshot of A to B's rect inside one container (Git lab SX: the commit's rows become a chip that lands
 * as the newest timeline node). Three steps on one shared clock: gather at A (0 → 1: a slight scale-up into
 * place), travel to B (1 → 2: transform only), land into B (2 → 3: shrink toward B's leading edge and fade).
 * Compositor-only; every new `play` jumps the running one to its end. Callers skip it under reduced motion and
 * cross-fade instead (`motionTokens.successMoment.reducedCrossFadeMs`).
 */
export function useRectFlight() {
    const clock = useSharedValue(0);
    const from = useSharedValue<FlightRect>({ x: 0, y: 0, w: 0, h: 0 });
    const to = useSharedValue<FlightRect>({ x: 0, y: 0, w: 0, h: 0 });
    const [active, setActive] = React.useState(false);
    const doneRef = React.useRef<(() => void) | null>(null);

    const finish = React.useCallback(() => {
        setActive(false);
        const done = doneRef.current;
        doneRef.current = null;
        done?.();
    }, []);

    const play = React.useCallback((source: FlightRect, target: FlightRect, timeline: RectFlightTimeline = motionTokens.successMoment): Promise<void> => {
        doneRef.current?.();
        from.value = source;
        to.value = target;
        clock.value = 0;
        setActive(true);
        const ease = reanimatedMotionTokens.easing.standard;
        return new Promise((resolve) => {
            doneRef.current = resolve;
            clock.value = withSequence(
                withTiming(1, { duration: timeline.gatherMs, easing: ease }),
                withTiming(2, { duration: timeline.travelMs, easing: ease }),
                withTiming(3, { duration: timeline.landMs, easing: Easing.in(Easing.quad) }, (finished) => {
                    'worklet';
                    if (finished) runOnJS(finish)();
                }),
            );
        });
    }, [clock, finish, from, to]);

    const style = useAnimatedStyle(() => {
        const t = clock.value;
        const travel = Math.min(1, Math.max(0, t - 1));
        const land = Math.min(1, Math.max(0, t - 2));
        const gather = Math.min(1, t);
        const x = from.value.x + (to.value.x - from.value.x) * travel;
        const y = from.value.y + (to.value.y - from.value.y) * travel;
        return {
            position: 'absolute',
            left: 0,
            top: 0,
            opacity: gather * (1 - land),
            transform: [
                { translateX: x },
                { translateY: y },
                { scale: (0.98 + 0.02 * gather) * (1 - 0.8 * land) },
            ],
            transformOrigin: 'left center',
        };
    });

    return { active, play, style };
}

/** The flying snapshot: an absolutely positioned layer the caller renders inside the measured container. */
export function RectFlightLayer(props: Readonly<{ style: ReturnType<typeof useRectFlight>['style']; children: React.ReactNode }>) {
    return (
        <Animated.View pointerEvents="none" style={props.style}>
            {props.children}
        </Animated.View>
    );
}

/** The enter's timing (MPG-32): the travel, then the trailing content's fade over its last part. */
export const ENTER_FROM_RECT_MS = motionTokens.headerEnter.travelMs;
export const ENTER_FROM_RECT_CONTENT_FADE_MS = motionTokens.headerEnter.contentFadeMs;

const IDENTITY_FLIP_RECT: WindowFlightRect = { x: 0, y: 0, width: 1, height: 1 };

/**
 * One reversible FLIP clock: progress is also the stage's backdrop opacity. `style` transforms a
 * destination-positioned image. For a cover-cropped origin, use `clipStyle` on the outer layer and
 * `clippedImageStyle` on its image (sized to target.width/height); both layers use transform only.
 */
export function useRectFlip(options: Readonly<{ reducedMotion?: boolean; initialProgress?: 0 | 1 }> = {}) {
    const preferredReducedMotion = useReducedMotionPreference();
    const reducedMotion = options.reducedMotion ?? preferredReducedMotion;
    const progress = useSharedValue<number>(options.initialProgress ?? 1);
    const from = useSharedValue<RectFlipFrame>(rectFlipFrame(IDENTITY_FLIP_RECT));
    const to = useSharedValue<RectFlipFrame>(rectFlipFrame(IDENTITY_FLIP_RECT));
    const target = useSharedValue(IDENTITY_FLIP_RECT);
    const closing = useSharedValue(false);
    const backdropFrom = useSharedValue(1);
    const fades = useSharedValue(reducedMotion);

    const openFrom = React.useCallback((origin: RectFlipOrigin | null, destination: WindowFlightRect, onComplete?: () => void) => {
        cancelAnimation(progress);
        target.value = destination;
        from.value = rectFlipFrame(reducedMotion || origin === null ? destination : origin);
        to.value = rectFlipFrame(destination);
        closing.value = false;
        fades.value = reducedMotion || origin === null;
        progress.value = 0;
        progress.value = withTiming(1, {
            duration: reducedMotion ? motionTokens.successMoment.reducedCrossFadeMs : origin === null ? motionTokens.overlay.modal.enterMs : ENTER_FROM_RECT_MS,
            easing: reanimatedMotionTokens.easing.stageCamera,
        }, (finished) => {
            'worklet';
            if (finished && onComplete) runOnJS(onComplete)();
        });
    }, [closing, fades, from, progress, reducedMotion, target, to]);

    const closeTo = React.useCallback((origin: RectFlipOrigin | null, closeOptions: Readonly<{ velocityY?: number; onComplete?: () => void }> = {}) => {
        cancelAnimation(progress);
        const current = interpolateRectFlip(from.value, to.value, rectFlipLegProgress(progress.value, closing.value, backdropFrom.value));
        const currentProgress = progress.value;
        const image = current.imageRect;
        const fallbackScale = 0.96;
        const fallbackImage = { x: image.x + image.width * (1 - fallbackScale) / 2, y: image.y + image.height * (1 - fallbackScale) / 2, width: image.width * fallbackScale, height: image.height * fallbackScale };
        const destination = origin === null ? {
            imageRect: fallbackImage,
            clipRect: {
                x: fallbackImage.x + (current.clipRect.x - image.x) * fallbackScale,
                y: fallbackImage.y + (current.clipRect.y - image.y) * fallbackScale,
                width: current.clipRect.width * fallbackScale,
                height: current.clipRect.height * fallbackScale,
            },
        } : rectFlipFrame(origin);
        from.value = current;
        to.value = reducedMotion ? current : destination;
        closing.value = true;
        backdropFrom.value = currentProgress;
        fades.value = reducedMotion || origin === null;
        const complete = closeOptions.onComplete;
        const done = (finished?: boolean) => {
            'worklet';
            if (finished && complete) runOnJS(complete)();
        };
        if (!reducedMotion && closeOptions.velocityY !== undefined) {
            const distance = to.value.imageRect.y - image.y;
            progress.value = withSpring(0, {
                ...reanimatedMotionTokens.spring.travel,
                velocity: distance === 0 ? 0 : -closeOptions.velocityY * currentProgress / distance,
            }, done);
        } else {
            progress.value = withTiming(0, {
                duration: reducedMotion ? motionTokens.successMoment.reducedCrossFadeMs : origin === null ? motionTokens.overlay.modal.exitMs : ENTER_FROM_RECT_MS,
                easing: reanimatedMotionTokens.easing.stageCamera,
            }, done);
        }
    }, [backdropFrom, closing, fades, from, progress, reducedMotion, to]);

    const frame = useDerivedValue(() => interpolateRectFlip(from.value, to.value, rectFlipLegProgress(progress.value, closing.value, backdropFrom.value)));
    const style = useAnimatedStyle<ViewStyle>(() => {
        const transform = rectFlipTransform(frame.value.imageRect, target.value);
        return {
            opacity: fades.value ? progress.value : 1,
            transformOrigin: 'left top',
            transform: [
                { translateX: transform.translateX },
                { translateY: transform.translateY },
                { scaleX: transform.scaleX },
                { scaleY: transform.scaleY },
            ],
        };
    });
    const clipStyle = useAnimatedStyle<ViewStyle>(() => ({
        position: 'absolute', left: target.value.x, top: target.value.y,
        width: target.value.width, height: target.value.height, overflow: 'hidden',
        opacity: fades.value ? progress.value : 1,
        transformOrigin: 'left top',
        transform: [
            { translateX: frame.value.clipRect.x - target.value.x },
            { translateY: frame.value.clipRect.y - target.value.y },
            { scaleX: frame.value.clipRect.width / target.value.width },
            { scaleY: frame.value.clipRect.height / target.value.height },
        ],
    }));
    const clippedImageStyle = useAnimatedStyle<ViewStyle>(() => ({
        transformOrigin: 'left top',
        transform: [
            { translateX: (frame.value.imageRect.x - frame.value.clipRect.x) * target.value.width / frame.value.clipRect.width },
            { translateY: (frame.value.imageRect.y - frame.value.clipRect.y) * target.value.height / frame.value.clipRect.height },
            { scaleX: frame.value.imageRect.width / frame.value.clipRect.width },
            { scaleY: frame.value.imageRect.height / frame.value.clipRect.height },
        ],
    }));
    return { progress, style, clipStyle, clippedImageStyle, frame, openFrom, closeTo, from, to, backdropFrom };
}

/** How a destination enters: from its origin's rect, cross-faded in place (reduced motion), or not at all. */
export type EnterFromRectMode = 'travel' | 'fade' | 'none';
type EnterOffset = Readonly<{ x: number; y: number }>;
const NO_OFFSET: EnterOffset = { x: 0, y: 0 };

/** The smallest window rectangle holding every measured one; `null` when none was measured. */
export function unionWindowFlightRects(rects: readonly (WindowFlightRect | null)[]): WindowFlightRect | null {
    const union = unionFlightRects(rects.map((rect) => rect ? { x: rect.x, y: rect.y, w: rect.width, h: rect.height } : null));
    return union ? { x: union.x, y: union.y, width: union.w, height: union.h } : null;
}

/**
 * One member of a group that enters together (a header's mark and its title). The group's FLIP transform is
 * about the group's top-left; each member carries it about its own top-left, corrected by its offset in the
 * group, so the members move and scale as one rigid piece. Unarmed members are unseen: no frame paints at
 * the final position before the move.
 */
export function enterFromRectMemberStyle(input: Readonly<{
    mode: EnterFromRectMode;
    armed: boolean;
    progress: number;
    from: WindowFlightRect;
    target: WindowFlightRect;
    offset: EnterOffset;
}>) {
    'worklet';
    // A web frame can land before the timing's own start time and read a progress outside 0…1 (observed live:
    // -3.6 on the first armed frame); the group never travels past its ends.
    const k = Math.max(0, Math.min(1, input.progress));
    let translateX = 0;
    let translateY = 0;
    let scaleX = 1;
    let scaleY = 1;
    if (input.mode === 'travel' && input.target.width > 0 && input.target.height > 0) {
        const rect = {
            x: input.from.x + (input.target.x - input.from.x) * k,
            y: input.from.y + (input.target.y - input.from.y) * k,
            width: input.from.width + (input.target.width - input.from.width) * k,
            height: input.from.height + (input.target.height - input.from.height) * k,
        };
        const group = rectFlipTransform(rect, input.target);
        scaleX = group.scaleX;
        scaleY = group.scaleY;
        translateX = group.translateX + (scaleX - 1) * input.offset.x;
        translateY = group.translateY + (scaleY - 1) * input.offset.y;
    }
    return {
        opacity: !input.armed ? 0 : input.mode === 'fade' ? k : 1,
        transformOrigin: 'left top',
        transform: [{ translateX }, { translateY }, { scaleX }, { scaleY }],
    };
}

/** The supporting lines and controls: in over the travel's last part, with the cross-fade, or simply there. */
export function enterFromRectContentOpacity(mode: EnterFromRectMode, armed: boolean, progress: number): number {
    'worklet';
    if (mode === 'none') return 1;
    if (!armed) return 0;
    if (mode === 'fade') return Math.max(0, Math.min(1, progress));
    const fadeFrom = 1 - ENTER_FROM_RECT_CONTENT_FADE_MS / ENTER_FROM_RECT_MS;
    return Math.max(0, Math.min(1, (progress - fadeFrom) / (1 - fadeFrom)));
}

/**
 * A destination group that enters from where its origin was (a popover row's mark + name → the machine page
 * header's mark + name, lab `MO` 3): FLIP on the destination only, no cross-surface element. The members are
 * measured in window coordinates (`onTargets`); the group starts at the origin's top-left at the origin's
 * height scale and runs to identity on the travel timing with a strong ease-out, compositor-only. Reduced
 * motion cross-fades in place; a `null` origin applies nothing. Members render through
 * `useEnterFromRectMember`; supporting content takes `contentStyle`.
 */
export function useEnterFromRect(origin: WindowFlightRect | null, options: Readonly<{ reducedMotion: boolean }>) {
    const mode: EnterFromRectMode = origin === null ? 'none' : options.reducedMotion ? 'fade' : 'travel';
    const progress = useSharedValue(mode === 'none' ? 1 : 0);
    const armed = useSharedValue(mode === 'none');
    const from = useSharedValue<WindowFlightRect>(IDENTITY_FLIP_RECT);
    const target = useSharedValue<WindowFlightRect>(IDENTITY_FLIP_RECT);
    const offsets = useSharedValue<readonly EnterOffset[]>([]);
    const started = React.useRef(false);
    const onTargets = React.useCallback((rects: readonly (WindowFlightRect | null)[]) => {
        if (mode === 'none' || started.current) return;
        started.current = true;
        const union = unionWindowFlightRects(rects);
        if (mode === 'travel' && (!union || union.height <= 0 || origin === null)) {
            // Nothing to travel to: the destination simply shows where it is.
            progress.value = 1;
            armed.value = true;
            return;
        }
        if (mode === 'travel' && union && origin) {
            target.value = union;
            offsets.value = rects.map((rect) => rect ? { x: rect.x - union.x, y: rect.y - union.y } : NO_OFFSET);
            // Uniform by height: the header's contract (a row's name and the page's title differ in size, not shape).
            from.value = { x: origin.x, y: origin.y, width: union.width * origin.height / union.height, height: origin.height };
        }
        progress.value = 0;
        armed.value = true;
        progress.value = withTiming(1, {
            duration: mode === 'fade' ? motionTokens.headerEnter.reducedCrossFadeMs : ENTER_FROM_RECT_MS,
            easing: reanimatedMotionTokens.easing.stageCamera,
        });
    }, [armed, from, mode, offsets, origin, progress, target]);
    // The members moved while travelling (the page still placing itself): the group lands where they now are.
    const retarget = React.useCallback((rects: readonly (WindowFlightRect | null)[]) => {
        if (mode !== 'travel' || !started.current) return;
        const union = unionWindowFlightRects(rects);
        if (!union || union.height <= 0) return;
        target.value = union;
        offsets.value = rects.map((rect) => rect ? { x: rect.x - union.x, y: rect.y - union.y } : NO_OFFSET);
    }, [mode, offsets, target]);
    const contentStyle = useAnimatedStyle<ViewStyle>(() => ({ opacity: enterFromRectContentOpacity(mode, armed.value, progress.value) }));
    const group = React.useMemo(() => ({ mode, progress, armed, from, target, offsets }), [armed, from, mode, offsets, progress, target]);
    return { group, onTargets, retarget, contentStyle };
}

function sameWindowRects(a: readonly (WindowFlightRect | null)[], b: readonly (WindowFlightRect | null)[]): boolean {
    return a.length === b.length && a.every((rect, index) => {
        const other = b[index];
        if (!rect || !other) return rect === other;
        return Math.abs(rect.x - other.x) < 0.5 && Math.abs(rect.y - other.y) < 0.5
            && Math.abs(rect.width - other.width) < 0.5 && Math.abs(rect.height - other.height) < 0.5;
    });
}

/**
 * Measures the members (`read`, their untransformed layout rects in window coordinates) and starts the move, then
 * keeps reading them each frame while it travels: a page can still be placing itself on its first frames (a list
 * column arriving narrows the pane and recentres the header), and the move retargets to where the members now
 * are instead of landing with a jump. Returns a cancel.
 */
export function trackEnterFromRectTargets(
    read: () => Promise<readonly (WindowFlightRect | null)[]>,
    enter: Pick<ReturnType<typeof useEnterFromRect>, 'onTargets' | 'retarget'>,
): () => void {
    let cancelled = false;
    let frame: ReturnType<typeof requestAnimationFrame> | null = null;
    let startedAt = 0;
    let previous: readonly (WindowFlightRect | null)[] = [];
    const follow = () => {
        frame = null;
        void read().then((rects) => {
            if (cancelled) return;
            if (!sameWindowRects(previous, rects)) enter.retarget(rects);
            previous = rects;
            if (Date.now() - startedAt < ENTER_FROM_RECT_MS) frame = requestAnimationFrame(follow);
        });
    };
    void read().then((rects) => {
        if (cancelled) return;
        startedAt = Date.now();
        previous = rects;
        enter.onTargets(rects);
        frame = requestAnimationFrame(follow);
    });
    return () => {
        cancelled = true;
        if (frame !== null) cancelAnimationFrame(frame);
    };
}

/** The animated style of the group's `index`-th member (the order `onTargets` measured them in). */
export function useEnterFromRectMember(group: ReturnType<typeof useEnterFromRect>['group'], index: number) {
    const { mode, armed, progress, from, target, offsets } = group;
    return useAnimatedStyle<ViewStyle>(() => enterFromRectMemberStyle({
        mode, armed: armed.value, progress: progress.value, from: from.value, target: target.value, offset: offsets.value[index] ?? NO_OFFSET,
    }) as ViewStyle);
}
