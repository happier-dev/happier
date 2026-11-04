import * as React from 'react';
import { ScopedTheme, useUnistyles } from 'react-native-unistyles';

import { motionTokens } from '@/components/ui/motion/motionTokens';
import { Typography } from '@/constants/Typography';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { ESCAPE_LAYER_PRIORITIES, useEscapeLayer } from '@/keyboard/escape';
import { t } from '@/text';

import {
    classifySelectionRelease,
    clampSelectionPoint,
    dragRectWithinDisplay,
    resolveSelectionHintEdge,
    resolveSelectionLabelPosition,
    type SelectionPoint,
    type SelectionRect,
} from './captureSelectionGeometry';
import { CaptureSelectionHint } from './CaptureSelectionHint';
import type { CaptureSelectionLayerProps, CaptureSelectionWindow } from './CaptureSelectionLayer';

/** Interaction geometry the motion spec decides once (MIS §1 Labels and Hint pill). */
const LABEL_EDGE_PT = 8;
const LABEL_WINDOW_INSET_PT = 12;
const HINT_EDGE_PT = 24;
const CROSS_SIZE_PT = 22;
const EMPTY_RECT: SelectionRect = { x: 0, y: 0, width: 0, height: 0 };

type Gesture =
    | Readonly<{ phase: 'trace' }>
    | Readonly<{ phase: 'press' | 'drag'; start: SelectionPoint; pointerId: number;
        under: CaptureSelectionWindow | null; hit: Promise<CaptureSelectionWindow | null> }>
    | Readonly<{ phase: 'position'; point: SelectionPoint }>
    | Readonly<{ phase: 'region'; start: SelectionPoint; point: SelectionPoint;
        under: CaptureSelectionWindow | null; hit: Promise<CaptureSelectionWindow | null> }>
    | Readonly<{ phase: 'resolve' | 'done' }>;

const sizeText = (rect: SelectionRect) => `${Math.round(rect.width)} × ${Math.round(rect.height)}`;
const place = (element: HTMLElement | null, rect: SelectionRect) => {
    if (!element) return;
    element.style.left = `${rect.x}px`;
    element.style.top = `${rect.y}px`;
    element.style.width = `${rect.width}px`;
    element.style.height = `${rect.height}px`;
};

/**
 * The full-display selection layer (lab `mp` H, `ws` H/D; MIS §1). One rectangle drives the dim, the
 * cut-out and its edge, so tracing and dragging write a few styles directly: a pointer move costs no
 * React render. Native facts arrive through props; nothing here decides what a window is.
 */
export function CaptureSelectionLayer(props: CaptureSelectionLayerProps) {
    return (
        <ScopedTheme name="dark">
            <SelectionSurface {...props} />
        </ScopedTheme>
    );
}

function SelectionSurface(props: CaptureSelectionLayerProps) {
    const { theme } = useUnistyles();
    const reducedMotion = useReducedMotionPreference();
    const { display, hitTest, onCancel, onCommit, windows } = props;
    const rootRef = React.useRef<HTMLDivElement | null>(null);
    const cutRef = React.useRef<HTMLDivElement | null>(null);
    const edgeRef = React.useRef<HTMLDivElement | null>(null);
    const lineRef = React.useRef<HTMLDivElement | null>(null);
    const labelRef = React.useRef<HTMLDivElement | null>(null);
    const labelNameRef = React.useRef<HTMLSpanElement | null>(null);
    const labelSizeRef = React.useRef<HTMLSpanElement | null>(null);
    const crossRef = React.useRef<HTMLDivElement | null>(null);
    const hintRef = React.useRef<HTMLDivElement | null>(null);
    const gesture = React.useRef<Gesture>({ phase: 'trace' });
    const hovered = React.useRef<CaptureSelectionWindow | null>(null);
    const hit = React.useRef<{ pending: SelectionPoint | null; running: Promise<void> | null }>({ pending: null, running: null });
    const hintEdgeRef = React.useRef<'top' | 'bottom'>('top');
    const [dragging, setDragging] = React.useState(false);
    const [hintEdge, setHintEdge] = React.useState<'top' | 'bottom'>('top');
    const [keyboardStage, setKeyboardStage] = React.useState<'position' | 'region' | undefined>();

    const motion = motionTokens.durationMs.fast;
    const curve = motionTokens.easingCss.standard;
    const edgeColor = theme.colors.overlay.foreground;
    const haloColor = theme.colors.shadow.color;
    const dimColor = `color-mix(in srgb, ${theme.colors.overlay.scrimWizard} ${motionTokens.overlay.modal.backdropMaxOpacity * 100}%, transparent)`;

    const retargets = (animated: boolean) => {
        const cut = cutRef.current;
        if (!cut) return;
        cut.style.transition = animated && !reducedMotion
            ? ['left', 'top', 'width', 'height', 'border-radius'].map((property) => `${property} ${motion}ms ${curve}`).join(', ')
            : 'none';
    };

    const showLabel = (name: string | null, rect: SelectionRect, position: SelectionPoint | null) => {
        const label = labelRef.current;
        if (!label || !labelNameRef.current || !labelSizeRef.current) return;
        labelNameRef.current.textContent = name ? `${name} · ` : '';
        labelSizeRef.current.textContent = sizeText(rect);
        label.style.opacity = position === null ? '0' : '1';
        if (position) {
            label.style.left = `${position.x}px`;
            label.style.top = `${position.y}px`;
        }
    };

    const traceWindow = React.useCallback((window: CaptureSelectionWindow | null) => {
        hovered.current = window;
        const cut = cutRef.current;
        const edge = edgeRef.current;
        if (!cut || !edge) return;
        retargets(true);
        cut.style.borderRadius = window ? `${theme.borderRadius.md}px` : '0px';
        edge.style.opacity = window ? '1' : '0';
        if (window) {
            place(cut, window.frame);
            showLabel(window.appName, window.frame, {
                x: window.frame.x + LABEL_WINDOW_INSET_PT,
                y: window.frame.y + LABEL_WINDOW_INSET_PT,
            });
        } else {
            place(cut, EMPTY_RECT);
            showLabel(null, EMPTY_RECT, null);
        }
        // `retargets` and `showLabel` only write through refs.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [theme.borderRadius.md, reducedMotion]);

    const requestHit = React.useCallback((point: SelectionPoint) => {
        // Latest wins with one native call in flight: a fast pointer never queues hit tests.
        const run = (next: SelectionPoint) => {
            const running = hitTest(next).then((window) => {
                const pending = hit.current.pending;
                hit.current = { pending: null, running: null };
                if (gesture.current.phase === 'trace' && window?.windowId !== hovered.current?.windowId) traceWindow(window);
                if (pending && gesture.current.phase === 'trace') run(pending);
            }, () => { hit.current = { pending: null, running: null }; });
            hit.current = { pending: null, running };
        };
        if (hit.current.running) hit.current.pending = point;
        else run(point);
    }, [hitTest, traceWindow]);

    const moveCross = (point: SelectionPoint) => {
        const cross = crossRef.current;
        if (cross) cross.style.transform = `translate(${point.x - CROSS_SIZE_PT / 2}px, ${point.y - CROSS_SIZE_PT / 2}px)`;
    };

    React.useLayoutEffect(() => {
        rootRef.current?.focus({ preventScroll: true });
        if (props.initialPointer) {
            moveCross(props.initialPointer);
            requestHit(props.initialPointer);
        }
        if (reducedMotion) return;
        rootRef.current?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: motion, easing: curve });
        hintRef.current?.animate(
            [{ opacity: 0, translate: `0 -${motionTokens.overlay.popover.fromDistance}px` }, { opacity: 1, translate: '0 0' }],
            { duration: motionTokens.overlay.popover.enterMs, easing: curve },
        );
        // The layer arrives once; a new operation mounts a new layer.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    React.useEffect(() => () => { gesture.current = { phase: 'done' }; }, []);

    const leave = React.useCallback(() => {
        if (gesture.current.phase === 'done') return;
        const current = gesture.current;
        if ((current.phase === 'press' || current.phase === 'drag') && rootRef.current?.hasPointerCapture?.(current.pointerId)) {
            rootRef.current.releasePointerCapture(current.pointerId);
        }
        gesture.current = { phase: 'done' };
        const root = rootRef.current;
        if (reducedMotion || !root) {
            onCancel();
            return;
        }
        const exit = root.animate([{ opacity: 1 }, { opacity: 0 }], {
            duration: motion, easing: motionTokens.easingCss.exit, fill: 'forwards',
        });
        void exit.finished.finally(onCancel);
    }, [curve, motion, onCancel, reducedMotion]);

    useEscapeLayer({
        priority: ESCAPE_LAYER_PRIORITIES.modal,
        enabled: true,
        onEscape: () => {
            leave();
            return true;
        },
    });

    const commitWindow = (window: CaptureSelectionWindow) => {
        gesture.current = { phase: 'done' };
        retargets(true);
        place(cutRef.current, window.frame);
        onCommit({ kind: 'window', window });
    };

    const pointOf = (event: React.PointerEvent) => {
        const bounds = rootRef.current!.getBoundingClientRect();
        return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
    };

    const updateHintEdge = (area: SelectionRect | null) => {
        const hint = hintRef.current;
        if (!hint) return;
        const next = resolveSelectionHintEdge(area, {
            x: hint.offsetLeft, y: hint.offsetTop, width: hint.offsetWidth, height: hint.offsetHeight,
        });
        if (next !== hintEdgeRef.current) {
            hintEdgeRef.current = next;
            setHintEdge(next);
        }
    };

    const paintArea = (start: SelectionPoint, point: SelectionPoint, under: CaptureSelectionWindow | null) => {
        retargets(false);
        if (cutRef.current) cutRef.current.style.borderRadius = '0px';
        if (edgeRef.current) edgeRef.current.style.opacity = '1';
        const area = dragRectWithinDisplay(start, point, display);
        place(cutRef.current, area);
        const corner = clampSelectionPoint(point, display);
        const label = labelRef.current;
        showLabel(under?.appName ?? null, area, label
            ? resolveSelectionLabelPosition(area, corner, { width: label.offsetWidth, height: label.offsetHeight }, display, LABEL_EDGE_PT)
            : null);
        updateHintEdge(area);
    };

    const hitAtStart = (start: SelectionPoint) => {
        // A press is not the previous hover. Finish the in-flight native read,
        // then resolve this exact start point, without a second concurrent call.
        hit.current.pending = null;
        const pending = hit.current.running;
        const read = () => gesture.current.phase === 'done' ? null : hitTest(start);
        return (pending ? pending.then(read) : Promise.resolve(read())).catch(() => null);
    };

    const onPointerMove = (event: React.PointerEvent) => {
        const current = gesture.current;
        if (current.phase !== 'trace' && current.phase !== 'press' && current.phase !== 'drag') return;
        const point = pointOf(event);
        moveCross(point);
        if (current.phase === 'trace') { requestHit(point); return; }
        if (current.phase === 'press') {
            if (Math.hypot(point.x - current.start.x, point.y - current.start.y) <= motionTokens.gesture.slopPx) return;
            gesture.current = { ...current, phase: 'drag' };
            setDragging(true);
        }
        paintArea(current.start, point, current.under);
    };

    const onPointerDown = (event: React.PointerEvent) => {
        if (event.button !== 0 || gesture.current.phase !== 'trace') return;
        const start = pointOf(event);
        rootRef.current?.setPointerCapture(event.pointerId);
        const result = hitAtStart(start);
        gesture.current = { phase: 'press', start, pointerId: event.pointerId, under: null, hit: result };
        void result.then(under => {
            const current = gesture.current;
            if ((current.phase !== 'press' && current.phase !== 'drag') || current.start !== start) return;
            gesture.current = { ...current, under };
            if (lineRef.current && under) { place(lineRef.current, under.frame); lineRef.current.style.opacity = '1'; }
        });
        // The window's cut-out closes onto the pointer (MIS §1.3).
        retargets(true);
        place(cutRef.current, { ...start, width: 0, height: 0 });
    };

    const onPointerUp = (event: React.PointerEvent) => {
        const current = gesture.current;
        if ((current.phase !== 'press' && current.phase !== 'drag') || event.pointerId !== current.pointerId) return;
        rootRef.current?.releasePointerCapture(event.pointerId);
        const end = pointOf(event);
        const area = dragRectWithinDisplay(current.start, end, display);
        const resolving = { phase: 'resolve' } as const;
        gesture.current = resolving;
        void current.hit.then(under => {
            if (gesture.current !== resolving) return;
            if (current.phase === 'drag' && classifySelectionRelease(area, motionTokens.gesture.slopPx) === 'drag') {
                gesture.current = { phase: 'done' };
                // Native owns clamp/normalization and the drag-start provenance.
                onCommit({ kind: 'rect', rect: { x: current.start.x, y: current.start.y,
                    width: end.x-current.start.x, height: end.y-current.start.y }, under });
            } else if (under) { commitWindow(under); }
            else {
                gesture.current = { phase: 'trace' };
                if (lineRef.current) lineRef.current.style.opacity = '0';
                setDragging(false);
                updateHintEdge(null);
                traceWindow(null);
            }
        });
    };

    const onKeyDown = (event: React.KeyboardEvent) => {
        if (event.target !== event.currentTarget) return;
        const current = gesture.current;
        if (current.phase === 'position' || current.phase === 'region') {
            const directions: Partial<Record<string, SelectionPoint>> = {
                ArrowLeft: { x: -1, y: 0 }, ArrowRight: { x: 1, y: 0 },
                ArrowUp: { x: 0, y: -1 }, ArrowDown: { x: 0, y: 1 },
            };
            const delta = directions[event.key];
            if (delta) {
                event.preventDefault();
                const point = clampSelectionPoint({ x: current.point.x + delta.x, y: current.point.y + delta.y }, display);
                gesture.current = { ...current, point };
                moveCross(point);
                if (current.phase === 'region') paintArea(current.start, point, current.under);
            } else if (event.key === 'Enter' && !event.repeat) {
                event.preventDefault();
                if (current.phase === 'position') {
                    const start = current.point;
                    const result = hitAtStart(start);
                    gesture.current = { phase: 'region', start, point: start, under: null, hit: result };
                    setKeyboardStage('region');
                    paintArea(start, start, null);
                    void result.then(under => {
                        const region = gesture.current;
                        if (region.phase !== 'region' || region.start !== start) return;
                        gesture.current = { ...region, under };
                        paintArea(start, region.point, under);
                    });
                } else {
                    const rect = dragRectWithinDisplay(current.start, current.point, display);
                    if (!rect.width || !rect.height) return;
                    const resolving = { phase: 'resolve' } as const;
                    gesture.current = resolving;
                    void current.hit.then(under => {
                        if (gesture.current !== resolving) return;
                        gesture.current = { phase: 'done' };
                        // As for a pointer drag, preserve the first corner so
                        // native text provenance is not moved by normalization.
                        onCommit({ kind: 'rect', rect: { x: current.start.x, y: current.start.y,
                            width: current.point.x-current.start.x, height: current.point.y-current.start.y }, under });
                    });
                }
            }
            return;
        }
        if (current.phase !== 'trace') return;
        if (event.key.toLowerCase() === 'r' && !event.ctrlKey && !event.metaKey && !event.altKey) {
            event.preventDefault();
            const point = clampSelectionPoint(props.initialPointer ?? { x: display.width / 2, y: display.height / 2 }, display);
            gesture.current = { phase: 'position', point };
            setKeyboardStage('position');
            traceWindow(null);
            moveCross(point);
            return;
        }
        if (event.key === 'Enter' && hovered.current) {
            event.preventDefault();
            commitWindow(hovered.current);
        } else if (event.key === 'Tab' && windows.length > 0) {
            event.preventDefault();
            const index = windows.findIndex((window) => window.windowId === hovered.current?.windowId);
            const step = event.shiftKey ? windows.length - 1 : 1;
            traceWindow(windows[(index + step) % windows.length] ?? null);
        } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            event.preventDefault();
            props.onModeChange(props.mode === 'still' ? 'recording' : 'still');
        }
    };

    const hintTop = Math.max(props.safeAreaTop + theme.space.s8, HINT_EDGE_PT);
    return (
        <div
            ref={rootRef}
            role="application"
            aria-label={t('screenCapture.selection.label')}
            aria-keyshortcuts="R"
            tabIndex={-1}
            data-testid={props.testID ?? 'capture-selection-layer'}
            onPointerMove={onPointerMove}
            onPointerDown={onPointerDown}
            onPointerUp={onPointerUp}
            onPointerCancel={leave}
            onContextMenu={(event) => {
                event.preventDefault();
                leave();
            }}
            onKeyDown={onKeyDown}
            style={{ position: 'absolute', inset: 0, overflow: 'hidden', cursor: 'none', outline: 'none', userSelect: 'none', touchAction: 'none' }}
        >
            <div
                ref={lineRef}
                aria-hidden
                style={{
                    position: 'absolute', opacity: 0, pointerEvents: 'none', borderRadius: theme.borderRadius.md,
                    boxShadow: `0 0 0 1px color-mix(in srgb, ${edgeColor} 38%, transparent)`, zIndex: 2,
                    transition: reducedMotion ? 'none' : `opacity ${motion}ms ${curve}`,
                }}
            />
            <div
                ref={cutRef}
                aria-hidden
                style={{ position: 'absolute', left: 0, top: 0, width: 0, height: 0, pointerEvents: 'none', boxShadow: `0 0 0 100vmax ${dimColor}` }}
            >
                <div
                    ref={edgeRef}
                    style={{
                        position: 'absolute', inset: 0, opacity: 0, borderRadius: 'inherit',
                        boxShadow: `0 0 0 1.5px ${edgeColor}, 0 0 0 2.5px color-mix(in srgb, ${haloColor} 30%, transparent)`,
                    }}
                />
            </div>
            <div
                ref={labelRef}
                aria-hidden={!keyboardStage}
                role={keyboardStage ? 'status' : undefined}
                aria-live={keyboardStage ? 'polite' : undefined}
                aria-atomic={keyboardStage ? true : undefined}
                style={{
                    position: 'absolute', opacity: 0, pointerEvents: 'none', whiteSpace: 'pre', zIndex: 3,
                    height: 26, borderRadius: 13, paddingLeft: theme.space.s10, paddingRight: theme.space.s10,
                    display: 'inline-flex', alignItems: 'center', backgroundColor: theme.colors.overlay.scrimStrong,
                    color: edgeColor, ...Typography.variant('meta'),
                }}
            >
                <span ref={labelNameRef} style={{ fontFamily: Typography.default().fontFamily }} />
                <span ref={labelSizeRef} style={{ fontFamily: Typography.mono().fontFamily, fontVariantNumeric: 'tabular-nums' }} />
            </div>
            <div
                ref={hintRef}
                style={{
                    position: 'absolute', left: '50%', top: hintTop, zIndex: 3, cursor: 'default',
                    transform: `translate(-50%, ${hintEdge === 'bottom' ? display.height - hintTop - HINT_EDGE_PT - (hintRef.current?.offsetHeight ?? 0) : 0}px)`,
                    opacity: dragging ? 0.55 : 1,
                    transition: reducedMotion ? 'none' : `transform ${motion}ms ${curve}, opacity ${motion}ms ${curve}`,
                }}
                onPointerDown={(event) => event.stopPropagation()}
                onPointerUp={(event) => event.stopPropagation()}
            >
                <CaptureSelectionHint
                    mode={props.mode}
                    onModeChange={props.onModeChange}
                    shortcutLabel={props.shortcutLabel}
                    dragging={dragging}
                    keyboardStage={keyboardStage}
                    onCancel={leave}
                />
            </div>
            <div
                ref={crossRef}
                aria-hidden
                style={{ position: 'absolute', left: 0, top: 0, width: CROSS_SIZE_PT, height: CROSS_SIZE_PT, pointerEvents: 'none', zIndex: 4 }}
            >
                {[{ left: 10.25, top: 0, width: 1.5, height: CROSS_SIZE_PT }, { left: 0, top: 10.25, width: CROSS_SIZE_PT, height: 1.5 }].map((bar) => (
                    <span
                        key={bar.left}
                        style={{ position: 'absolute', ...bar, backgroundColor: edgeColor, boxShadow: `0 0 0 1px color-mix(in srgb, ${haloColor} 40%, transparent)` }}
                    />
                ))}
            </div>
        </div>
    );
}
