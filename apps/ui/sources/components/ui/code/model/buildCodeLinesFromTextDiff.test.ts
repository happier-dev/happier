import { describe, expect, it } from 'vitest';

import { buildCodeLinesFromTextDiff } from './buildCodeLinesFromTextDiff';

describe('buildCodeLinesFromTextDiff', () => {
    it('produces add/remove/context code lines from old/new text', () => {
        const oldText = 'a\nkeep\n';
        const newText = 'b\nkeep\n';

        const lines = buildCodeLinesFromTextDiff({ oldText, newText, contextLines: 1 });
        const body = lines.filter((l) => !l.renderIsHeaderLine);

        expect(body.some((l) => l.kind === 'remove' && l.renderCodeText.includes('a'))).toBe(true);
        expect(body.some((l) => l.kind === 'add' && l.renderCodeText.includes('b'))).toBe(true);
        expect(body.some((l) => l.kind === 'context' && l.renderCodeText.includes('keep'))).toBe(true);
    });
});
