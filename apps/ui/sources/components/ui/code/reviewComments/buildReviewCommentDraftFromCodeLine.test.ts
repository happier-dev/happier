import { describe, expect, it } from 'vitest';

import { buildCodeLinesFromFile } from '@/components/ui/code/model/buildCodeLinesFromFile';
import { buildCodeLinesFromUnifiedDiff } from '@/components/ui/code/model/buildCodeLinesFromUnifiedDiff';
import { computeLineContentHash } from '@/utils/text/lineContentHash';

import {
    buildReviewCommentDraftFromCodeLine,
    buildReviewCommentDraftFromCodeLineRange,
    buildReviewCommentDraftFromMarkdownRange,
} from './buildReviewCommentDraftFromCodeLine';

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
                lineHash: computeLineContentHash('const a = 2;'),
            },
        });
        expect(draft.snapshot.selectedLines).toEqual(['const a = 2;']);
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

        expect(draft.anchor).toEqual({ kind: 'fileLine', startLine: 2, lineHash: computeLineContentHash('const b = 2;') });
        expect(draft.snapshot.selectedLines).toEqual(['const b = 2;']);
    });

    it('builds a normalized range anchor and snapshot from file line ranges', () => {
        const lines = buildCodeLinesFromFile({ text: ['const a = 1;', 'const b = 2;', 'const c = 3;'].join('\n') });

        const draft = buildReviewCommentDraftFromCodeLineRange({
            filePath: 'src/range.ts',
            source: 'file',
            lines,
            rangeLines: [lines[0]!, lines[1]!],
            body: 'Review these together',
            contextRadius: 1,
            nowMs: 789,
            id: 'range-1',
        });

        expect(draft).toMatchObject({
            id: 'range-1',
            filePath: 'src/range.ts',
            source: 'file',
            createdAt: 789,
            body: 'Review these together',
            anchor: {
                kind: 'range',
                filePath: 'src/range.ts',
                startLine: 1,
                endLine: 2,
                startLineHash: computeLineContentHash('const a = 1;'),
                endLineHash: computeLineContentHash('const b = 2;'),
            },
        });
        expect(draft.snapshot.selectedLines).toEqual(['const a = 1;', 'const b = 2;']);
        expect(draft.snapshot.afterContext).toEqual(['const c = 3;']);
    });

    it('builds a normalized range anchor and snapshot from diff line ranges', () => {
        const lines = buildCodeLinesFromUnifiedDiff({
            unifiedDiff: [
                'diff --git a/src/a.ts b/src/a.ts',
                '--- a/src/a.ts',
                '+++ b/src/a.ts',
                '@@ -1,2 +1,2 @@',
                '-const a = 1;',
                '+const a = 2;',
                '+const b = 2;',
            ].join('\n'),
        });
        const rangeLines = lines.filter((line) => line.kind === 'add');

        const draft = buildReviewCommentDraftFromCodeLineRange({
            filePath: 'src/a.ts',
            source: 'diff',
            lines,
            rangeLines,
            body: 'Both added lines',
            contextRadius: 1,
            nowMs: 987,
            id: 'range-2',
        });

        expect(draft.anchor).toMatchObject({
            kind: 'range',
            filePath: 'src/a.ts',
            startLine: 1,
            endLine: 2,
            side: 'after',
            startLineHash: computeLineContentHash('const a = 2;'),
            endLineHash: computeLineContentHash('const b = 2;'),
            selectedTextHash: computeLineContentHash('const a = 2;\nconst b = 2;'),
        });
        expect(draft.snapshot.selectedLines).toEqual(['const a = 2;', 'const b = 2;']);
    });

    it('preserves trailing whitespace in file and diff identities', () => {
        for (const source of ['file', 'diff'] as const) {
            const lines = source === 'file'
                ? buildCodeLinesFromFile({ text: 'same();  ' })
                : buildCodeLinesFromUnifiedDiff({ unifiedDiff: '@@ -1 +1 @@\n-same();\n+same();  ' });
            const targetLine = lines.find((line) => line.kind === (source === 'file' ? 'file' : 'add'))!;
            const draft = buildReviewCommentDraftFromCodeLine({ filePath: 'a.ts', source, lines, targetLine, body: 'Whitespace', contextRadius: 0, id: 'space', nowMs: 1 });
            expect(draft.anchor).toMatchObject({ lineHash: computeLineContentHash('same();  ') });
            expect(draft.snapshot.selectedLines).toEqual(['same();  ']);
        }
    });

    it('rejects a range spanning both diff sides instead of inventing one file range', () => {
        const lines = buildCodeLinesFromUnifiedDiff({ unifiedDiff: '@@ -1 +1 @@\n-old();\n+new();' });
        expect(() => buildReviewCommentDraftFromCodeLineRange({ filePath: 'a.ts', source: 'diff', lines, rangeLines: lines.filter((line) => !line.renderIsHeaderLine), body: 'Both sides', contextRadius: 0, id: 'mixed', nowMs: 1 })).toThrow('review_comment_range_requires_one_side');
    });

    it('captures a before range with context rows and excludes interleaved additions', () => {
        const lines = buildCodeLinesFromUnifiedDiff({ unifiedDiff: '@@ -1,3 +1,3 @@\n first();\n-old();\n+new();\n last();' });
        const rangeLines = lines.filter((line) => !line.renderIsHeaderLine && line.kind !== 'add');
        const draft = buildReviewCommentDraftFromCodeLineRange({ filePath: 'a.ts', source: 'diff', lines, rangeLines, body: 'Before', contextRadius: 0, id: 'before', nowMs: 1 });
        expect(draft.anchor).toMatchObject({ kind: 'range', side: 'before', startLine: 1, endLine: 3, selectedTextHash: computeLineContentHash('first();\nold();\nlast();') });
        expect(draft.snapshot.selectedLines).toEqual(['first();', 'old();', 'last();']);
    });

    it('builds a normalized range anchor and snapshot from markdown source ranges', () => {
        const markdown = [
            '# Title',
            '',
            'Paragraph',
            '',
            'Next',
        ].join('\n');

        const draft = buildReviewCommentDraftFromMarkdownRange({
            filePath: 'README.md',
            markdown,
            sourceRange: { startLine: 1, endLine: 3 },
            body: 'Clarify this section',
            contextRadius: 1,
            nowMs: 321,
            id: 'markdown-1',
        });

        expect(draft).toMatchObject({
            id: 'markdown-1',
            filePath: 'README.md',
            source: 'file',
            body: 'Clarify this section',
            createdAt: 321,
            anchor: {
                kind: 'range',
                filePath: 'README.md',
                startLine: 1,
                endLine: 3,
                startLineHash: computeLineContentHash('# Title'),
                endLineHash: computeLineContentHash('Paragraph'),
            },
        });
        expect(draft.snapshot.selectedLines).toEqual(['# Title', 'Paragraph']);
        expect(draft.snapshot.afterContext).toEqual(['Next']);
    });
});
