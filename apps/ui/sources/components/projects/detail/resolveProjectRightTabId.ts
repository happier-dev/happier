export type ProjectRightTabId = 'git' | 'files';

export function resolveProjectRightTabId(activeTabId: string | null | undefined): ProjectRightTabId {
    return activeTabId === 'git' ? 'git' : 'files';
}
