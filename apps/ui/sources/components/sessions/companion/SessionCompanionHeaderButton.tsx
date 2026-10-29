import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { SessionHeaderIconWithCount } from '@/components/sessions/actions/SessionHeaderIconWithCount';
import { SessionHeaderActionButton } from '@/components/sessions/actions/SessionHeaderActionButton';
import { SESSION_HEADER_ICON_SIZE_PX } from '@/components/sessions/actions/sessionHeaderIconMetrics';
import { Icon } from '@/components/ui/icons/Icon';

import {
    resolveSessionCompanionHeaderAccessibilityLabel,
    type SessionCompanionHeaderIntent,
} from './sessionCompanionHeaderIntent';

/**
 * Visual projection of the canonical Companion header action. The Session
 * header menu owns placement and execution so direct and overflow never become
 * separate commands or compete for independent width budgets.
 */
export const SessionCompanionHeaderButton = React.memo((props: Readonly<{
    intent: SessionCompanionHeaderIntent;
    onPress: () => void;
}>) => {
    const { theme } = useUnistyles();
    const { intent } = props;

    return (
        <SessionHeaderActionButton
            testID="session-header-companion"
            onPress={props.onPress}
            expanded={intent.expanded}
            accessibilityLabel={resolveSessionCompanionHeaderAccessibilityLabel(intent)}
        >
            <SessionHeaderIconWithCount count={intent.itemCount}>
                <Icon name="stack-simple" size={SESSION_HEADER_ICON_SIZE_PX} color={theme.colors.chrome.header.foreground} />
            </SessionHeaderIconWithCount>
        </SessionHeaderActionButton>
    );
});
