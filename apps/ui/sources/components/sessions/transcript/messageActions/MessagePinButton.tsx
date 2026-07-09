import * as React from 'react';
import { Platform, Pressable } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { PinIcon, PinSlashIcon } from '@/components/sessions/shell/sessionPinIcons';
import { t } from '@/text';
import type { PersistedSessionMessagePinV1 } from '@/sync/domains/messages/pins/sessionMessagePins';

import type { MessagePinAvailability } from './resolveMessagePinAvailability';

export function MessagePinButton(props: Readonly<{
    availability: MessagePinAvailability;
    onTogglePin?: (pin: PersistedSessionMessagePinV1) => void;
    testID?: string;
    invertedActionsLayout?: boolean;
    onHoverIn?: () => void;
    onHoverOut?: () => void;
}>): React.ReactElement | null {
    const { theme } = useUnistyles();
    if (props.availability.status !== 'available' || !props.onTogglePin) return null;

    const { pin, pinned } = props.availability;
    const hitSlop = Platform.OS === 'web' ? undefined : 15;
    const iconColor = pinned ? theme.colors.state.active.foreground : theme.colors.text.secondary;
    const label = pinned
        ? t('session.transcriptNavigation.unpinMessageA11y')
        : t('session.transcriptNavigation.pinMessageA11y');

    const handlePress = () => {
        props.onTogglePin?.(pin);
    };

    return (
        <Pressable
            testID={props.testID}
            onPress={handlePress}
            onHoverIn={props.onHoverIn}
            onHoverOut={props.onHoverOut}
            hitSlop={hitSlop}
            accessibilityRole="button"
            accessibilityLabel={label}
            style={({ pressed }) => [
                styles.button,
                Platform.OS === 'web' ? styles.webActionButton : null,
                props.invertedActionsLayout ? styles.webActionButtonInverted : null,
                props.invertedActionsLayout ? styles.invertedSpacing : null,
                pinned ? styles.buttonPinned : null,
                pressed ? styles.buttonPressed : null,
            ]}
        >
            {pinned ? (
                <PinSlashIcon size={12} color={iconColor} />
            ) : (
                <PinIcon size={12} color={iconColor} />
            )}
        </Pressable>
    );
}

const styles = StyleSheet.create((theme) => ({
    button: {
        padding: 2,
        borderRadius: 6,
        opacity: 0.6,
        cursor: 'pointer',
        marginRight: 6,
    },
    webActionButton: {
        padding: 6,
    },
    webActionButtonInverted: {
        paddingHorizontal: 4,
    },
    invertedSpacing: {
        marginRight: 2,
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
