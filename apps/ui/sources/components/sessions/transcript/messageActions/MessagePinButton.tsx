import * as React from 'react';
import { Pressable } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { PinIcon, PinSlashIcon } from '@/components/sessions/shell/sessionPinIcons';
import { t } from '@/text';
import type { PersistedSessionMessagePinV1 } from "@happier-dev/session-core/pins";

import { buildSessionMessagePinAtPressTime, type MessagePinAvailability } from './resolveMessagePinAvailability';
import { ICON_SIZE } from '@/components/ui/icons/Icon';
import { useMessageActionHitArea } from './useMessageActionHitArea';
import { RowActionDeferredIcon } from '@/components/ui/lists/RowActionRevealSlot';

export function MessagePinButton(props: Readonly<{
    availability: MessagePinAvailability;
    onTogglePin?: (pin: PersistedSessionMessagePinV1) => void;
    testID?: string;
    invertedActionsLayout?: boolean;
    onHoverIn?: () => void;
    onHoverOut?: () => void;
}>): React.ReactElement | null {
    const { theme } = useUnistyles();
    const hitArea = useMessageActionHitArea(props.invertedActionsLayout);
    if (props.availability.status !== 'available' || !props.onTogglePin) return null;

    const { pinTarget, pinned } = props.availability;
    const iconColor = pinned ? theme.colors.state.active.foreground : theme.colors.text.secondary;
    const label = pinned
        ? t('session.transcriptNavigation.unpinMessageA11y')
        : t('session.transcriptNavigation.pinMessageA11y');

    const handlePress = () => {
        props.onTogglePin?.(buildSessionMessagePinAtPressTime(pinTarget));
    };

    return (
        <Pressable
            testID={props.testID}
            onPress={handlePress}
            onHoverIn={props.onHoverIn}
            onHoverOut={props.onHoverOut}
            hitSlop={hitArea.hitSlop}
            onLayout={hitArea.onLayout}
            accessibilityRole="button"
            accessibilityLabel={label}
            style={({ pressed }) => [
                styles.button,
                props.invertedActionsLayout ? styles.webActionButtonInverted : null,
                props.invertedActionsLayout ? styles.invertedSpacing : null,
                {
                    alignItems: 'center',
                    justifyContent: 'center',
                },
                pinned ? styles.buttonPinned : null,
                pressed ? styles.buttonPressed : null,
            ]}
        >
            {hitArea.frame}
            <RowActionDeferredIcon size={ICON_SIZE.xs}>
                {pinned ? (
                    <PinSlashIcon size={ICON_SIZE.xs} color={iconColor} />
                ) : (
                    <PinIcon size={ICON_SIZE.xs} color={iconColor} />
                )}
            </RowActionDeferredIcon>
        </Pressable>
    );
}

const styles = StyleSheet.create((theme) => ({
    button: {
        padding: theme.space.s6,
        borderRadius: 6,
        opacity: 0.6,
        cursor: 'pointer',
        marginRight: theme.space.s6,
    },
    webActionButtonInverted: {
        paddingHorizontal: theme.space.s4,
    },
    invertedSpacing: {
        marginRight: theme.space.s2,
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
