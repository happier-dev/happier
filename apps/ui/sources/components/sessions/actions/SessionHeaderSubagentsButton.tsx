import * as React from 'react';
import { Pressable, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { useOpenSessionTarget } from '@/components/sessions/panes/open/useOpenSessionTarget';
import { t } from '@/text';
import { useOptionalSessionScreenTestId } from '../shell/sessionScreenTestIds';
import { SESSION_HEADER_ICON_SIZE_PX } from '@/components/sessions/actions/sessionHeaderIconMetrics';
import { SessionHeaderIconWithCount } from '@/components/sessions/actions/SessionHeaderIconWithCount';
import { Icon } from '@/components/ui/icons/Icon';

/**
 * A live indicator: present exactly while agents are running in this session. `activeCount` is the
 * whole condition — there is no second "has any" flag, because a session that ran an agent an hour
 * ago is history, and history belongs in the overflow menu, not in a status slot.
 *
 * **It opens the roster wherever this layout can put it.** It used to open the right pane
 * unconditionally, and the right pane is structurally hidden on a phone — so on the device where
 * this glyph is the only way in, pressing it did nothing at all. The destination is now the shared
 * open decision: the Agents tab where a right pane fits, the agents screen where it does not.
 */
export const SessionHeaderSubagentsButton = React.memo((props: Readonly<{
    sessionId: string;
    scopeId: string;
    activeCount: number;
    serverId?: string | null;
}>) => {
    const { theme } = useUnistyles();
    const testId = useOptionalSessionScreenTestId('session-header-subagents-button');
    const openTarget = useOpenSessionTarget({
        sessionId: props.sessionId,
        scopeId: props.scopeId,
        ...(props.serverId ? { serverId: props.serverId } : null),
    });

    const onPress = React.useCallback(() => {
        openTarget({ kind: 'agentRoster' });
    }, [openTarget]);

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
