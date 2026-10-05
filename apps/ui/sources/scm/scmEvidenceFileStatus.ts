import type { FileChangeEvidence } from '@happier-dev/protocol';

import { deriveFileChangeDiff } from '@/sync/domains/session/changes/derivation/deriveFileChangeDiff';

import type { ScmFileStatus } from './scmStatusFiles';

function mapEvidenceChangeKindToStatus(kind: FileChangeEvidence['changeKind']): ScmFileStatus['status'] {
    if (kind === 'added') return 'added';
    if (kind === 'deleted') return 'deleted';
    if (kind === 'renamed') return 'renamed';
    if (kind === 'copied') return 'copied';
    return 'modified';
}

function countUnifiedDiffStats(diff: string | null | undefined): Pick<ScmFileStatus, 'linesAdded' | 'linesRemoved'> {
    if (!diff) return { linesAdded: 0, linesRemoved: 0 };
    let linesAdded = 0;
    let linesRemoved = 0;
    for (const line of diff.split('\n')) {
        if (line.startsWith('+++') || line.startsWith('---')) continue;
        if (line.startsWith('+')) {
            linesAdded += 1;
            continue;
        }
        if (line.startsWith('-')) {
            linesRemoved += 1;
        }
    }
    return { linesAdded, linesRemoved };
}

/**
 * One changed file from turn or Session evidence, as a changed-file row. Line counts come from the
 * evidence's own statistics, then its diff; with neither the row says its counts are unknown
 * (`isComplete: false`) instead of claiming an empty change.
 */
export function buildScmFileStatusFromChangeEvidence(file: FileChangeEvidence): ScmFileStatus {
    const fullPath = file.filePath;
    const segments = fullPath.split('/');
    const fileName = segments[segments.length - 1] || fullPath;
    const filePath = segments.slice(0, -1).join('/');
    const diff = deriveFileChangeDiff(file);
    const stats = countUnifiedDiffStats(diff);
    return {
        fileName,
        filePath,
        fullPath,
        status: mapEvidenceChangeKindToStatus(file.changeKind),
        isIncluded: false,
        linesAdded: file.stats?.addedLines ?? stats.linesAdded,
        linesRemoved: file.stats?.removedLines ?? stats.linesRemoved,
        oldPath: file.previousFilePath ?? undefined,
        isBinary: file.binary,
        ...(diff === null && !file.stats ? { isComplete: false } : {}),
    };
}
