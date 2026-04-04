import { describe, expect, it } from 'vitest';

import type { ScmFileStatus } from '@/scm/scmStatusFiles';

import { buildChangedFilesReviewRows } from './buildChangedFilesReviewRows';

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

describe('buildChangedFilesReviewRows', () => {
    it('flattens sections into a stable row list with fileIndex ordering', () => {
        const rows = buildChangedFilesReviewRows({
            sections: [
                { key: 's1', title: 'Section 1', files: [file('a.ts'), file('b.ts')] },
                { key: 's2', title: 'Section 2', files: [file('c.ts')] },
            ],
        });

        expect(rows.map((r) => r.kind)).toEqual(['section', 'file', 'file', 'section', 'file']);
        const fileRows = rows.filter((r) => r.kind === 'file') as any[];
        expect(fileRows.map((r) => r.fileIndex)).toEqual([0, 1, 2]);
        expect(fileRows.map((r) => r.file.fullPath)).toEqual(['a.ts', 'b.ts', 'c.ts']);
    });
});
