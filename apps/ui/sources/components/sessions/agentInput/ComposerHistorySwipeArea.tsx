import * as React from 'react';
import { Platform, View, type GestureResponderEvent } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

export type ComposerHistoryDirection = 'up' | 'down';

// A flick is a short, fast, mostly vertical stroke. A finger that rests or drags slowly takes longer than
// FLICK_MAX_DURATION_MS from touch-down to lift, so holding before moving, scrolling a long message and
// selecting text never count. The distance floor keeps taps and jitter out.
const FLICK_MAX_DURATION_MS = 250;
const FLICK_MIN_DISTANCE = 30;

const stylesheet = StyleSheet.create((theme) => ({
    hint: {
        position: 'absolute',
        top: 4,
        right: 8,
        paddingHorizontal: 6,
        paddingVertical: 1,
        borderRadius: 6,
        backgroundColor: theme.colors.surface.pressedOverlay,
    },
    hintText: {
        ...Typography.default(),
        fontSize: 11,
        color: theme.colors.text.secondary,
    },
}));

type TouchSample = Readonly<{ x: number; y: number; t: number }>;

function readSample(event: GestureResponderEvent): TouchSample {
    const { pageX, pageY, timestamp } = event.nativeEvent;
    return { x: pageX, y: pageY, t: timestamp };
}

function classifyFlick(start: TouchSample, end: TouchSample): ComposerHistoryDirection | null {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    if (end.t - start.t > FLICK_MAX_DURATION_MS) return null;
    if (Math.abs(dy) < FLICK_MIN_DISTANCE || Math.abs(dy) <= Math.abs(dx)) return null;
    return dy < 0 ? 'up' : 'down';
}

/**
 * A quick vertical flick over the composer steps through its message history, as the arrow keys do.
 *
 * It only watches the touch stream and never claims it, so the text field keeps every drag: it still scrolls
 * and selects as usual, and a flick is decided when the finger lifts. A gesture recognizer cannot do this
 * here: it would compete with the text view's own scroll and win or lose every drag outright (and the iOS
 * swipe recognizer has no speed threshold). Native only: web keeps the arrow keys and its own touch scrolling.
 */
export function ComposerHistorySwipeArea(props: Readonly<{
    enabled: boolean;
    onStep: (direction: ComposerHistoryDirection) => void;
    /** Where the recalled message sits in the history, shown briefly after a step. */
    hint?: string | null;
    children: React.ReactElement;
}>): React.ReactElement {
    const styles = stylesheet;
    const startRef = React.useRef<TouchSample | null>(null);
    const handleTouchStart = React.useCallback((event: GestureResponderEvent) => {
        startRef.current = event.nativeEvent.touches.length > 1 ? null : readSample(event);
    }, []);
    const handleTouchMove = React.useCallback((event: GestureResponderEvent) => {
        if (event.nativeEvent.touches.length > 1) startRef.current = null;
    }, []);
    const handleTouchEnd = React.useCallback((event: GestureResponderEvent) => {
        const start = startRef.current;
        startRef.current = null;
        if (!start || !props.enabled) return;
        const direction = classifyFlick(start, readSample(event));
        if (direction) props.onStep(direction);
    }, [props.enabled, props.onStep]);
    const handleTouchCancel = React.useCallback(() => { startRef.current = null; }, []);
    if (Platform.OS === 'web') return props.children;
    return (
        <View
            collapsable={false}
            testID="composer-history-swipe-area"
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
            onTouchCancel={handleTouchCancel}
        >
            {props.children}
            {props.hint ? (
                <View pointerEvents="none" style={styles.hint}>
                    <Text style={styles.hintText}>{props.hint}</Text>
                </View>
            ) : null}
        </View>
    );
}
