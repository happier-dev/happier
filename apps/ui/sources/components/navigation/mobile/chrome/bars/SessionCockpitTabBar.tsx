import * as React from 'react';

import { AgentIcon } from '@/agents/registry/AgentIcon';
import { DEFAULT_AGENT_ID, getAgentCore, resolveAgentIdFromFlavor } from '@/agents/catalog/catalog';
import { t } from '@/text';
import { useSession } from '@/sync/domains/state/storage';
import type { SessionMobileSurface } from '@/components/workspaceCockpit/session/sessionCockpitState';
import { resolveAgentIdFromSessionMetadata } from '@happier-dev/agents';

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
    const session = useSession(props.sessionId);
    const chatAgentId =
        resolveAgentIdFromSessionMetadata(session?.metadata ?? null)
        ?? resolveAgentIdFromFlavor(session?.metadata?.flavor)
        ?? DEFAULT_AGENT_ID;
    const tabs: readonly SessionCockpitTabDefinition[] = [
        {
            id: 'chat',
            label: t(getAgentCore(chatAgentId).displayNameKey),
            icon: {
                render: ({ size, active }) => (
                    <AgentIcon
                        agentId={chatAgentId}
                        size={size}
                        style={{ opacity: active ? 1 : 0.68 }}
                        testID="session-cockpit-tab-chat-agent-icon"
                    />
                ),
            },
        },
        { id: 'browse', label: t('common.files'), icon: 'folder-outline' },
        { id: 'git', label: t('session.rightPanel.tabs.git'), icon: 'git-branch-outline' },
        { id: 'tabs', label: t('workspaceCockpit.tabs'), icon: 'albums-outline' },
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
