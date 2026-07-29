import * as React from 'react';
import { Platform, Pressable } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { PinIcon, PinSlashIcon } from '@/components/sessions/shell/sessionPinIcons';
import { t } from '@/text';
import type { PersistedSessionMessagePinV1 } from '@/sync/domains/messages/pins/sessionMessagePins';

import type { SessionMessagePinRole } from '@/sync/domains/messages/pins/sessionMessagePinIdentity';

import {
    buildSessionMessagePinAtPressTime,
    resolveMessagePinAvailability,
    type MessagePinAvailability,
} from '../messageActions/resolveMessagePinAvailability';

type PressEventWithPropagation = Readonly<{
    stopPropagation?: () => void;
}>;

/**
 * A tool row's pin plus the sticky flag its reveal container needs: a pinned row
 * keeps its pin visible without hover, an unpinned one reveals with the row.
 */
export type ToolRowPinAction = Readonly<{
    node: React.ReactNode;
    pinned: boolean;
}>;

export function ToolCallPinAction(props: Readonly<{
    availability: MessagePinAvailability;
    onTogglePin?: (pin: PersistedSessionMessagePinV1) => void;
    testID?: string;
}>): React.ReactElement | null {
    const { theme } = useUnistyles();
    if (props.availability.status !== 'available' || !props.onTogglePin) return null;

    const { pinTarget, pinned } = props.availability;
    const hitSlop = Platform.OS === 'web' ? undefined : 15;
    const iconColor = pinned ? theme.colors.state.active.foreground : theme.colors.text.secondary;
    const label = pinned
        ? t('session.transcriptNavigation.unpinToolCallA11y')
        : t('session.transcriptNavigation.pinToolCallA11y');

    const handlePress = (event?: PressEventWithPropagation) => {
        event?.stopPropagation?.();
        props.onTogglePin?.(buildSessionMessagePinAtPressTime(pinTarget));
    };

    return (
        <Pressable
            testID={props.testID}
            onPress={handlePress}
            hitSlop={hitSlop}
            accessibilityRole="button"
            accessibilityLabel={label}
            style={({ pressed }) => [
                styles.button,
                pinned ? styles.buttonPinned : null,
                pressed ? styles.buttonPressed : null,
            ]}
        >
            {pinned ? (
                <PinSlashIcon size={14} color={iconColor} />
            ) : (
                <PinIcon size={14} color={iconColor} />
            )}
        </Pressable>
    );
}

/**
 * Single factory for a tool row's pin: availability, the button, and its sticky
 * flag are resolved once per row instead of being recomputed by each producer.
 */
export function resolveToolRowPinAction(params: Readonly<{
    sessionId: string;
    seq: number | null | undefined;
    transcriptBlockIndex: number | null | undefined;
    routeMessageId: string | null | undefined;
    role?: SessionMessagePinRole;
    pins?: readonly PersistedSessionMessagePinV1[];
    readOnlyContext?: boolean;
    onTogglePin?: (pin: PersistedSessionMessagePinV1) => void;
    testID: string;
}>): ToolRowPinAction | null {
    if (!params.onTogglePin) return null;
    const availability = resolveMessagePinAvailability({
        sessionId: params.sessionId,
        seq: params.seq,
        transcriptBlockIndex: params.transcriptBlockIndex,
        routeMessageId: params.routeMessageId,
        role: params.role ?? 'tool',
        pins: params.pins ?? [],
        readOnlyContext: params.readOnlyContext === true,
    });
    if (availability.status !== 'available') return null;
    return {
        pinned: availability.pinned,
        node: (
            <ToolCallPinAction
                availability={availability}
                onTogglePin={params.onTogglePin}
                testID={params.testID}
            />
        ),
    };
}

const styles = StyleSheet.create((theme) => ({
    button: {
        alignItems: 'center',
        justifyContent: 'center',
        width: 28,
        height: 28,
        borderRadius: 6,
        opacity: 0.72,
        cursor: 'pointer',
    },
    buttonPinned: {
        opacity: 1,
        backgroundColor: theme.colors.state.active.background,
    },
    buttonPressed: {
        opacity: 1,
        backgroundColor: theme.colors.state.neutral.background,
    },
}));
