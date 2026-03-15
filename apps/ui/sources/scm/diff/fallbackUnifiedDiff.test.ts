import { describe, expect, it } from 'vitest';

import { buildAddedFileUnifiedDiff, countTextLines } from './fallbackUnifiedDiff';

describe('fallbackUnifiedDiff', () => {
    it('builds a unified diff for an added file', () => {
        const diff = buildAddedFileUnifiedDiff({
            filePath: 'src/new-file.txt',
            newText: 'hello\nworld\n',
        });

        expect(diff).toContain('diff --git a/src/new-file.txt b/src/new-file.txt');
        expect(diff).toContain('new file mode');
        expect(diff).toContain('--- /dev/null');
        expect(diff).toContain('+++ b/src/new-file.txt');
        expect(diff).toContain('+hello');
        expect(diff).toContain('+world');
    });

    it('counts text lines in a stable way', () => {
        expect(countTextLines('')).toBe(0);
        expect(countTextLines('a')).toBe(1);
        expect(countTextLines('a\n')).toBe(1);
        expect(countTextLines('a\nb')).toBe(2);
        expect(countTextLines('a\r\nb\r\n')).toBe(2);
    });
});
