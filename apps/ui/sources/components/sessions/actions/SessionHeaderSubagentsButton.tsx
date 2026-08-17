import * as React from 'react';
import { Pressable, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { useOptionalSessionScreenTestId } from '../shell/sessionScreenTestIds';
import { SESSION_HEADER_ICON_SIZE_PX } from '@/components/sessions/actions/sessionHeaderIconMetrics';
import { SessionHeaderIconWithCount } from '@/components/sessions/actions/SessionHeaderIconWithCount';
import { ICON_SIZE, Icon } from '@/components/ui/icons/Icon';

/**
 * A live indicator: present exactly while agents are running in this session. `activeCount` is the
 * whole condition — there is no second "has any" flag, because a session that ran an agent an hour
 * ago is history, and history belongs in the overflow menu, not in a status slot.
 */
export const SessionHeaderSubagentsButton = React.memo((props: Readonly<{
    scopeId: string;
    activeCount: number;
}>) => {
    const { theme } = useUnistyles();
    const pane = useAppPaneScope(props.scopeId);
    const testId = useOptionalSessionScreenTestId('session-header-subagents-button');

    const onPress = React.useCallback(() => {
        pane.openRight({ tabId: 'agents' });
        pane.setRightTab('agents');
    }, [pane]);

    if (props.activeCount <= 0) return null;

    return (
        <Pressable
            testID={testId}
            onPress={onPress}
            hitSlop={15}
            style={({ pressed }) => ({
                width: 44,
                height: 44,
                alignItems: 'center',
                justifyContent: 'center',
                opacity: pressed ? 0.7 : 1,
            })}
            accessibilityRole="button"
            accessibilityLabel={t('session.openSubagents', { count: props.activeCount })}
        >
            <SessionHeaderIconWithCount count={props.activeCount}>
                <Icon name="robot" size={SESSION_HEADER_ICON_SIZE_PX} color={theme.colors.chrome.header.foreground} />
            </SessionHeaderIconWithCount>
        </Pressable>
    );
});
