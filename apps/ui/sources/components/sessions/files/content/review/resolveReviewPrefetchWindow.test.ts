import { describe, expect, it } from 'vitest';

import type { ScmFileStatus } from '@/scm/scmStatusFiles';

import { buildChangedFilesReviewRows } from './buildChangedFilesReviewRows';
import { resolveReviewPrefetchWindow } from './resolveReviewPrefetchWindow';

function file(path: string): ScmFileStatus {
    return {
        fullPath: path,
        relativePath: path,
        name: path.split('/').pop() ?? path,
        status: 'modified',
        isIncluded: false,
        kind: 'file',
        isDeleted: false,
        linesAdded: 1,
        linesRemoved: 1,
    } as any;
}

describe('resolveReviewPrefetchWindow', () => {
    it('computes ahead/behind window in terms of fileIndex (ignoring section rows)', () => {
        const rows = buildChangedFilesReviewRows({
            sections: [
                { key: 's1', title: 'S1', files: [file('a.ts'), file('b.ts')] },
                { key: 's2', title: 'S2', files: [file('c.ts')] },
            ],
        });
        // rows: section(0), a(1 fileIndex 0), b(2 fileIndex 1), section(3), c(4 fileIndex 2)
        const window = resolveReviewPrefetchWindow({
            rows,
            viewableRowIndices: [2, 3], // b + section header
            aheadCount: 1,
            behindCount: 1,
            maxFileIndex: 2,
        });

        // Prefetch should never include files *above* the first visible file index, because loading
        // those diffs can change heights above the viewport and cause scroll "snap back" on web.
        expect(window).toEqual({ startFileIndex: 1, endFileIndex: 2 });
    });
});
