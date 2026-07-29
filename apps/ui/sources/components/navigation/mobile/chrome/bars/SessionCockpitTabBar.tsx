import * as React from 'react';

import { DEFAULT_AGENT_ID, getAgentCore } from '@/agents/catalog/catalog';
import { AgentIcon } from '@/agents/registry/AgentIcon';
import { useSession, useSessionProjectScmStatus, useSetting } from '@/sync/domains/state/storage';
import { readSessionPresentationAgentId } from '@/sync/domains/session/presentation/readSessionPresentationAgentId';
import { resolveGitTabBadge } from '@/components/ui/navigation/tabBadge/tabBadgeModel';
import { t } from '@/text';
import type { SessionMobileSurface } from '@/components/workspaceCockpit/session/sessionCockpitState';
import { CockpitTabBar, type CockpitTabBarTabDefinition } from './CockpitTabBar';

type SessionCockpitTabBarProps = Readonly<{
    sessionId: string;
    activeSurface: SessionMobileSurface;
    terminalTabAvailable: boolean;
    openDetailsTabCount: number;
    onSurfacePress: (surface: SessionMobileSurface) => void;
}>;

type SessionCockpitTabDefinition = Readonly<{
    id: SessionMobileSurface;
    label: string;
    icon: CockpitTabBarTabDefinition<SessionMobileSurface>['icon'];
    badge?: CockpitTabBarTabDefinition<SessionMobileSurface>['badge'];
}>;

export const SessionCockpitTabBar = React.memo((props: SessionCockpitTabBarProps) => {
    const session = useSession(props.sessionId);
    const scmStatus = useSessionProjectScmStatus(props.sessionId);
    const gitBadgeMode = useSetting('tabBarGitBadgeMode');
    const openTabsBadgeEnabled = useSetting('tabBarOpenTabsBadgeEnabled');
    const agentId = React.useMemo(
        () => (session ? readSessionPresentationAgentId(session) : null) ?? DEFAULT_AGENT_ID,
        [session],
    );
    const gitBadge = resolveGitTabBadge(gitBadgeMode, scmStatus);

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
        {
            id: 'git',
            label: t('session.rightPanel.tabs.git'),
            icon: 'git-branch-outline',
            badge: gitBadge ?? undefined,
        },
        { id: 'navigation', label: t('session.transcriptNavigation.title'), icon: 'list-outline' },
        {
            id: 'tabs',
            label: t('common.tabs'),
            icon: 'albums-outline',
            badge: openTabsBadgeEnabled && props.openDetailsTabCount > 0
                ? { kind: 'count', value: props.openDetailsTabCount }
                : undefined,
        },
        { id: 'browser', label: t('browserSurface.title'), icon: 'globe-outline' },
        { id: 'services', label: t('localServices.inventory.title'), icon: 'server-outline' },
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
