import * as React from 'react';
import { resolveAgentIdFromSessionMetadata } from '@happier-dev/agents';

import {
    DEFAULT_AGENT_ID,
    getAgentCore,
    resolveAgentIdFromFlavor,
    type AgentId,
} from '@/agents/catalog/catalog';
import { AgentIcon } from '@/agents/registry/AgentIcon';
import { useSessionMetadata } from '@/sync/domains/state/storage';
import { t } from '@/text';
import type { SessionMobileSurface } from '@/components/workspaceCockpit/session/sessionCockpitState';
import { CockpitTabBar, type CockpitTabBarTabDefinition } from './CockpitTabBar';

type SessionCockpitTabBarProps = Readonly<{
    sessionId: string;
    activeSurface: SessionMobileSurface;
    terminalTabAvailable: boolean;
    onSurfacePress: (surface: SessionMobileSurface) => void;
}>;

type SessionCockpitTabDefinition = Readonly<{
    id: SessionMobileSurface;
    label: string;
    icon: CockpitTabBarTabDefinition<SessionMobileSurface>['icon'];
}>;

export const SessionCockpitTabBar = React.memo((props: SessionCockpitTabBarProps) => {
    const sessionMetadata = useSessionMetadata(props.sessionId);
    const agentId: AgentId = React.useMemo(() => (
        resolveAgentIdFromSessionMetadata(sessionMetadata)
        ?? resolveAgentIdFromFlavor(sessionMetadata?.flavor)
        ?? DEFAULT_AGENT_ID
    ), [sessionMetadata]);

    const tabs: readonly SessionCockpitTabDefinition[] = [
        {
            id: 'chat',
            label: t(getAgentCore(agentId).displayNameKey),
            icon: {
                render: ({ active, size }) => (
                    <AgentIcon
                        agentId={agentId}
                        size={size}
                        style={{ opacity: active ? 1 : 0.68 }}
                        testID="session-cockpit-tab-chat-agent-icon"
                    />
                ),
            },
        },
        { id: 'browse', label: t('common.files'), icon: 'folder-outline' },
        { id: 'git', label: t('session.rightPanel.tabs.git'), icon: 'git-branch-outline' },
        { id: 'tabs', label: t('common.tabs'), icon: 'albums-outline' },
        ...(props.terminalTabAvailable
            ? [{ id: 'terminal', label: t('settings.terminal'), icon: 'terminal-outline' } satisfies SessionCockpitTabDefinition]
            : []),
    ];

    return (
        <CockpitTabBar
            activeSurface={props.activeSurface}
            barTestId={`session-cockpit-tabbar-${props.sessionId}`}
            tabs={tabs}
            tabTestIdPrefix="session-cockpit-tab-"
            onSurfacePress={props.onSurfacePress}
        />
    );
});
