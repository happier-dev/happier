import { describe, expect, it } from 'vitest';

import { buildDiffFileEntries, normalizeDiffFileInputs } from './diffViewModel';

describe('diffViewModel', () => {
    it('normalizes mixed input shapes into canonical diff inputs', () => {
        const normalized = normalizeDiffFileInputs({
            files: [
                { file_path: 'a.txt', unified_diff: '--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n' },
                { filePath: 'b.txt', oldText: 'old', newText: 'new' },
            ],
        });

        expect(normalized).toEqual([
            { filePath: 'a.txt', unifiedDiff: '--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n' },
            { filePath: 'b.txt', oldText: 'old', newText: 'new' },
        ]);
    });

    it('derives kind and stats from unified diff blocks', () => {
        const entries = buildDiffFileEntries([
            {
                unifiedDiff: [
                    'diff --git a/new.txt b/new.txt',
                    'new file mode 100644',
                    '--- /dev/null',
                    '+++ b/new.txt',
                    '@@ -0,0 +1 @@',
                    '+hello',
                ].join('\n'),
            },
        ]);

        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({
            filePath: 'new.txt',
            kind: 'new',
            added: 1,
            removed: 0,
        });
    });

    it('handles large text-pair stats without returning negative values', () => {
        const oldText = Array.from({ length: 15_000 }, (_, index) => `old-${index}`).join('\n');
        const newText = Array.from({ length: 16_000 }, (_, index) => `new-${index}`).join('\n');

        const entries = buildDiffFileEntries([
            {
                filePath: 'large.txt',
                oldText,
                newText,
            },
        ]);

        expect(entries).toHaveLength(1);
        expect(entries[0].added).toBeGreaterThanOrEqual(0);
        expect(entries[0].removed).toBeGreaterThanOrEqual(0);
    });
});
