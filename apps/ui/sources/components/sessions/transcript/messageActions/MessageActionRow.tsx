import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

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
    /**
     * Set on a touch host while the actions are closed. Off web, hidden actions are out of reach of a screen
     * reader, so the row stands in as one "Show message actions" button whose activation opens them.
     */
    onOpenActions?: () => void;
    timestampText: string | null;
    /** A glyph that leads the timestamp line (drawn by the host in the timestamp's ink). */
    timestampGlyph?: React.ReactNode;
}>): React.ReactElement {
    // On the web the controls of a closed row are not mounted: a transcript mounts a row per message, and
    // these controls are most of what each one costs. The closed row keeps one focusable stand-in, so a
    // keyboard reaches the actions as before; focusing it (or revealing the row) mounts the controls, which
    // then stay mounted for the row's life. Touch hosts keep their controls mounted (their own opener).
    const [engaged, setEngaged] = React.useState(props.showActions || !props.isWeb);
    if (props.showActions && !engaged) setEngaged(true);
    type FocusTarget = { focus?: () => void };
    const handoffRef = React.useRef<Readonly<{ slot: { querySelectorAll?: (selector: string) => ArrayLike<FocusTarget> }; reverse: boolean }> | null>(null);
    React.useLayoutEffect(() => {
        const handoff = handoffRef.current;
        if (!engaged || !handoff) return;
        handoffRef.current = null;
        const controls = handoff.slot.querySelectorAll?.('button, a[href], [tabindex="0"]');
        if (!controls || controls.length === 0) return;
        controls[handoff.reverse ? controls.length - 1 : 0]?.focus?.();
    }, [engaged]);
    // Focus entering from a following element (Shift+Tab) lands on the last control, matching tab order.
    const engageFromFocus = React.useCallback((event: { currentTarget?: unknown; relatedTarget?: unknown }) => {
        const standIn = event.currentTarget as { parentElement?: unknown; compareDocumentPosition?: (other: unknown) => number } | null | undefined;
        const slot = standIn?.parentElement as Readonly<{ querySelectorAll?: (selector: string) => ArrayLike<FocusTarget> }> | null | undefined;
        if (slot) {
            const reverse = event.relatedTarget != null
                && ((standIn?.compareDocumentPosition?.(event.relatedTarget) ?? 0) & 4) !== 0;
            handoffRef.current = { slot, reverse };
        }
        setEngaged(true);
    }, []);
    const hasTimestamp = typeof props.timestampText === 'string' && props.timestampText.length > 0;
    const openActions = props.onOpenActions;
    const accessibilityOpener = !props.isWeb && openActions ? {
        accessible: true,
        accessibilityRole: 'button' as const,
        accessibilityLabel: t('committedMessageActions.showActions'),
        accessibilityActions: [{ name: 'activate' as const }],
        onAccessibilityAction: () => openActions(),
        onAccessibilityTap: openActions,
    } : null;
    return (
        <View
            {...(props.isWeb ? {} : { pointerEvents: 'box-none' as const })}
            {...accessibilityOpener}
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
                {engaged ? props.children : (
                    <Pressable
                        testID={`transcript-message-actions-opener:${props.messageId}`}
                        accessibilityRole="button"
                        accessibilityLabel={t('committedMessageActions.showActions')}
                        onFocus={engageFromFocus}
                        style={styles.opener}
                    />
                )}
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
    opener: {
        width: 16,
        height: 16,
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
