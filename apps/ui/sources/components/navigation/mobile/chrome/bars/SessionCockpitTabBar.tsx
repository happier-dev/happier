import * as React from 'react';

import { AgentIcon } from '@/agents/registry/AgentIcon';
import { DEFAULT_AGENT_ID, getAgentCore, resolveAgentIdFromFlavor } from '@/agents/catalog/catalog';
import { t } from '@/text';
import { useSessionMetadata, useSessionProjectScmStatus, useSetting } from '@/sync/domains/state/storage';
import { resolveGitTabBadge } from '@/components/ui/navigation/tabBadge/tabBadgeModel';
import type { SessionMobileSurface } from '@/components/workspaceCockpit/session/sessionCockpitState';
import { useSessionLateralSwipe } from '@/components/workspaceCockpit/session/SessionCockpitChromeRegistry';
import { resolveAgentIdFromSessionMetadata } from '@happier-dev/agents';

import { SessionCockpitLateralReadout } from '../lateralSwipe/SessionCockpitLateralReadout';
import { useSessionCockpitLateralNavigation } from '../lateralSwipe/useSessionCockpitLateralNavigation';
import { CockpitTabBar, type CockpitTabBarTabDefinition } from './CockpitTabBar';

type SessionCockpitTabBarProps = Readonly<{
    sessionId: string;
    activeSurface: SessionMobileSurface;
    terminalTabAvailable: boolean;
    openDetailsTabCount: number;
    onSurfacePress: (surface: SessionMobileSurface) => void;
}>;

const PREVIOUS_SESSION_ACTION = 'previousSession';
const NEXT_SESSION_ACTION = 'nextSession';

type SessionCockpitTabDefinition = Readonly<{
    id: SessionMobileSurface;
    label: string;
    icon: CockpitTabBarTabDefinition<SessionMobileSurface>['icon'];
    badge?: CockpitTabBarTabDefinition<SessionMobileSurface>['badge'];
}>;

export const SessionCockpitTabBar = React.memo((props: SessionCockpitTabBarProps) => {
    const lateralSwipe = useSessionLateralSwipe();
    // The band's actions are built HERE rather than in the chrome host because a tab is
    // the only element in the band a screen reader can focus, and an action only reaches
    // the rotor through the element that owns it.
    const lateralNavigation = useSessionCockpitLateralNavigation({ sessionId: props.sessionId });
    const bandAccessibilityActions = React.useMemo(() => {
        const actions: Array<{ name: string; label: string }> = [];
        if (lateralNavigation.previous) {
            actions.push({ name: PREVIOUS_SESSION_ACTION, label: t('workspaceCockpit.previousSession') });
        }
        if (lateralNavigation.next) {
            actions.push({ name: NEXT_SESSION_ACTION, label: t('workspaceCockpit.nextSession') });
        }
        return actions.length > 0 ? actions : undefined;
    }, [lateralNavigation.next, lateralNavigation.previous]);
    const handleBandAccessibilityAction = React.useCallback((actionName: string) => {
        if (actionName === PREVIOUS_SESSION_ACTION) lateralNavigation.navigate('previous');
        else if (actionName === NEXT_SESSION_ACTION) lateralNavigation.navigate('next');
    }, [lateralNavigation]);
    const sessionMetadata = useSessionMetadata(props.sessionId);
    const scmStatus = useSessionProjectScmStatus(props.sessionId);
    const gitBadgeMode = useSetting('tabBarGitBadgeMode');
    const openTabsBadgeEnabled = useSetting('tabBarOpenTabsBadgeEnabled');
    const chatAgentId =
        resolveAgentIdFromSessionMetadata(sessionMetadata)
        ?? resolveAgentIdFromFlavor(sessionMetadata?.flavor)
        ?? DEFAULT_AGENT_ID;
    const gitBadge = resolveGitTabBadge(gitBadgeMode, scmStatus);
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
        { id: 'browse', label: t('common.files'), icon: 'folder' },
        {
            id: 'git',
            label: t('session.rightPanel.tabs.git'),
            icon: 'git-branch',
            badge: gitBadge ?? undefined,
        },
        { id: 'navigation', label: t('session.transcriptNavigation.title'), icon: 'list' },
        {
            id: 'tabs',
            label: t('workspaceCockpit.tabs'),
            icon: 'stack',
            badge: openTabsBadgeEnabled && props.openDetailsTabCount > 0
                ? { kind: 'count', value: props.openDetailsTabCount }
                : undefined,
        },
        ...(props.terminalTabAvailable
            ? [{ id: 'terminal', label: t('settings.terminal'), icon: 'terminal' } satisfies SessionCockpitTabDefinition]
            : []),
    ];

    return (
        <CockpitTabBar
            activeSurface={props.activeSurface}
            barTestId={`session-cockpit-tabbar-${props.sessionId}`}
            tabs={tabs}
            tabTestIdPrefix="session-cockpit-tab-"
            onSurfacePress={props.onSurfacePress}
            bandAccessibilityActions={bandAccessibilityActions}
            onBandAccessibilityAction={bandAccessibilityActions ? handleBandAccessibilityAction : undefined}
            swipeReadout={{
                progress: lateralSwipe.progress,
                browseProgress: lateralSwipe.picker.browseProgress,
                node: <SessionCockpitLateralReadout sessionId={props.sessionId} />,
            }}
        />
    );
});
