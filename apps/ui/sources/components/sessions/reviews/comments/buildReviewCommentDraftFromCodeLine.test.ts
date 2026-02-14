import { describe, expect, it } from 'vitest';

import { buildCodeLinesFromFile } from '@/components/ui/code/model/buildCodeLinesFromFile';
import { buildCodeLinesFromUnifiedDiff } from '@/components/ui/code/model/buildCodeLinesFromUnifiedDiff';

import { buildReviewCommentDraftFromCodeLine } from './buildReviewCommentDraftFromCodeLine';

describe('buildReviewCommentDraftFromCodeLine', () => {
    it('builds a diffLine anchor and snapshot for added lines', () => {
        const lines = buildCodeLinesFromUnifiedDiff({
            unifiedDiff: [
                'diff --git a/src/a.ts b/src/a.ts',
                '--- a/src/a.ts',
                '+++ b/src/a.ts',
                '@@ -1,1 +1,1 @@',
                '+const a = 2;',
            ].join('\n'),
        });
        const add = lines.find((l) => l.kind === 'add');
        if (!add) throw new Error('Expected an add line');

        const draft = buildReviewCommentDraftFromCodeLine({
            filePath: 'src/a.ts',
            source: 'diff',
            lines,
            targetLine: add,
            body: 'Please rename',
            contextRadius: 2,
            nowMs: 123,
            id: 'c1',
        });

        expect(draft).toMatchObject({
            id: 'c1',
            filePath: 'src/a.ts',
            source: 'diff',
            createdAt: 123,
            body: 'Please rename',
            anchor: {
                kind: 'diffLine',
                side: 'after',
                oldLine: null,
                newLine: add.newLine,
            },
        });
        expect(draft.snapshot.selectedLines).toEqual(['+const a = 2;']);
    });

    it('builds a fileLine anchor and snapshot for file lines', () => {
        const lines = buildCodeLinesFromFile({ text: ['const a = 1;', 'const b = 2;'].join('\n') });
        const second = lines[1]!;

        const draft = buildReviewCommentDraftFromCodeLine({
            filePath: 'src/b.ts',
            source: 'file',
            lines,
            targetLine: second,
            body: 'Consider extracting',
            contextRadius: 1,
            nowMs: 456,
            id: 'c2',
        });

        expect(draft.anchor).toEqual({ kind: 'fileLine', startLine: 2 });
        expect(draft.snapshot.selectedLines).toEqual(['const b = 2;']);
    });
});

