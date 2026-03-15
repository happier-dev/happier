import { describe, expect, it } from 'vitest';

import { looksLikeUnifiedDiff } from './looksLikeUnifiedDiff';

describe('looksLikeUnifiedDiff', () => {
    it('returns false for empty strings', () => {
        expect(looksLikeUnifiedDiff('')).toBe(false);
        expect(looksLikeUnifiedDiff('   ')).toBe(false);
    });

    it('returns false for header-only diffs (no hunks)', () => {
        // Some SCM backends emit diff headers for mode/rename/empty-file changes without hunks.
        // These are not reliably renderable by unified diff viewers (especially Pierre).
        expect(looksLikeUnifiedDiff('diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n')).toBe(false);
    });

    it('returns true for diffs containing hunk markers', () => {
        expect(looksLikeUnifiedDiff('@@ -1,1 +1,1 @@\n-foo\n+bar\n')).toBe(true);
    });

    it('returns false for binary placeholders', () => {
        expect(looksLikeUnifiedDiff('Binary files a/a.png and b/a.png differ')).toBe(false);
    });

    it('returns false for binary diffs that include diff headers (e.g. git emits Binary files lines)', () => {
        expect(
            looksLikeUnifiedDiff(
                [
                    'diff --git a/src/image.png b/src/image.png',
                    'new file mode 100644',
                    'index 0000000..e69de29',
                    'Binary files /dev/null and b/src/image.png differ',
                    '',
                ].join('\n'),
            ),
        ).toBe(false);
    });
});
