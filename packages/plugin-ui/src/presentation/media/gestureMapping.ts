import type { HappierLiveStreamGestureGeometry, HappierLiveStreamInputControlKind, HappierLiveStreamInputGesture,
    HappierLiveStreamInputMode, HappierLiveStreamPoint, HappierLiveStreamViewTransform } from './inputGesture.js';
import { HAPPIER_GESTURE_TIMING } from './inputGesture.js';

type Point = HappierLiveStreamPoint;
type TouchPair = readonly [Point, Point];
type Context = HappierLiveStreamGestureGeometry & Readonly<{
    mode: HappierLiveStreamInputMode;
    localZoom: boolean;
    supports: (kind: HappierLiveStreamInputControlKind) => boolean;
}>;
type Input = Readonly<{ phase: 'start' | 'move' | 'end' | 'cancel'; point: Point; at: number; touches?: readonly Point[] }>;
type Stroke = {
    start: Point; latest: Point; at: number; latestAt: number; pointerStart: Point; trail: Point[];
    multiStart?: TouchPair; multiLatest?: TouchPair; transformStart: HappierLiveStreamViewTransform;
    intent?: 'pinch' | 'scroll' | 'drag' | 'move';
    held: boolean;
};

const distance = (a: Point, b: Point) => Math.hypot(b.x - a.x, b.y - a.y);
const center = (pair: TouchPair): Point => ({ x: (pair[0].x + pair[1].x) / 2, y: (pair[0].y + pair[1].y) / 2 });
const angle = (pair: TouchPair) => Math.atan2(pair[1].y - pair[0].y, pair[1].x - pair[0].x);
const pair = (touches?: readonly Point[]): TouchPair | undefined => touches && touches.length >= 2 ? [touches[0], touches[1]] : undefined;
const clamp = (value: number, minimum: number, maximum: number) => Math.max(minimum, Math.min(maximum, value));

/** One gesture owner for direct device interaction and relative remote-desktop interaction. */
export function createLiveStreamGestureMapper() {
    let stroke: Stroke | undefined;
    let pointer: Point = { x: 0.5, y: 0.5 };
    let transform: HappierLiveStreamViewTransform = { scale: 1, x: 0, y: 0 };
    const boundTransform = (next: HappierLiveStreamViewTransform, context: Context) => ({
        scale: next.scale,
        x: clamp(next.x, context.viewport.width * (1 - next.scale), 0),
        y: clamp(next.y, context.viewport.height * (1 - next.scale), 0),
    });
    const normalize = (point: Point, context: Context): Point => ({
        x: (point.x - transform.x) / transform.scale / context.viewport.width,
        y: (point.y - transform.y) / transform.scale / context.viewport.height,
    });
    const pointerPoint = (context: Context): Point => ({
        x: (context.content.x + pointer.x * context.content.width) / context.viewport.width,
        y: (context.content.y + pointer.y * context.content.height) / context.viewport.height,
    });
    const result = (actions: HappierLiveStreamInputGesture[] = []) => ({ actions, pointer, transform, trail: stroke?.trail ?? [] });
    return {
        resetZoom() { transform = { scale: 1, x: 0, y: 0 }; return result(); },
        /** Hardware hover is absolute in either touch mode. */
        hover(point: Point, context: Context) {
            const normalized = normalize(point, context);
            pointer = {
                x: clamp((normalized.x * context.viewport.width - context.content.x) / context.content.width, 0, 1),
                y: clamp((normalized.y * context.viewport.height - context.content.y) / context.content.height, 0, 1),
            };
            return { ...result(), point: normalized };
        },
        map(input: Input, context: Context) {
            const geometry: HappierLiveStreamGestureGeometry = { viewport: context.viewport, content: context.content, orientation: context.orientation };
            if (input.phase === 'start') {
                const multi = pair(input.touches);
                stroke = { start: input.point, latest: input.point, at: input.at, latestAt: input.at,
                    pointerStart: pointerPoint(context), trail: [], transformStart: transform, held: false,
                    ...(multi ? { multiStart: multi, multiLatest: multi } : {}) };
                return result();
            }
            if (!stroke) return result();
            const current = stroke;
            const actions: HappierLiveStreamInputGesture[] = [];
            const elapsedMs = Math.max(0, input.at - current.at);
            // Browser timestamps have sub-millisecond precision; wire gesture durations are positive integers.
            const durationMs = Math.max(1, Math.round(elapsedMs));
            const point = pointerPoint(context);
            if (input.phase === 'cancel') {
                if (current.held) actions.push({ kind: 'pointer', phase: 'cancel', point, ...geometry });
                stroke = undefined;
                return result(actions);
            }
            if (input.phase === 'move') {
                const multi = pair(input.touches);
                // A second finger can join after the responder was granted to the first.
                if (multi && !current.multiStart) {
                    if (current.held) actions.push({ kind: 'pointer', phase: 'cancel', point, ...geometry });
                    current.held = false;
                    current.trail = [];
                    current.multiStart = multi;
                    current.multiLatest = multi;
                    current.transformStart = transform;
                    current.intent = undefined;
                }
                if (multi && current.multiStart && current.multiLatest) {
                    const startDistance = distance(...current.multiStart);
                    const endDistance = distance(...multi);
                    const previousCenter = center(current.multiLatest);
                    const latestCenter = center(multi);
                    if (!current.intent && Math.abs(endDistance - startDistance) >= 8) current.intent = 'pinch';
                    if (!current.intent && distance(center(current.multiStart), latestCenter) >= HAPPIER_GESTURE_TIMING.slopPx) current.intent = 'scroll';
                    if (current.intent === 'pinch' && context.localZoom && startDistance > 0) {
                        const scale = Math.max(1, current.transformStart.scale * endDistance / startDistance);
                        const anchor = center(current.multiStart);
                        transform = boundTransform({ scale,
                            x: latestCenter.x - (anchor.x - current.transformStart.x) * scale / current.transformStart.scale,
                            y: latestCenter.y - (anchor.y - current.transformStart.y) * scale / current.transformStart.scale }, context);
                    } else if (current.intent === 'scroll' && context.mode === 'trackpad' && context.supports('wheel')) {
                        actions.push({ kind: 'wheel', point, deltaX: previousCenter.x - latestCenter.x,
                            deltaY: previousCenter.y - latestCenter.y, ...geometry });
                    }
                    current.multiLatest = multi;
                } else if (!current.multiStart && context.mode === 'trackpad') {
                    const dx = input.point.x - current.latest.x;
                    const dy = input.point.y - current.latest.y;
                    if (!current.intent && distance(current.start, input.point) >= HAPPIER_GESTURE_TIMING.slopPx) {
                        current.intent = elapsedMs >= HAPPIER_GESTURE_TIMING.longPressMs ? 'drag' : 'move';
                        if (current.intent === 'drag' && context.supports('pointer')) {
                            actions.push({ kind: 'pointer', phase: 'down', point, ...geometry });
                            current.held = true;
                        } else if (current.intent === 'drag') {
                            current.trail.push(current.pointerStart);
                        }
                    }
                    const speed = Math.hypot(dx, dy) / Math.max(1, input.at - current.latestAt);
                    // A continuous gain curve preserves fine movement and accelerates fast strokes.
                    const gain = 0.5 + 2.5 * speed / (1 + speed);
                    pointer = {
                        x: clamp(pointer.x + dx * gain / (context.content.width * transform.scale), 0, 1),
                        y: clamp(pointer.y + dy * gain / (context.content.height * transform.scale), 0, 1),
                    };
                    if (transform.scale > 1) {
                        const remote = pointerPoint(context);
                        const visible = { x: remote.x * context.viewport.width * transform.scale + transform.x,
                            y: remote.y * context.viewport.height * transform.scale + transform.y };
                        transform = boundTransform({ ...transform,
                            x: transform.x - Math.max(0, visible.x - context.viewport.width) - Math.min(0, visible.x),
                            y: transform.y - Math.max(0, visible.y - context.viewport.height) - Math.min(0, visible.y) }, context);
                    }
                    if (dx !== 0 || dy !== 0) {
                        if (current.intent === 'drag' && !current.held) current.trail.push(pointerPoint(context));
                        if (current.held) actions.push({ kind: 'pointer', phase: 'move', point: pointerPoint(context), ...geometry });
                        else if (current.intent !== 'drag' && context.supports('move')) actions.push({ kind: 'move', point: pointerPoint(context), ...geometry });
                    }
                }
                current.latest = input.point;
                current.latestAt = input.at;
                return result(actions);
            }
            stroke = undefined;
            if (current.held) return result([{ kind: 'pointer', phase: 'up', point, ...geometry }]);
            if (current.multiStart && current.multiLatest) {
                if (current.intent === 'pinch' && context.localZoom || current.intent === 'scroll' && context.mode === 'trackpad') return result();
                const startDistance = distance(...current.multiStart);
                const endDistance = distance(...current.multiLatest);
                if (context.supports('pinch') && Math.abs(endDistance - startDistance) >= 8) return result([{
                    kind: 'pinch', center: normalize(center(current.multiLatest), context), startDistance, endDistance,
                    angle: angle(current.multiLatest), durationMs, ...geometry,
                }]);
                if (context.supports('rotate') && Math.abs(angle(current.multiLatest) - angle(current.multiStart)) >= 0.1) return result([{
                    kind: 'rotate', center: normalize(center(current.multiStart), context), radius: startDistance / 2,
                    startAngle: angle(current.multiStart), endAngle: angle(current.multiLatest), durationMs, ...geometry,
                }]);
                if (context.mode === 'trackpad') return result(context.supports('tap') ? [{ kind: 'tap', button: 'right', point, ...geometry }] : []);
            }
            if (context.mode === 'trackpad') {
                // Native drivers expose one atomic drag. The client previews its path until release.
                if (current.intent === 'drag') return result(context.supports('drag') ? [{kind: 'drag', from: current.pointerStart, to: point, durationMs, ...geometry}] : []);
                if (current.intent === 'move') return result();
                return result(context.supports('tap') ? [{ kind: 'tap', point, ...geometry }] : []);
            }
            if (distance(current.start, current.latest) >= HAPPIER_GESTURE_TIMING.slopPx) {
                const kind = context.supports('swipe') ? 'swipe' : context.supports('drag') ? 'drag' : null;
                if (kind) return result([{ kind, from: normalize(current.start, context), to: normalize(current.latest, context), durationMs, ...geometry }]);
            }
            if (elapsedMs >= HAPPIER_GESTURE_TIMING.longPressMs && context.supports('long_press')) return result([{ kind: 'long_press', point: normalize(current.latest, context), durationMs, ...geometry }]);
            return result(context.supports('tap') ? [{ kind: 'tap', point: normalize(input.point, context), ...geometry }] : []);
        },
    };
}
