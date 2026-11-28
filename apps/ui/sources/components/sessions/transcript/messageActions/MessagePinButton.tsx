import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { t } from '@/text';
import type { PersistedSessionMessagePinV1 } from "@happier-dev/session-core/pins";

import { buildSessionMessagePinAtPressTime, type MessagePinAvailability } from './resolveMessagePinAvailability';
import { MessageActionIconButton } from './MessageActionIconButton';

/** A pinned message's pin: it stays in the row as the pinned state and unpins it (Pin itself waits under ⋯). */
export function MessagePinButton(props: Readonly<{
    availability: MessagePinAvailability;
    onTogglePin?: (pin: PersistedSessionMessagePinV1) => void;
    testID: string;
    invertedActionsLayout?: boolean;
    onFocusChange?: (focused: boolean) => void;
}>): React.ReactElement | null {
    const { theme } = useUnistyles();
    if (props.availability.status !== 'available' || !props.onTogglePin) return null;

    const { pinTarget, pinned } = props.availability;
    return (
        <MessageActionIconButton
            testID={props.testID}
            icon={pinned ? 'push-pin-slash' : 'push-pin'}
            accessibilityLabel={pinned
                ? t('session.transcriptNavigation.unpinMessageA11y')
                : t('session.transcriptNavigation.pinMessageA11y')}
            stateColor={pinned ? theme.colors.state.active.foreground : undefined}
            selected={pinned}
            invertedActionsLayout={props.invertedActionsLayout === true}
            onFocusChange={props.onFocusChange}
            onPress={() => props.onTogglePin?.(buildSessionMessagePinAtPressTime(pinTarget))}
            shortcutCommandId="transcript.message.pin"
        />
    );
}
