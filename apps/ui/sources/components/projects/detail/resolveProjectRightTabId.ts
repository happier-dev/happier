import {
    resolveRightSidebarActiveTab,
    resolveProjectRightSidebarTabs,
    type ProjectRightSidebarTabId,
} from '@/components/appShell/rightSidebar/rightSidebarTabRegistry';

export type ProjectRightTabId = ProjectRightSidebarTabId;

export function resolveProjectRightTabId(activeTabId: string | null | undefined): ProjectRightTabId {
    return resolveRightSidebarActiveTab<ProjectRightTabId>(
        activeTabId,
        resolveProjectRightSidebarTabs(),
    );
}
