import * as React from 'react';
import { Pressable, View, type LayoutChangeEvent } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';
import { Text } from '@/components/ui/text/Text';
import { motionTokens } from '@/components/ui/motion/motionTokens';

import { createDesktopActivityOverlayFocusRingStyle } from './DesktopActivityOverlayChrome';
import {
    isDesktopActivityOverlayActivationKey,
    readDesktopActivityOverlayEventKey,
    type DesktopActivityOverlayKeyEvent,
} from './desktopActivityOverlayKeyboard';
import type { DesktopActivityOverlayPressableInteractionState } from './DesktopActivityOverlayPressableInteractionState';
import type { NotchStandardLayout } from './notch/NotchShape';

export type DesktopActivityOverlayCollapsedPressOrigin = 'pointer' | 'keyboard';

/** The one status word the island carries (N1's shared activity word); amber only when it needs you. */
export type DesktopActivityOverlayStatusWord = Readonly<{
    text: string;
    needsYou: boolean;
}>;

export type DesktopActivityOverlayStatusSlots = Readonly<{
    /** Bot faces (N3 fills this slot), laid out for the island's orientation. */
    faces: ((orientation: 'row' | 'column') => React.ReactNode) | null;
    word: DesktopActivityOverlayStatusWord | null;
}>;

/**
 * The standard island's content: the faces wing and the status word, sized to themselves (lab R2).
 * On the camera notch the two wings straddle the hardware block; on the side docks the faces stack and
 * the word stands out from the edge as its own tab (lab V-B), and with no faces the word alone is the
 * island. The whole row is the island's press target.
 */
export function DesktopActivityOverlayCollapsed(props: Readonly<{
    orientation: 'row' | 'column';
    /** Camera notch only: the hardware block the wings straddle. */
    cameraGap: number | null;
    slots: DesktopActivityOverlayStatusSlots;
    accessibilityLabel: string | undefined;
    pressableRef?: React.Ref<View>;
    onPress: (origin: DesktopActivityOverlayCollapsedPressOrigin) => void;
    onLayout: (layout: NotchStandardLayout) => void;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    // `react-native-web` turns Enter/Space into `onPress` from its own bubble-phase `onKeyDown`
    // handler, so the capture phase is the only place that still knows the press came from the
    // keyboard — and only a keyboard press should move focus into the expanded island.
    const keyboardActivationRef = React.useRef(false);
    const wingsRef = React.useRef({ leading: 0, trailing: 0 });
    const sizeRef = React.useRef({ width: 0, height: 0 });
    const { onLayout } = props;
    const report = React.useCallback(() => {
        onLayout({
            size: sizeRef.current,
            leadingWing: wingsRef.current.leading,
            trailingWing: wingsRef.current.trailing,
        });
    }, [onLayout]);
    const onRootLayout = React.useCallback((event: LayoutChangeEvent) => {
        sizeRef.current = { width: event.nativeEvent.layout.width, height: event.nativeEvent.layout.height };
        report();
    }, [report]);
    const onLeadingLayout = React.useCallback((event: LayoutChangeEvent) => {
        wingsRef.current = { ...wingsRef.current, leading: event.nativeEvent.layout.width };
        report();
    }, [report]);
    const onTrailingLayout = React.useCallback((event: LayoutChangeEvent) => {
        wingsRef.current = { ...wingsRef.current, trailing: event.nativeEvent.layout.width };
        report();
    }, [report]);

    const faces = props.slots.faces?.(props.orientation) ?? null;
    // A side dock stands its faces down the edge; with no faces there is no strip, and the island is
    // the word itself, standing out from the edge (sized to its content, like every other dock).
    const column = props.orientation === 'column' && faces !== null;
    const word = props.slots.word;
    const wordText = word ? (
        <Text
            testID="desktop-activity-overlay-status-word"
            variant="body"
            numberOfLines={1}
            style={word.needsYou ? styles.wordNeedsYou : styles.word}
        >
            {word.text}
        </Text>
    ) : null;

    const press = () => {
        const keyboardOrigin = keyboardActivationRef.current;
        keyboardActivationRef.current = false;
        props.onPress(keyboardOrigin ? 'keyboard' : 'pointer');
    };
    // The island's one expand control. Faces are buttons of their own, so it sits beside them rather than
    // around them (no button inside a button); a press anywhere else on the black lands on the row.
    const trigger = (children: React.ReactNode, style: object | null) => (
        <Pressable
            ref={props.pressableRef}
            testID="desktop-activity-overlay-collapsed"
            accessibilityRole="button"
            accessibilityLabel={props.accessibilityLabel}
            onPress={press}
            style={(state) => [
                style,
                state.pressed ? { opacity: motionTokens.press.opacitySubtle } : null,
                createDesktopActivityOverlayFocusRingStyle(theme, (state as DesktopActivityOverlayPressableInteractionState).focused),
            ]}
            {...({
                onKeyDownCapture: (event: DesktopActivityOverlayKeyEvent) => {
                    keyboardActivationRef.current = isDesktopActivityOverlayActivationKey(
                        readDesktopActivityOverlayEventKey(event),
                    );
                },
            } as Record<string, unknown>)}
        >
            {children}
        </Pressable>
    );

    return (
        <View
            testID="desktop-activity-overlay-collapsed-row"
            onLayout={onRootLayout}
            onStartShouldSetResponder={() => true}
            onResponderRelease={() => props.onPress('pointer')}
            style={[column ? styles.column : styles.row, props.cameraGap !== null && !column ? styles.rowCamera : null]}
        >
            {column ? (
                <>
                    {faces}
                    {trigger(null, null)}
                </>
            ) : (
                <>
                    {faces !== null || props.cameraGap !== null ? (
                        <View
                            testID="desktop-activity-overlay-faces-wing"
                            style={[styles.wing, props.cameraGap !== null && faces !== null ? styles.wingLeadingCamera : null]}
                            onLayout={onLeadingLayout}
                        >
                            {faces}
                        </View>
                    ) : null}
                    {props.cameraGap !== null ? (
                        <View testID="desktop-activity-overlay-camera-gap" style={{ width: props.cameraGap }} />
                    ) : null}
                    {trigger(
                        <View
                            testID="desktop-activity-overlay-word-wing"
                            style={[styles.wing, props.cameraGap !== null ? styles.wingTrailingCamera : null, props.cameraGap !== null && word !== null ? styles.wingTrailingCameraInset : null]}
                            onLayout={onTrailingLayout}
                        >
                            {wordText}
                        </View>,
                        props.cameraGap !== null ? styles.triggerCamera : null,
                    )}
                </>
            )}
        </View>
    );
}

/**
 * The panel's first row where the island's own row does not stand above it (side docks, Floating
 * opening upward): the same faces and word, read-only (lab `.nt-ph`).
 */
export function DesktopActivityOverlayStatusHeader(props: Readonly<{
    slots: DesktopActivityOverlayStatusSlots;
}>): React.ReactElement {
    const word = props.slots.word;
    return (
        <View testID="desktop-activity-overlay-status-header" style={styles.header}>
            <View style={styles.wing}>{props.slots.faces?.('row') ?? null}</View>
            {word ? (
                <Text variant="body" numberOfLines={1} style={word.needsYou ? styles.wordNeedsYou : styles.word}>
                    {word.text}
                </Text>
            ) : null}
        </View>
    );
}

/**
 * The side docks' status word: a tab standing out from the edge beside the first face, the same black
 * as the island (lab ntdock-L "Attention").
 */
export function DesktopActivityOverlaySideWordTab(props: Readonly<{
    word: DesktopActivityOverlayStatusWord;
}>): React.ReactElement {
    return (
        <Text
            testID="desktop-activity-overlay-status-word"
            variant="body"
            numberOfLines={1}
            style={props.word.needsYou ? styles.wordNeedsYou : styles.word}
        >
            {props.word.text}
        </Text>
    );
}

const styles = StyleSheet.create((theme) => ({
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        alignSelf: 'flex-start',
        height: PAGE_LIST_METRICS.controlHeightPx,
        minWidth: theme.space.s48,
        paddingHorizontal: theme.space.s12,
        // The word clears the faces by a step more than the strip's own inset (kept from the working-ring
        // era, R9 §5.1; retuning it is a separate composition call).
        gap: theme.space.s12,
    },
    // On the camera notch the wings hug the hardware block and carry their own insets, so an empty wing
    // draws nothing beside the camera and the measured wings keep the camera offset exact.
    rowCamera: {
        paddingHorizontal: 0,
        gap: 0,
    },
    column: {
        flexDirection: 'column',
        alignItems: 'center',
        alignSelf: 'flex-start',
        width: PAGE_LIST_METRICS.controlHeightPx,
        minHeight: theme.space.s48,
        paddingVertical: theme.space.s12,
        gap: theme.space.s8,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: theme.space.s8,
        minHeight: PAGE_LIST_METRICS.smallControlHeightPx,
        paddingLeft: theme.space.s4,
        paddingRight: theme.space.s2,
    },
    wing: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s4,
    },
    // Each wing keeps a step off the hardware block and its shoulder (lab `.nt-wl`/`.nt-wr`).
    wingLeadingCamera: {
        paddingHorizontal: theme.space.s8,
    },
    wingTrailingCamera: {
        justifyContent: 'flex-end',
    },
    wingTrailingCameraInset: {
        paddingHorizontal: theme.space.s8,
    },
    // On the camera notch the word wing takes the hardware block's trailing side whole.
    triggerCamera: {
        flexGrow: 1,
    },
    word: {
        color: theme.colors.text.secondary,
    },
    wordNeedsYou: {
        color: theme.colors.state.attention.textForeground,
    },
}));
