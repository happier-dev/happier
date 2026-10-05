import type { ScmComparison } from '@happier-dev/protocol';
import { projectChangedFilesAsScmSnapshot, type ScmFileStatus } from '@/scm/scmStatusFiles';
import { countHunkLines, splitUnifiedDiffHunks } from './comparisonOccurrences';

/** A renderer projection of saved evidence. It carries no working-copy capabilities. */
export function buildCapturedComparisonFiles(comparison: ScmComparison) {
    const diffByPath = new Map<string, string | null>();
    const unavailableByPath = new Map<string, string>();
    const files: ScmFileStatus[] = comparison.inventory.files.map((file) => {
        const diff = file.evidence.unifiedDiff;
        diffByPath.set(file.path, diff ?? null);
        if (file.evidence.state === 'unavailable') unavailableByPath.set(file.path, file.evidence.reason);
        const counts = splitUnifiedDiffHunks(diff ?? '').map(countHunkLines);
        const segments = file.path.split('/');
        const kind = file.changeKind;
        const status: ScmFileStatus['status'] = kind === 'added' || kind === 'deleted' || kind === 'renamed'
            || kind === 'copied' || kind === 'untracked' || kind === 'conflicted' ? kind : 'modified';
        return { fileName: segments.at(-1) ?? file.path, filePath: segments.slice(0, -1).join('/'), fullPath: file.path,
            status, isIncluded: false, linesAdded: counts.reduce((sum, count) => sum + count.added, 0),
            linesRemoved: counts.reduce((sum, count) => sum + count.removed, 0),
            ...(file.previousPath ? { oldPath: file.previousPath } : {}),
            ...(file.binary === null ? {} : { isBinary: file.binary }),
            isComplete: file.evidence.state === 'available' && file.binary === false };
    });
    return { files, diffByPath, unavailableByPath, snapshot: projectChangedFilesAsScmSnapshot(files,
        { projectKey: comparison.id, rootPath: comparison.repository.rootPath }) };
}
