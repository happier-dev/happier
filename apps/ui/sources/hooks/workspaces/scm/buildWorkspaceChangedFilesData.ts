import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { snapshotToScmStatusFiles, type ScmFileStatus, type ScmStatusFiles } from '@/scm/scmStatusFiles';
import { buildAllRepositoryChangedFiles } from '@/components/sessions/files/filesUtils';

export type WorkspaceChangedFilesData = Readonly<{
    scmStatusFiles: ScmStatusFiles | null;
    changedFilesCount: number;
    allRepositoryChangedFiles: ScmFileStatus[];
}>;

export function buildWorkspaceChangedFilesData(input: Readonly<{
    scmSnapshot: ScmWorkingSnapshot | null;
}>): WorkspaceChangedFilesData {
    const scmStatusFiles = (() => {
        if (!input.scmSnapshot?.repo.isRepo) return null;
        return snapshotToScmStatusFiles(input.scmSnapshot);
    })();

    const changedFilesCount = (scmStatusFiles?.totalIncluded ?? 0) + (scmStatusFiles?.totalPending ?? 0);
    const allRepositoryChangedFiles = buildAllRepositoryChangedFiles(scmStatusFiles);

    return {
        scmStatusFiles,
        changedFilesCount,
        allRepositoryChangedFiles,
    };
}
