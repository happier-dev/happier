import { AgentIcon } from '@/agents/registry/AgentIcon';
import { getAgentCore } from '@/agents/catalog/catalog';
import { t } from '@/text';
import { useSessionMetadata, useSessionProjectScmStatus, useSetting } from '@/sync/domains/state/storage';
import { resolveGitTabBadge } from '@/components/ui/navigation/tabBadge/tabBadgeModel';
import type { SessionMobileSurface } from '@/components/workspaceCockpit/session/sessionCockpitState';
import { resolveAgentIdFromSessionMetadata } from '@happier-dev/agents';
import type { CockpitTabBarTabDefinition } from './CockpitTabBar';

export type SessionCockpitTabDefinition = CockpitTabBarTabDefinition<SessionMobileSurface> & Readonly<{ sfSymbol: string }>;

export function useSessionCockpitTabDefinitions(props: Readonly<{
    sessionId: string;
    terminalTabAvailable: boolean;
    openDetailsTabCount: number;
}>): readonly SessionCockpitTabDefinition[] {
    const sessionMetadata = useSessionMetadata(props.sessionId);
    const scmStatus = useSessionProjectScmStatus(props.sessionId);
    const gitBadgeMode = useSetting('tabBarGitBadgeMode');
    const openTabsBadgeEnabled = useSetting('tabBarOpenTabsBadgeEnabled');
    const chatAgentId = resolveAgentIdFromSessionMetadata(sessionMetadata);
    const gitBadge = resolveGitTabBadge(gitBadgeMode, scmStatus);
    return [
        {
            id: 'chat',
            label: chatAgentId ? t(getAgentCore(chatAgentId).displayNameKey) : t('status.unknown'),
            sfSymbol: 'bubble.left',
            icon: {
                render: ({ size, active }) => (
                    <AgentIcon agentId={chatAgentId} size={size} style={{ opacity: active ? 1 : 0.68 }} testID="session-cockpit-tab-chat-agent-icon" />
                ),
            },
        },
        { id: 'browse', label: t('common.files'), icon: 'folder', sfSymbol: 'folder' },
        { id: 'git', label: t('session.rightPanel.tabs.git'), icon: 'git-branch', sfSymbol: 'arrow.triangle.branch', badge: gitBadge ?? undefined },
        { id: 'navigation', label: t('session.transcriptNavigation.title'), icon: 'list', sfSymbol: 'list.bullet' },
        {
            id: 'tabs', label: t('workspaceCockpit.tabs'), icon: 'stack', sfSymbol: 'square.on.square',
            badge: openTabsBadgeEnabled && props.openDetailsTabCount > 0 ? { kind: 'count', value: props.openDetailsTabCount } : undefined,
        },
        ...(props.terminalTabAvailable
            ? [{ id: 'terminal', label: t('settings.terminal'), icon: 'terminal', sfSymbol: 'terminal' } satisfies SessionCockpitTabDefinition]
            : []),
    ];
}
