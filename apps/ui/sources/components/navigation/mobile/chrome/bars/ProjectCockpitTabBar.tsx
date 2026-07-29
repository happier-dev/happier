import * as React from 'react';
import { t } from '@/text';
import type { ProjectMobileSurface } from '@/components/workspaceCockpit/project/projectCockpitState';
import { CockpitTabBar, type CockpitTabBarTabDefinition } from './CockpitTabBar';

type ProjectCockpitTabBarProps = Readonly<{
    workspaceRefId: string;
    activeSurface: ProjectMobileSurface;
    onSurfacePress: (surface: ProjectMobileSurface) => void;
}>;

type ProjectCockpitTabDefinition = Readonly<{
    id: ProjectMobileSurface;
    label: string;
    icon: CockpitTabBarTabDefinition<ProjectMobileSurface>['icon'];
}>;

export const ProjectCockpitTabBar = React.memo((props: ProjectCockpitTabBarProps) => {
    const tabs: readonly ProjectCockpitTabDefinition[] = [
        { id: 'overview', label: t('diagnosis.sections.overview'), icon: 'grid-outline' },
        { id: 'browse', label: t('common.files'), icon: 'folder-outline' },
        { id: 'git', label: t('session.rightPanel.tabs.git'), icon: 'git-branch-outline' },
        { id: 'tabs', label: t('common.tabs'), icon: 'albums-outline' },
        { id: 'browser', label: t('browserSurface.title'), icon: 'globe-outline' },
        { id: 'services', label: t('localServices.inventory.title'), icon: 'server-outline' },
        { id: 'terminal', label: t('settings.terminal'), icon: 'terminal-outline' },
    ];

    return (
        <CockpitTabBar
            activeSurface={props.activeSurface}
            barTestId={`project-cockpit-tabbar-${props.workspaceRefId}`}
            tabs={tabs}
            tabTestIdPrefix="project-cockpit-tab-"
            onSurfacePress={props.onSurfacePress}
        />
    );
});
