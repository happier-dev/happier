import * as React from 'react';
import { Platform, Pressable } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { PinIcon, PinSlashIcon } from '@/components/sessions/shell/sessionPinIcons';
import { t } from '@/text';
import type { PersistedSessionMessagePinV1 } from '@/sync/domains/messages/pins/sessionMessagePins';

import type { MessagePinAvailability } from '../messageActions/resolveMessagePinAvailability';

type PressEventWithPropagation = Readonly<{
    stopPropagation?: () => void;
}>;

export function ToolCallPinAction(props: Readonly<{
    availability: MessagePinAvailability;
    onTogglePin?: (pin: PersistedSessionMessagePinV1) => void;
    testID?: string;
}>): React.ReactElement | null {
    const { theme } = useUnistyles();
    if (props.availability.status !== 'available' || !props.onTogglePin) return null;

    const { pin, pinned } = props.availability;
    const hitSlop = Platform.OS === 'web' ? undefined : 15;
    const iconColor = pinned ? theme.colors.state.active.foreground : theme.colors.text.secondary;
    const label = pinned
        ? t('session.transcriptNavigation.unpinToolCallA11y')
        : t('session.transcriptNavigation.pinToolCallA11y');

    const handlePress = (event?: PressEventWithPropagation) => {
        event?.stopPropagation?.();
        props.onTogglePin?.(pin);
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
