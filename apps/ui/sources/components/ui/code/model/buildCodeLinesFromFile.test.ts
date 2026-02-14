import { describe, expect, it } from 'vitest';

import { buildCodeLinesFromFile } from './buildCodeLinesFromFile';

describe('buildCodeLinesFromFile', () => {
    it('assigns 1-based line numbers', () => {
        const lines = buildCodeLinesFromFile({ text: 'a\nB\n' });
        expect(lines).toHaveLength(2);
        expect(lines[0]).toMatchObject({ kind: 'file', newLine: 1, renderCodeText: 'a' });
        expect(lines[1]).toMatchObject({ kind: 'file', newLine: 2, renderCodeText: 'B' });
    });
});
