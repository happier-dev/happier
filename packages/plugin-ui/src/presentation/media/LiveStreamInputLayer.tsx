import * as React from 'react';
import { Platform, StyleSheet, View, type GestureResponderEvent, type LayoutChangeEvent, type ViewStyle } from 'react-native';
import type { HappierLiveStreamInputGesture, HappierLiveStreamInputControlKind, HappierLiveStreamOrientation, HappierLiveStreamRect } from './inputGesture.js';
import type { HappierStyleProp } from '../portableTypes.js';
import type { HappierLiveStreamInputMode, HappierLiveStreamViewTransform } from './inputGesture.js';
import { createLiveStreamGestureMapper } from './gestureMapping.js';
import { HAPPIER_GESTURE_TIMING } from './inputGesture.js';

type KeyboardEventLike = Readonly<{
    key?: string;
    shiftKey?: boolean;
    ctrlKey?: boolean;
    metaKey?: boolean;
    altKey?: boolean;
    isComposing?: boolean;
    nativeEvent?: Readonly<{ key?: string; shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; isComposing?: boolean }>;
    preventDefault?: () => void;
    stopPropagation?: () => void;
}>;

type InputPoint = Readonly<{ x: number; y: number }>;

type WheelEventLike = Readonly<{
    nativeEvent: Readonly<{ clientX: number; clientY: number; deltaX: number; deltaY: number; deltaMode: number }>;
    currentTarget: Pick<Element, 'getBoundingClientRect'>;
    preventDefault: () => void;
    stopPropagation: () => void;
}>;

function readTimestampMs(event: GestureResponderEvent): number {
    const timestamp = (event.nativeEvent as { timestamp?: unknown }).timestamp;
    return typeof timestamp === 'number' && Number.isFinite(timestamp) ? timestamp : Date.now();
}

function readEventPoint(event: GestureResponderEvent): InputPoint {
    return {
        x: event.nativeEvent.locationX,
        y: event.nativeEvent.locationY,
    };
}

function readTouchPoint(value: unknown): InputPoint | null {
    if (!value || typeof value !== 'object') return null;
    const maybe = value as { locationX?: unknown; locationY?: unknown; pageX?: unknown; pageY?: unknown };
    const x = typeof maybe.locationX === 'number' ? maybe.locationX : maybe.pageX;
    const y = typeof maybe.locationY === 'number' ? maybe.locationY : maybe.pageY;
    return typeof x === 'number' && typeof y === 'number' ? { x, y } : null;
}

function readMultiTouch(event: GestureResponderEvent): readonly [InputPoint, InputPoint] | undefined {
    const touches = (event.nativeEvent as { touches?: unknown }).touches;
    if (!Array.isArray(touches) || touches.length < 2) return undefined;
    const first = readTouchPoint(touches[0]);
    const second = readTouchPoint(touches[1]);
    return first && second ? [first, second] : undefined;
}

// The capture owns every touch on the picture: a pinch or pan zooms or moves the viewer's picture (or reaches the
// source), never the app page around it.
const layerStyle = StyleSheet.create({
    layer: { flex: 1, minHeight: 0, ...(Platform.OS === 'web' ? { touchAction: 'none' } as unknown as ViewStyle : null) },
}).layer;

/**
 * The one viewer-input surface over a live stream: it turns pointer, touch and keyboard input into
 * {@link HappierLiveStreamInputGesture}s (tap, long press, swipe/drag, wheel, pinch, rotate, text, keys).
 * What a gesture means for a source — a simulator's lease-scoped device controls, the agent's
 * browser's registered controls — is the caller's `onGesture`.
 */
export function HappierLiveStreamInputLayer(props: Readonly<{
    /** Whether the viewer may send input right now (the source accepts it and the viewer drives). */
    inputAccepted: boolean;
    mode?: HappierLiveStreamInputMode;
    /** Browser/computer picture zoom; simulator pinch remains remote. */
    localZoom?: boolean;
    zoomReset?: number;
    /** Where the local view rests and Reset returns (default: the whole picture). */
    restTransform?: HappierLiveStreamViewTransform;
    /** A zoomed-in picture pans under one finger instead of sending a swipe (a viewer who only watches). */
    dragPansView?: boolean;
    onViewTransformChange?: (transform: HappierLiveStreamViewTransform) => void;
    renderCursor?: (position: InputPoint) => React.ReactNode;
    renderDragTrail?: (points: readonly InputPoint[]) => React.ReactNode;
    /** Which gesture kinds the source supports. */
    supports: (kind: HappierLiveStreamInputControlKind) => boolean;
    viewport?: Readonly<{ width: number; height: number }>;
    content?: HappierLiveStreamRect;
    orientation?: HappierLiveStreamOrientation;
    onGesture: (input: Readonly<{ eventId: string; action: HappierLiveStreamInputGesture }>) => void;
    /** Clipboard gestures stay with the focused host, which owns its clipboard and input relay. */
    onClipboardShortcut?: (action: 'copy' | 'cut' | 'paste') => void;
    /** Host files dropped on this picture; the source owns transfer and authorization. */
    onFileDrop?: (files: readonly File[], point: InputPoint) => void;
    /** Visual treatment of the capture surface (the simulator tints it; a browser stays clear). */
    style?: HappierStyleProp;
    accessibilityLabel?: string;
    testID: string;
}>): React.ReactElement {
    const focusedRef = React.useRef(false);
    const captureRef = React.useRef<View>(null);
    const mapperRef = React.useRef<ReturnType<typeof createLiveStreamGestureMapper> | null>(null);
    if (!mapperRef.current) mapperRef.current = createLiveStreamGestureMapper();
    const [cursor, setCursor] = React.useState<InputPoint>({ x: (props.viewport?.width ?? 1) / 2, y: (props.viewport?.height ?? 1) / 2 });
    const [dragTrail, setDragTrail] = React.useState<readonly InputPoint[]>([]);
    const pendingTap = React.useRef<{ action: Extract<HappierLiveStreamInputGesture, { kind: 'tap' }>; timer: ReturnType<typeof setTimeout> } | null>(null);
    const pendingFrame = React.useRef<number | null>(null);
    const pendingMove = React.useRef<HappierLiveStreamInputGesture | null>(null);
    const pendingVisuals = React.useRef<ReturnType<ReturnType<typeof createLiveStreamGestureMapper>['map']> | null>(null);
    const sequence = React.useRef(0);
    const [measuredViewport, setMeasuredViewport] = React.useState<Readonly<{ width: number; height: number }>>(
        props.viewport ?? { width: 1, height: 1 },
    );
    const viewport = props.viewport ?? measuredViewport;
    const content = React.useMemo(() => props.content ?? { x: 0, y: 0, width: viewport.width, height: viewport.height }, [props.content, viewport]);
    const orientation = props.orientation ?? 'portrait';
    const inputAccepted = props.inputAccepted;
    const supports = props.supports;
    const onGesture = props.onGesture;
    const gestureCallback = React.useRef(onGesture);
    gestureCallback.current = onGesture;
    const acceptedRef = React.useRef(inputAccepted);
    acceptedRef.current = inputAccepted;

    const sendAction = React.useCallback((input: Readonly<{
        eventId: string;
        action: HappierLiveStreamInputGesture;
    }>) => {
        if (!acceptedRef.current) return;
        gestureCallback.current(input);
    }, []);

    const handleLayout = React.useCallback((event: LayoutChangeEvent) => {
        if (props.viewport) return;
        const { width, height } = event.nativeEvent.layout;
        if (width > 0 && height > 0) setMeasuredViewport({ width, height });
    }, [props.viewport]);

    const context = { viewport, content, orientation, mode: props.mode ?? 'direct', localZoom: props.localZoom === true,
        dragPans: props.dragPansView === true, supports } as const;
    const latestContext = React.useRef(context);
    latestContext.current = context;
    const publishVisuals = React.useCallback((result: ReturnType<NonNullable<typeof mapperRef.current>['map']>) => {
        const current = latestContext.current;
        const point = { x: (current.content.x + result.pointer.x * current.content.width) * result.transform.scale + result.transform.x,
            y: (current.content.y + result.pointer.y * current.content.height) * result.transform.scale + result.transform.y };
        setCursor(previous => previous.x === point.x && previous.y === point.y ? previous : point);
        setDragTrail(previous => result.trail.length ? result.trail.map(position => ({
            x: position.x * current.viewport.width * result.transform.scale + result.transform.x,
            y: position.y * current.viewport.height * result.transform.scale + result.transform.y,
        })) : previous.length ? [] : previous);
        props.onViewTransformChange?.(result.transform);
    }, [props.onViewTransformChange]);
    const emit = React.useCallback((action: HappierLiveStreamInputGesture) => {
        sendAction({ eventId: `${action.kind}:${Date.now()}:${++sequence.current}`, action });
    }, [sendAction]);
    const flushMove = React.useCallback(() => {
        if (pendingFrame.current !== null) cancelAnimationFrame(pendingFrame.current);
        pendingFrame.current = null;
        const action = pendingMove.current;
        pendingMove.current = null;
        const visuals = pendingVisuals.current;
        pendingVisuals.current = null;
        if (visuals) publishVisuals(visuals);
        if (action) emit(action);
    }, [emit, publishVisuals]);
    const queueMove = React.useCallback((action: HappierLiveStreamInputGesture | null) => {
        if (action) pendingMove.current = action;
        if (pendingFrame.current !== null) return;
        pendingFrame.current = requestAnimationFrame(() => { pendingFrame.current = null; flushMove(); });
    }, [flushMove]);
    const dispatchMapped = React.useCallback((result: ReturnType<NonNullable<typeof mapperRef.current>['map']>) => {
        pendingVisuals.current = result;
        if (result.actions.length === 0) queueMove(null);
        for (const action of result.actions) {
            if (action.kind === 'move' || action.kind === 'pointer' && action.phase === 'move') { queueMove(action); continue; }
            flushMove();
            if (action.kind === 'tap' && !action.button && (props.localZoom || props.mode === 'trackpad')) {
                const previous = pendingTap.current;
                if (previous) {
                    clearTimeout(previous.timer);
                    pendingTap.current = null;
                    const separation = Math.hypot((previous.action.point.x - action.point.x) * viewport.width,
                        (previous.action.point.y - action.point.y) * viewport.height);
                    if (separation <= HAPPIER_GESTURE_TIMING.slopPx) { emit({ ...action, clickCount: 2 }); continue; }
                    emit(previous.action);
                }
                pendingTap.current = { action, timer: setTimeout(() => {
                    pendingTap.current = null;
                    emit(action);
                }, HAPPIER_GESTURE_TIMING.doubleTapMs) };
            } else { emit(action); }
        }
    }, [emit, flushMove, props.localZoom, props.mode, publishVisuals, queueMove, viewport]);
    const restScale = props.restTransform?.scale ?? 1;
    const restX = props.restTransform?.x ?? 0;
    const restY = props.restTransform?.y ?? 0;
    // Before the reset below, so a reset in the same commit returns to the new resting view.
    React.useEffect(() => {
        publishVisuals(mapperRef.current!.setRestTransform({ scale: restScale, x: restX, y: restY }));
    }, [restScale, restX, restY, publishVisuals]);
    React.useEffect(() => { publishVisuals(mapperRef.current!.resetZoom()); }, [props.zoomReset, publishVisuals]);
    const handleInput = React.useCallback((phase: 'start' | 'move' | 'end' | 'cancel', event: GestureResponderEvent) => {
        if (!inputAccepted) return;
        dispatchMapped(mapperRef.current!.map({ phase, point: readEventPoint(event), at: readTimestampMs(event),
            touches: readMultiTouch(event) }, latestContext.current));
    }, [dispatchMapped, inputAccepted]);
    const handleGrant = React.useCallback((event: GestureResponderEvent) => {
        captureRef.current?.focus();
        handleInput('start', event);
    }, [handleInput]);
    const handleMove = React.useCallback((event: GestureResponderEvent) => handleInput('move', event), [handleInput]);
    const handleRelease = React.useCallback((event: GestureResponderEvent) => handleInput('end', event), [handleInput]);
    const handleCancel = React.useCallback((event: GestureResponderEvent) => handleInput('cancel', event), [handleInput]);
    React.useEffect(() => () => {
        if (pendingTap.current) clearTimeout(pendingTap.current.timer);
        pendingTap.current = null;
        if (pendingFrame.current !== null) cancelAnimationFrame(pendingFrame.current);
        pendingFrame.current = null;
        pendingMove.current = null;
        pendingVisuals.current = null;
        const cancelled = mapperRef.current!.map({ phase: 'cancel', point: { x: 0, y: 0 }, at: Date.now() }, latestContext.current);
        // Releasing an already-held browser button is cleanup even when input admission was withdrawn.
        for (const action of cancelled.actions) gestureCallback.current({ eventId: `cancel:${++sequence.current}`, action });
    }, [inputAccepted, props.mode]);

    const handleKeyDown = React.useCallback((event: KeyboardEventLike) => {
        if (!focusedRef.current || !inputAccepted) return;
        const key = event.key ?? event.nativeEvent?.key;
        if (!key) return;
        // Candidate keys belong to the local input method; only its committed text is relayed.
        if ((event.isComposing ?? event.nativeEvent?.isComposing) || key === 'Dead' || key === 'Process') return;
        // Keep the browser's reverse traversal available to leave the viewer; plain Tab stays guest input.
        if (key === 'Tab' && (event.shiftKey ?? event.nativeEvent?.shiftKey)) return;
        const command = (event.metaKey ?? event.nativeEvent?.metaKey) || (event.ctrlKey ?? event.nativeEvent?.ctrlKey);
        const clipboardAction = key.toLowerCase() === 'c' ? 'copy' : key.toLowerCase() === 'x' ? 'cut' : key.toLowerCase() === 'v' ? 'paste' : null;
        if (command && !(event.altKey ?? event.nativeEvent?.altKey) && clipboardAction) {
            if (props.onClipboardShortcut) {
                props.onClipboardShortcut(clipboardAction);
                event.preventDefault?.();
                event.stopPropagation?.();
            }
            return;
        }
        const modifiers = (['alt', 'control', 'meta', 'shift'] as const).filter(modifier => {
            const property = modifier === 'control' ? 'ctrlKey' : `${modifier}Key` as const;
            return event[property] ?? event.nativeEvent?.[property];
        });
        // Space is also activation/scroll input. Let the remote native focus decide its effect.
        if (key.length === 1 && key !== ' ' && !command && !modifiers.includes('alt') && supports('keyboard_text')) {
            sendAction({ eventId: `keyboard_text:${Date.now()}`, action: { kind: 'keyboard_text', text: key } });
            event.preventDefault?.();
            event.stopPropagation?.();
            return;
        }
        if (supports('keyboard_key')) {
            sendAction({ eventId: `keyboard_key:${Date.now()}`, action: { kind: 'keyboard_key', key,
                ...(modifiers.length ? { modifiers } : {}) } });
            event.preventDefault?.();
            event.stopPropagation?.();
        }
    }, [inputAccepted, props.onClipboardShortcut, sendAction, supports]);

    React.useEffect(() => {
        const target = captureRef.current as (View & Partial<Element>) | null;
        if (!inputAccepted || !supports('keyboard_text') || !target?.addEventListener || !target.removeEventListener) return;
        const listener = (event: Event) => {
            const text = (event as CompositionEvent).data;
            if (focusedRef.current && text) emit({ kind: 'keyboard_text', text });
        };
        target.addEventListener('compositionend', listener);
        return () => target.removeEventListener?.('compositionend', listener);
    }, [emit, inputAccepted, supports]);

    const handleWheel = React.useCallback((event: WheelEventLike) => {
        if (!inputAccepted || !supports('wheel')) return;
        const wheel = event.nativeEvent;
        const rect = event.currentTarget.getBoundingClientRect();
        let unitX = 1;
        let unitY = 1;
        if (wheel.deltaMode === 2) {
            unitX = viewport.width;
            unitY = viewport.height;
        } else if (wheel.deltaMode === 1 && typeof Element !== 'undefined' && event.currentTarget instanceof Element) {
            const style = getComputedStyle(event.currentTarget);
            const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize);
            if (Number.isFinite(lineHeight)) unitX = unitY = lineHeight;
        }
        sendAction({ eventId: `wheel:${Date.now()}`, action: { kind: 'wheel',
            point: mapperRef.current!.hover({ x: wheel.clientX - rect.left, y: wheel.clientY - rect.top }, latestContext.current).point,
            deltaX: wheel.deltaX * unitX, deltaY: wheel.deltaY * unitY, viewport, content, orientation } });
        event.preventDefault();
        event.stopPropagation();
    }, [content, inputAccepted, orientation, sendAction, supports, viewport]);

    React.useEffect(() => {
        // React's delegated wheel listener is passive. Bind at the DOM boundary so a consumed
        // viewer wheel cannot also scroll the host. Native Views do not expose this boundary.
        const target = captureRef.current as (View & Partial<Element>) | null;
        if (!target?.addEventListener || !target.removeEventListener || !target.getBoundingClientRect) return;
        const listener = (event: Event) => handleWheel({ nativeEvent: event as WheelEvent,
            // RNW supplies a DOM element at this guarded platform boundary.
            currentTarget: target as Element,
            preventDefault: () => event.preventDefault(), stopPropagation: () => event.stopPropagation() });
        target.addEventListener('wheel', listener, { passive: false });
        return () => target.removeEventListener?.('wheel', listener);
    }, [handleWheel]);

    React.useEffect(() => {
        const target = captureRef.current as (View & Partial<Element>) | null;
        if (!inputAccepted || !supports('move') || !target?.addEventListener || !target.removeEventListener || !target.getBoundingClientRect) return;
        const listener = (event: Event) => {
            const pointer = event as PointerEvent;
            if ((pointer.pointerType !== 'mouse' && pointer.pointerType !== 'pen') || pointer.buttons !== 0) return;
            const rect = target.getBoundingClientRect!();
            const result = mapperRef.current!.hover({ x: pointer.clientX - rect.left, y: pointer.clientY - rect.top }, latestContext.current);
            pendingVisuals.current = result;
            const current = latestContext.current;
            queueMove({ kind: 'move', point: result.point, viewport: current.viewport, content: current.content, orientation: current.orientation });
        };
        target.addEventListener('pointermove', listener);
        return () => {
            target.removeEventListener?.('pointermove', listener);
            if (pendingFrame.current !== null) cancelAnimationFrame(pendingFrame.current);
            pendingFrame.current = null;
            pendingMove.current = null;
        };
    }, [inputAccepted, queueMove, supports]);

    React.useEffect(() => {
        const target = captureRef.current as (View & Partial<Element>) | null;
        if (!props.onFileDrop || !target?.addEventListener || !target.removeEventListener || !target.getBoundingClientRect) return;
        const listener = (event: Event) => {
            const drag = event as DragEvent;
            if (!drag.dataTransfer?.types.includes('Files')) return;
            // Even a view-only picture must not navigate the enclosing app to an OS file.
            event.preventDefault();
            event.stopPropagation();
            if (event.type !== 'drop' || !inputAccepted) return;
            const files = Array.from(drag.dataTransfer.files);
            if (!files.length) return;
            const rect = target.getBoundingClientRect!();
            const point = mapperRef.current!.hover({ x: drag.clientX - rect.left, y: drag.clientY - rect.top }, latestContext.current).point;
            props.onFileDrop?.(files, point);
        };
        target.addEventListener('dragover', listener);
        target.addEventListener('drop', listener);
        return () => {
            target.removeEventListener?.('dragover', listener);
            target.removeEventListener?.('drop', listener);
        };
    }, [inputAccepted, props.onFileDrop]);

    const keyboardProps: Record<string, unknown> = {
        onKeyDown: handleKeyDown,
    };

    return (
        <View
            ref={captureRef}
            {...keyboardProps}
            accessible
            focusable
            onBlur={() => {
                focusedRef.current = false;
            }}
            onFocus={() => {
                focusedRef.current = true;
            }}
            onLayout={handleLayout}
            onResponderGrant={handleGrant}
            onResponderMove={handleMove}
            onResponderRelease={handleRelease}
            onResponderTerminate={handleCancel}
            onStartShouldSetResponder={() => inputAccepted}
            style={[layerStyle, props.style]}
            role="group"
            accessibilityLabel={props.accessibilityLabel}
            testID={`${props.testID}-capture`}
        >
            {props.renderDragTrail?.(dragTrail)}
            {props.renderCursor?.(cursor)}
        </View>
    );
}
