import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { TabBadge } from '@/components/ui/navigation/tabBadge/TabBadge';
import { getStorage } from '@/sync/domains/state/storage';
import type { Session } from '@/sync/domains/state/storageTypes';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import type { RailBadgeSignalRenderer } from '@/components/navigation/shell/appRail/AppRailBadge';

import { selectSessionAgentAsksInTerminal } from '../presentation/useSessionTerminalPresentation';

/**
 * Terminal lab ST "Bell and needs you": while the bottom pane is hidden, the rail's Terminal carries the
 * same amber dot the agent's tab would show when the agent asks in its own terminal. It reads one bit.
 */
export const SessionTerminalRailBadge = React.memo(function SessionTerminalRailBadge(props: Readonly<{
    sessionId: string;
    serverId: string | null;
    renderSignal?: RailBadgeSignalRenderer;
}>) {
    const { theme } = useUnistyles();
    const asking = getStorage()((state) => {
        const session = (state.sessions as Record<string, Session | undefined>)[props.sessionId];
        if (!session || (props.serverId && !areServerProfileIdentifiersEquivalent(session.serverId, props.serverId))) return false;
        return selectSessionAgentAsksInTerminal(session);
    });
    if (props.renderSignal) return <>{props.renderSignal(asking ? { kind: 'dot', tone: 'attention' } : null)}</>;
    if (!asking) return null;
    return <TabBadge variant="dot" testID="session-action-rail:terminal:badge" style={{ backgroundColor: theme.colors.status.actionRequired }} />;
});
