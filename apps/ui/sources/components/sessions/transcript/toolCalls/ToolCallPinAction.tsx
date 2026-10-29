import * as React from 'react';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { PinIcon, PinSlashIcon } from '@/components/sessions/shell/sessionPinIcons';
import { t } from '@/text';
import type { PersistedSessionMessagePinV1 } from "@happier-dev/session-core/pins";

import type { SessionMessagePinRole } from "@happier-dev/session-core/pins";
import { ICON_SIZE } from '@/components/ui/icons/Icon';

import {
    buildSessionMessagePinAtPressTime,
    resolveMessagePinAvailability,
    type MessagePinAvailability,
} from '../messageActions/resolveMessagePinAvailability';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';

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
    const iconColor = pinned ? theme.colors.state.active.foreground : theme.colors.text.secondary;
    const label = pinned
        ? t('session.transcriptNavigation.unpinToolCallA11y')
        : t('session.transcriptNavigation.pinToolCallA11y');

    const handlePress = (event?: PressEventWithPropagation) => {
        event?.stopPropagation?.();
        props.onTogglePin?.(buildSessionMessagePinAtPressTime(pinTarget));
    };

    return (
        <HappierPressable
            testID={props.testID}
            onPress={handlePress}
            // Inside the tool row, whose own press is the row: the pin keeps its drawn box.
            hitReach={0}
            accessibilityRole="button"
            accessibilityLabel={label}
            style={({ pressed }) => [
                styles.button,
                pinned ? styles.buttonPinned : null,
                pressed ? styles.buttonPressed : null,
            ]}
        >
            {pinned ? (
                <PinSlashIcon size={ICON_SIZE.xs} color={iconColor} />
            ) : (
                <PinIcon size={ICON_SIZE.xs} color={iconColor} />
            )}
        </HappierPressable>
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
    pinActionEnabled?: boolean;
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
        pinActionEnabled: params.pinActionEnabled,
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
