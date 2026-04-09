import * as React from 'react';
import { Keyboard, type GestureResponderEvent, type ViewProps } from 'react-native';

const TAP_MOVE_TOLERANCE_PX = 8;

type TapTrackingState = Readonly<{
    startX: number;
    startY: number;
    moved: boolean;
}>;

function readTouchPoint(event: GestureResponderEvent): Readonly<{ x: number; y: number }> | null {
    const { pageX, pageY } = event.nativeEvent;
    if (!Number.isFinite(pageX) || !Number.isFinite(pageY)) {
        return null;
    }
    return { x: pageX, y: pageY };
}

export function useKeyboardDismissOnTap(): Pick<ViewProps, 'onTouchStart' | 'onTouchMove' | 'onTouchEnd' | 'onTouchCancel'> {
    const tapStateRef = React.useRef<TapTrackingState | null>(null);

    const clearTapState = React.useCallback(() => {
        tapStateRef.current = null;
    }, []);

    const onTouchStart = React.useCallback((event: GestureResponderEvent) => {
        const point = readTouchPoint(event);
        tapStateRef.current = point
            ? { startX: point.x, startY: point.y, moved: false }
            : { startX: 0, startY: 0, moved: true };
    }, []);

    const onTouchMove = React.useCallback((event: GestureResponderEvent) => {
        const previous = tapStateRef.current;
        if (!previous || previous.moved) {
            return;
        }

        const point = readTouchPoint(event);
        if (!point) {
            tapStateRef.current = { ...previous, moved: true };
            return;
        }

        const moved =
            Math.abs(point.x - previous.startX) > TAP_MOVE_TOLERANCE_PX
            || Math.abs(point.y - previous.startY) > TAP_MOVE_TOLERANCE_PX;

        if (moved) {
            tapStateRef.current = { ...previous, moved: true };
        }
    }, []);

    const onTouchEnd = React.useCallback(() => {
        const previous = tapStateRef.current;
        tapStateRef.current = null;
        if (previous && previous.moved === false) {
            Keyboard.dismiss();
        }
    }, []);

    return React.useMemo(() => ({
        onTouchStart,
        onTouchMove,
        onTouchEnd,
        onTouchCancel: clearTapState,
    }), [clearTapState, onTouchEnd, onTouchMove, onTouchStart]);
}
