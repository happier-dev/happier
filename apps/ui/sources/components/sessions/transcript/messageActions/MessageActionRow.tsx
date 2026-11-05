import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';

import { RowActionRevealSlot } from '@/components/ui/lists/RowActionRevealSlot';

/**
 * Timestamp + hover-revealed actions for one transcript message.
 *
 * The pin has its own reveal slot: a pinned row must keep showing its pin
 * without dragging the rest of the actions — or the timestamp presentation —
 * into view. The container never captures pointer input; each slot owns whether
 * its own children are clickable.
 */
export function MessageActionRow(props: Readonly<{
    children: React.ReactNode;
    isWeb: boolean;
    invertTimestampAndActions: boolean;
    messageId: string;
    showActions: boolean;
    showPinAction?: boolean;
    pinAction?: React.ReactNode;
    /** Notified when descendant focus enters/leaves, so the host can mirror it. */
    onActionsFocus?: () => void;
    onActionsBlur?: () => void;
    timestampText: string | null;
    /** A glyph that leads the timestamp line (drawn by the host in the timestamp's ink). */
    timestampGlyph?: React.ReactNode;
}>): React.ReactElement {
    const hasTimestamp = typeof props.timestampText === 'string' && props.timestampText.length > 0;
    return (
        <View
            {...(props.isWeb ? {} : { pointerEvents: 'box-none' as const })}
            style={[
                styles.container,
                props.invertTimestampAndActions ? styles.containerInverted : null,
                props.isWeb ? styles.containerWebPointerEvents : null,
            ]}
            testID={`transcript-message-actions-row:${props.messageId}`}
        >
            {hasTimestamp && props.timestampGlyph ? (
                // A glyph leads the line (a Voice turn's planet); the pair keeps the timestamp's spacing.
                <View style={[
                    styles.timestamp,
                    styles.timestampSpacing,
                    props.invertTimestampAndActions ? styles.timestampTextInverted : null,
                ]}>
                    {props.timestampGlyph}
                    <Text
                        testID={`transcript-message-timestamp:${props.messageId}`}
                        numberOfLines={1}
                        style={styles.timestampText}
                    >
                        {props.timestampText}
                    </Text>
                </View>
            ) : hasTimestamp ? (
                <Text
                    testID={`transcript-message-timestamp:${props.messageId}`}
                    numberOfLines={1}
                    style={[
                        styles.timestampText,
                        styles.timestampSpacing,
                        props.invertTimestampAndActions ? styles.timestampTextInverted : null,
                    ]}
                >
                    {props.timestampText}
                </Text>
            ) : null}
            {props.pinAction ? (
                <RowActionRevealSlot
                    revealed={props.showPinAction === true}
                    onFocus={props.onActionsFocus}
                    onBlur={props.onActionsBlur}
                    testID={`transcript-message-pin-slot:${props.messageId}`}
                >
                    {props.pinAction}
                </RowActionRevealSlot>
            ) : null}
            <RowActionRevealSlot
                revealed={props.showActions}
                onFocus={props.onActionsFocus}
                onBlur={props.onActionsBlur}
                testID={`transcript-message-actions:${props.messageId}`}
            >
                {props.children}
            </RowActionRevealSlot>
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    // The row spans the message's width and keeps one line: on a narrow screen the timestamp gives way
    // (ellipsized) to the actions instead of wrapping upward over the message it belongs to.
    container: {
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
        // The row lives in the gap its message reserves below itself. Touch-sized targets overflow
        // that band evenly (centred) instead of growing the row upward over the message text.
        height: theme.transcript.messageGap,
        overflow: 'visible',
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'flex-end',
    },
    containerInverted: {
        flexDirection: 'row-reverse',
    },
    containerWebPointerEvents: {
        pointerEvents: 'box-none',
    },
    timestamp: {
        flexShrink: 1,
        minWidth: 0,
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s4,
    },
    timestampSpacing: {
        marginRight: theme.space.s8,
    },
    timestampText: {
        flexShrink: 1,
        minWidth: 0,
        color: theme.colors.text.tertiary,
        fontSize: 11,
        lineHeight: 16,
    },
    timestampTextInverted: {
        marginLeft: theme.space.s12,
        marginRight: 0,
    },
}));
