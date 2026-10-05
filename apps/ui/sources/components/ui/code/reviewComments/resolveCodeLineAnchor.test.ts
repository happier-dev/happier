import { describe, expect, it } from 'vitest';

import { buildCodeLinesFromFile } from '@/components/ui/code/model/buildCodeLinesFromFile';
import { buildCodeLinesFromUnifiedDiff } from '@/components/ui/code/model/buildCodeLinesFromUnifiedDiff';
import { computeLineContentHash } from '@/utils/text/lineContentHash';

import { resolveCodeLineAnchor } from './resolveCodeLineAnchor';

describe('resolveCodeLineAnchor', () => {
    it('resolves a raw deleted line and before context against their own coordinates', () => {
        const lines = buildCodeLinesFromUnifiedDiff({ unifiedDiff: '@@ -5,2 +8,2 @@\n-same();  \n+replacement();\n context();' });
        const deleted = resolveCodeLineAnchor({ filePath: 'a.ts', source: 'diff', lines, anchor: { kind: 'line', filePath: 'a.ts', side: 'before', line: 5, lineHash: computeLineContentHash('same();  ') } });
        expect(deleted.status).toBe('exact');
        expect(deleted.lines.map((line) => line.kind)).toEqual(['remove']);
        const context = resolveCodeLineAnchor({ filePath: 'a.ts', source: 'diff', lines, anchor: { kind: 'line', filePath: 'a.ts', side: 'before', line: 6, lineHash: computeLineContentHash('context();') } });
        expect(context.status).toBe('exact');
        expect(context.lines.map((line) => line.kind)).toEqual(['context']);
    });

    it('retains actual 0.2 prefixed ranges as qualified navigation', () => {
        // 0.2 HEAD 388915739: sessions/reviews/comments builder hashes each
        // full diff-prefixed line, including trailing whitespace.
        const lines = buildCodeLinesFromUnifiedDiff({ unifiedDiff: '@@ -1,2 +1,2 @@\n-old();  \n+new();\n context();' });
        const resolution = resolveCodeLineAnchor({ filePath: 'a.ts', source: 'diff', lines, anchor: {
            kind: 'range', filePath: 'a.ts', side: 'before', startLine: 1, endLine: 2,
            startLineHash: 'lh1:49a5bd338072b1e4', endLineHash: 'lh1:075110a65487fbfa',
            selectedTextHash: 'lh1:3cfc4af06c28ec10',
        } });
        expect(resolution.status).toBe('context');
        expect(resolution.lines.map((line) => line.kind)).toEqual(['remove', 'context']);
    });

    it('uses selected text to disambiguate repeated endpoints and preserves range length', () => {
        const lines = buildCodeLinesFromFile({ text: 'start\nwrong\nend\nstart\nselected\nend' });
        const resolution = resolveCodeLineAnchor({ filePath: 'a.ts', source: 'file', lines, anchor: {
            kind: 'range', filePath: 'a.ts', startLine: 20, endLine: 22,
            startLineHash: computeLineContentHash('start'), endLineHash: computeLineContentHash('end'),
            selectedTextHash: computeLineContentHash('start\nselected\nend'),
        } });
        expect(resolution.status).toBe('hash');
        expect(resolution.lines.map((line) => line.newLine)).toEqual([4, 5, 6]);
    });

    it('qualifies missing hashes and rejects ambiguous, stale and wrong-source matches', () => {
        const lines = buildCodeLinesFromFile({ text: 'same\nsame\nlast  ' });
        expect(resolveCodeLineAnchor({ filePath: 'a.ts', source: 'file', lines, anchor: { kind: 'fileLine', startLine: 1 } }).status).toBe('context');
        expect(resolveCodeLineAnchor({ filePath: 'a.ts', source: 'file', lines, anchor: { kind: 'line', filePath: 'a.ts', line: 99, lineHash: computeLineContentHash('same') } }).status).toBe('ambiguous');
        expect(resolveCodeLineAnchor({ filePath: 'a.ts', source: 'file', lines, anchor: { kind: 'line', filePath: 'a.ts', line: 3, lineHash: computeLineContentHash('last') } }).status).toBe('stale');
        expect(resolveCodeLineAnchor({ filePath: 'a.ts', source: 'file', lines, anchor: { kind: 'line', filePath: 'a.ts', line: 1, side: 'before' } }).status).toBe('unsupported');
    });

    it('uses the existing workspace-reference path normalization for cross-platform navigation', () => {
        const lines = buildCodeLinesFromFile({ text: 'same' });
        expect(resolveCodeLineAnchor({ filePath: 'src/a.ts', source: 'file', lines, anchor: { kind: 'line', filePath: '.\\src\\a.ts', line: 1 } }).status).toBe('context');
    });
});
