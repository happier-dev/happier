import * as React from 'react';
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
    const tabs: readonly SessionCockpitTabDefinition[] = [
        { id: 'chat', label: t('common.message'), icon: 'chatbubble-ellipses-outline' },
        { id: 'browse', label: t('common.files'), icon: 'folder-outline' },
        { id: 'git', label: t('settings.sourceControl'), icon: 'git-branch-outline' },
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
