import * as React from 'react';
import { View, type GestureResponderEvent, type LayoutChangeEvent } from 'react-native';
import type { MachineLiveStreamControlSidebandV1, SimulatorOrientationV1, SimulatorPreviewRectV1 } from '@happier-dev/protocol';

import { buildSimulatorPreviewControl } from '@/sync/domains/devices/simulator/control';
import type { SimulatorPreviewViewModel } from '@/sync/domains/devices/simulator/types';

import { simulatorStreamStyles } from './styles';

type KeyboardEventLike = Readonly<{
    key?: string;
    nativeEvent?: Readonly<{ key?: string }>;
    preventDefault?: () => void;
    stopPropagation?: () => void;
}>;

type InputPoint = Readonly<{ x: number; y: number }>;

type GestureState = Readonly<{
    startedAtMs: number;
    start: InputPoint;
    latest: InputPoint;
    multiStart?: readonly [InputPoint, InputPoint];
    multiLatest?: readonly [InputPoint, InputPoint];
}>;

const MOVE_THRESHOLD_PX = 12;
const LONG_PRESS_THRESHOLD_MS = 500;
const PINCH_DISTANCE_THRESHOLD_PX = 8;
const ROTATE_ANGLE_THRESHOLD_RADIANS = 0.1;

function resolveSourceAndStream(viewModel: SimulatorPreviewViewModel): Readonly<{ sourceId: string; streamId: string }> | null {
    const sourceId = viewModel.resource?.capture.status === 'unavailable'
        ? viewModel.activeLease?.sourceId
        : viewModel.resource?.capture.sourceId;
    const streamId = viewModel.stream.streamId ?? viewModel.activeLease?.streamId;
    if (!sourceId || !streamId) return null;
    return { sourceId, streamId };
}

function supports(viewModel: SimulatorPreviewViewModel, kind: MachineLiveStreamControlSidebandV1['kind']): boolean {
    return viewModel.controls.supportedInputKinds.includes(kind);
}

function resourceAllowsInput(viewModel: SimulatorPreviewViewModel): boolean {
    return !!viewModel.resource
        && viewModel.resource.capture.status !== 'unavailable'
        && viewModel.resource.capture.inputMode !== 'none';
}

function canAcceptInput(viewModel: SimulatorPreviewViewModel): boolean {
    return resourceAllowsInput(viewModel)
        && viewModel.controls.canControl
        && viewModel.controls.supportedInputKinds.length > 0;
}

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

function distance(left: InputPoint, right: InputPoint): number {
    return Math.hypot(right.x - left.x, right.y - left.y);
}

function angle(left: InputPoint, right: InputPoint): number {
    return Math.atan2(right.y - left.y, right.x - left.x);
}

function midpoint(left: InputPoint, right: InputPoint): InputPoint {
    return {
        x: (left.x + right.x) / 2,
        y: (left.y + right.y) / 2,
    };
}

function normalizePoint(point: InputPoint, viewport: Readonly<{ width: number; height: number }>): InputPoint {
    return {
        x: point.x / viewport.width,
        y: point.y / viewport.height,
    };
}

export function SimulatorInputLayer(props: Readonly<{
    viewModel: SimulatorPreviewViewModel;
    viewport?: Readonly<{ width: number; height: number }>;
    content?: SimulatorPreviewRectV1;
    orientation?: SimulatorOrientationV1;
    onSendControl: (control: MachineLiveStreamControlSidebandV1) => void;
    testID: string;
}>): React.ReactElement {
    const focusedRef = React.useRef(false);
    const gestureRef = React.useRef<GestureState | null>(null);
    const [measuredViewport, setMeasuredViewport] = React.useState<Readonly<{ width: number; height: number }>>(
        props.viewport ?? { width: 1, height: 1 },
    );
    const viewport = props.viewport ?? measuredViewport;
    const content = props.content ?? { x: 0, y: 0, width: viewport.width, height: viewport.height };
    const orientation = props.orientation ?? 'portrait';
    const sourceAndStream = resolveSourceAndStream(props.viewModel);
    const inputAccepted = canAcceptInput(props.viewModel);

    const sendAction = React.useCallback((input: Readonly<{
        eventId: string;
        action: Parameters<typeof buildSimulatorPreviewControl>[0]['action'];
    }>) => {
        if (!inputAccepted || !sourceAndStream) return;
        const result = buildSimulatorPreviewControl({
            streamId: sourceAndStream.streamId,
            sourceId: sourceAndStream.sourceId,
            viewerId: props.viewModel.viewerId,
            eventId: input.eventId,
            activeLease: props.viewModel.activeLease,
            action: input.action,
        });
        if (result.ok) props.onSendControl(result.control);
    }, [inputAccepted, props, sourceAndStream]);

    const handleLayout = React.useCallback((event: LayoutChangeEvent) => {
        if (props.viewport) return;
        const { width, height } = event.nativeEvent.layout;
        if (width > 0 && height > 0) setMeasuredViewport({ width, height });
    }, [props.viewport]);

    const handleGrant = React.useCallback((event: GestureResponderEvent) => {
        const point = readEventPoint(event);
        const multi = readMultiTouch(event);
        gestureRef.current = {
            startedAtMs: readTimestampMs(event),
            start: point,
            latest: point,
            ...(multi ? { multiStart: multi, multiLatest: multi } : {}),
        };
    }, []);

    const handleMove = React.useCallback((event: GestureResponderEvent) => {
        const previous = gestureRef.current;
        if (!previous) return;
        const point = readEventPoint(event);
        const multi = readMultiTouch(event);
        gestureRef.current = {
            ...previous,
            latest: point,
            ...(multi ? { multiLatest: multi } : {}),
        };
    }, []);

    const handleRelease = React.useCallback((event: GestureResponderEvent) => {
        const releasedAtMs = readTimestampMs(event);
        const fallbackPoint = readEventPoint(event);
        const gesture = gestureRef.current ?? {
            startedAtMs: releasedAtMs,
            start: fallbackPoint,
            latest: fallbackPoint,
        };
        gestureRef.current = null;

        if (gesture.multiStart && gesture.multiLatest) {
            const startCenter = midpoint(gesture.multiStart[0], gesture.multiStart[1]);
            const latestCenter = midpoint(gesture.multiLatest[0], gesture.multiLatest[1]);
            const startDistance = distance(gesture.multiStart[0], gesture.multiStart[1]);
            const latestDistance = distance(gesture.multiLatest[0], gesture.multiLatest[1]);
            const startAngle = angle(gesture.multiStart[0], gesture.multiStart[1]);
            const latestAngle = angle(gesture.multiLatest[0], gesture.multiLatest[1]);
            if (supports(props.viewModel, 'pinch') && Math.abs(latestDistance - startDistance) >= PINCH_DISTANCE_THRESHOLD_PX) {
                sendAction({
                    eventId: `pinch:${Date.now()}`,
                    action: {
                        kind: 'pinch',
                        center: normalizePoint(latestCenter, viewport),
                        startDistance,
                        endDistance: latestDistance,
                        angle: latestAngle,
                        durationMs: Math.max(0, releasedAtMs - gesture.startedAtMs),
                        orientation,
                        viewport,
                        content,
                    },
                });
                return;
            }
            if (supports(props.viewModel, 'rotate') && Math.abs(latestAngle - startAngle) >= ROTATE_ANGLE_THRESHOLD_RADIANS) {
                sendAction({
                    eventId: `rotate:${Date.now()}`,
                    action: {
                        kind: 'rotate',
                        center: normalizePoint(startCenter, viewport),
                        radius: startDistance / 2,
                        startAngle,
                        endAngle: latestAngle,
                        durationMs: Math.max(0, releasedAtMs - gesture.startedAtMs),
                        orientation,
                        viewport,
                        content,
                    },
                });
                return;
            }
        }

        const latest = gesture.latest;
        const movedDistance = distance(gesture.start, latest);
        const durationMs = Math.max(0, releasedAtMs - gesture.startedAtMs);
        if (movedDistance >= MOVE_THRESHOLD_PX) {
            const kind = supports(props.viewModel, 'swipe')
                ? 'swipe'
                : supports(props.viewModel, 'drag')
                    ? 'drag'
                    : null;
            if (kind) {
                sendAction({
                    eventId: `${kind}:${Date.now()}`,
                    action: {
                        kind,
                        from: normalizePoint(gesture.start, viewport),
                        to: normalizePoint(latest, viewport),
                        durationMs,
                        orientation,
                        viewport,
                        content,
                    },
                });
                return;
            }
        }

        if (durationMs >= LONG_PRESS_THRESHOLD_MS && supports(props.viewModel, 'long_press')) {
            sendAction({
                eventId: `long_press:${Date.now()}`,
                action: {
                    kind: 'long_press',
                    point: normalizePoint(latest, viewport),
                    durationMs,
                    orientation,
                    viewport,
                    content,
                },
            });
            return;
        }

        if (!supports(props.viewModel, 'tap')) return;
        sendAction({
            eventId: `tap:${Date.now()}`,
            action: {
                kind: 'tap',
                point: normalizePoint(fallbackPoint, viewport),
                orientation,
                viewport,
                content,
            },
        });
    }, [content, orientation, props.viewModel, sendAction, viewport]);

    const handleKeyDown = React.useCallback((event: KeyboardEventLike) => {
        if (!focusedRef.current || !inputAccepted) return;
        const key = event.key ?? event.nativeEvent?.key;
        if (!key) return;
        if (key.length === 1 && supports(props.viewModel, 'keyboard_text')) {
            sendAction({ eventId: `keyboard_text:${Date.now()}`, action: { kind: 'keyboard_text', text: key } });
            event.preventDefault?.();
            event.stopPropagation?.();
            return;
        }
        if (supports(props.viewModel, 'keyboard_key')) {
            sendAction({ eventId: `keyboard_key:${Date.now()}`, action: { kind: 'keyboard_key', key } });
            event.preventDefault?.();
            event.stopPropagation?.();
        }
    }, [inputAccepted, props.viewModel, sendAction]);

    const keyboardProps: Record<string, unknown> = {
        onKeyDown: handleKeyDown,
    };

    return (
        <View
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
            onStartShouldSetResponder={() => inputAccepted}
            style={simulatorStreamStyles.inputLayer}
            testID={`${props.testID}-capture`}
        />
    );
}
