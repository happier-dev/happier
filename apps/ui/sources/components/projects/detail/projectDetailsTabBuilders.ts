import type { DetailsTab } from '@/components/appShell/panes/details/workspace/detailsWorkspaceTypes';
import { t } from '@/text';

export function createProjectCommitDetailsTab(sha: string): DetailsTab | null {
    const safeSha = sha.trim().split(/\s+/)[0] ?? '';
    if (!safeSha) return null;
    return {
        key: `commit:${safeSha}`,
        kind: 'commit',
        title: safeSha.slice(0, 7),
        resource: { kind: 'commit', sha: safeSha },
    };
}

/**
 * The Project's own details (name, Machine, path) and where it is available (Machines with a checkout, Add machine):
 * the existing workspace-info surface, opened from the Project's menu (Lane 12 Fork C ruling 2026-11-13).
 */
export function createProjectInfoDetailsTab(): DetailsTab {
    return { key: 'workspaceInfo', kind: 'workspaceInfo', title: t('workspaceSync.availableOn'), resource: { kind: 'workspaceInfo' } };
}
