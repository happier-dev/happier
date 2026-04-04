export type ProjectRightTabId = 'git' | 'files';

export function resolveProjectRightTabId(activeTabId: string | null | undefined): ProjectRightTabId {
    return activeTabId === 'files' ? 'files' : 'git';
}
