import { describe, expect, it } from 'vitest';

import { buildCodeLinesFromUnifiedDiff } from './buildCodeLinesFromUnifiedDiff';

describe('buildCodeLinesFromUnifiedDiff', () => {
    it('hides the file prelude by default when hunks exist', () => {
        const diff = [
            'diff --git a/src/a.ts b/src/a.ts',
            'index 1111111..2222222 100644',
            '--- a/src/a.ts',
            '+++ b/src/a.ts',
            '@@ -1,1 +1,1 @@',
            '-const a = 1;',
            '+const a = 2;',
        ].join('\n');

        const lines = buildCodeLinesFromUnifiedDiff({ unifiedDiff: diff });
        expect(lines.some((l) => (l.renderCodeText ?? '').startsWith('diff --git'))).toBe(false);
        expect(lines.some((l) => (l.renderCodeText ?? '').startsWith('index '))).toBe(false);
        expect(lines.some((l) => (l.renderCodeText ?? '').startsWith('--- '))).toBe(false);
        expect(lines.some((l) => (l.renderCodeText ?? '').startsWith('+++ '))).toBe(false);

        const hunk = lines.find((l) => (l.renderCodeText ?? '').startsWith('@@'))!;
        expect(hunk.sourceIndex).toBe(4);
    });

    it('hides the file prelude when hunk headers are indented', () => {
        const diff = [
            'diff --git a/src/a.ts b/src/a.ts',
            'index 1111111..2222222 100644',
            '--- a/src/a.ts',
            '+++ b/src/a.ts',
            '  @@ -1,1 +1,1 @@',
            '-const a = 1;',
            '+const a = 2;',
        ].join('\n');

        const lines = buildCodeLinesFromUnifiedDiff({ unifiedDiff: diff });
        expect(lines.some((l) => (l.renderCodeText ?? '').startsWith('diff --git'))).toBe(false);
        expect(lines.some((l) => (l.renderCodeText ?? '').startsWith('index '))).toBe(false);
        expect(lines.some((l) => (l.renderCodeText ?? '').startsWith('--- '))).toBe(false);
        expect(lines.some((l) => (l.renderCodeText ?? '').startsWith('+++ '))).toBe(false);

        const hunk = lines.find((l) => (l.renderCodeText ?? '').includes('@@ -1,1 +1,1 @@'))!;
        expect(hunk.sourceIndex).toBe(4);
    });

    it('assigns old/new line numbers for add/remove/context lines', () => {
        const diff = [
            'diff --git a/src/a.ts b/src/a.ts',
            '--- a/src/a.ts',
            '+++ b/src/a.ts',
            '@@ -1,2 +1,2 @@',
            '-const a = 1;',
            '+const a = 2;',
            ' const b = 3;',
        ].join('\n');

        const lines = buildCodeLinesFromUnifiedDiff({ unifiedDiff: diff });
        const body = lines.filter((l) => !l.renderIsHeaderLine);

        expect(body[0]).toMatchObject({
            kind: 'remove',
            oldLine: 1,
            newLine: null,
            renderPrefixText: '-',
            renderCodeText: 'const a = 1;',
        });

        expect(body[1]).toMatchObject({
            kind: 'add',
            oldLine: null,
            newLine: 1,
            renderPrefixText: '+',
            renderCodeText: 'const a = 2;',
        });

        expect(body[2]).toMatchObject({
            kind: 'context',
            oldLine: 2,
            newLine: 2,
            renderPrefixText: ' ',
            renderCodeText: 'const b = 3;',
        });
    });

    it('computes intra-line diff segments for paired remove/add lines when enabled', () => {
        const diff = [
            'diff --git a/src/a.ts b/src/a.ts',
            '--- a/src/a.ts',
            '+++ b/src/a.ts',
            '@@ -1,1 +1,1 @@',
            '-export function add(a:number,b:number){return a+b}',
            '+export function add(a: number, b: number) {',
        ].join('\n');

        const lines = buildCodeLinesFromUnifiedDiff({
            unifiedDiff: diff,
            intraLineDiff: {
                enabled: true,
                maxLines: 10_000,
                maxLineLength: 10_000,
            },
        });

        const body = lines.filter((l) => !l.renderIsHeaderLine);
        const removal = body.find((l) => l.kind === 'remove') as any;
        const addition = body.find((l) => l.kind === 'add') as any;

        expect(removal?.renderIntraLineDiffSegments?.some((s: any) => s.kind === 'removed')).toBe(true);
        expect(addition?.renderIntraLineDiffSegments?.some((s: any) => s.kind === 'added')).toBe(true);
    });

    it('limits intra-line diff work to maxPairs when provided', () => {
        const diff = [
            'diff --git a/src/a.ts b/src/a.ts',
            '--- a/src/a.ts',
            '+++ b/src/a.ts',
            '@@ -1,2 +1,2 @@',
            '-const a = 1;',
            '+const a = 2;',
            '-const b = 3;',
            '+const b = 4;',
        ].join('\n');

        const lines = buildCodeLinesFromUnifiedDiff({
            unifiedDiff: diff,
            intraLineDiff: {
                enabled: true,
                maxLines: 10_000,
                maxLineLength: 10_000,
                maxPairs: 1,
            },
        });

        const body = lines.filter((l) => !l.renderIsHeaderLine);
        const removes = body.filter((l) => l.kind === 'remove') as any[];
        const adds = body.filter((l) => l.kind === 'add') as any[];

        expect(removes[0]?.renderIntraLineDiffSegments?.some((s: any) => s.kind === 'removed')).toBe(true);
        expect(adds[0]?.renderIntraLineDiffSegments?.some((s: any) => s.kind === 'added')).toBe(true);

        // Second pair should not have computed intra-line segments due to budget.
        expect(removes[1]?.renderIntraLineDiffSegments).toBe(null);
        expect(adds[1]?.renderIntraLineDiffSegments).toBe(null);
    });

    it('hides the file prelude while preserving sourceIndex when requested and hunks exist', () => {
        const diff = [
            'diff --git a/src/a.ts b/src/a.ts',
            'index 1111111..2222222 100644',
            '--- a/src/a.ts',
            '+++ b/src/a.ts',
            '@@ -1,1 +1,1 @@',
            '-const a = 1;',
            '+const a = 2;',
        ].join('\n');

        const lines = buildCodeLinesFromUnifiedDiff({ unifiedDiff: diff, hideFilePrelude: true });

        expect(lines.some((l) => (l.renderCodeText ?? '').startsWith('diff --git'))).toBe(false);
        expect(lines.some((l) => (l.renderCodeText ?? '').startsWith('index '))).toBe(false);
        expect(lines.some((l) => (l.renderCodeText ?? '').startsWith('--- '))).toBe(false);
        expect(lines.some((l) => (l.renderCodeText ?? '').startsWith('+++ '))).toBe(false);

        const hunk = lines.find((l) => (l.renderCodeText ?? '').startsWith('@@'))!;
        expect(hunk.sourceIndex).toBe(4);

        const removal = lines.find((l) => l.kind === 'remove')!;
        const addition = lines.find((l) => l.kind === 'add')!;
        expect(removal.sourceIndex).toBe(5);
        expect(addition.sourceIndex).toBe(6);
    });

    it('does not hide the file prelude when there are no hunks', () => {
        const diff = [
            'diff --git a/assets/logo.png b/assets/logo.png',
            'new file mode 100644',
            'index 0000000..1111111',
            'Binary files /dev/null and b/assets/logo.png differ',
        ].join('\n');

        const lines = buildCodeLinesFromUnifiedDiff({ unifiedDiff: diff, hideFilePrelude: true });
        expect(lines.some((l) => (l.renderCodeText ?? '').startsWith('diff --git'))).toBe(true);
    });
});
