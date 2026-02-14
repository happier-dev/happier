import { describe, expect, it } from 'vitest';

import { tokenizeSimpleSyntaxText } from './simpleSyntaxTokenizer';

describe('simpleSyntaxTokenizer', () => {
    it('tokenizes multi-line input and preserves newlines', () => {
        const tokens = tokenizeSimpleSyntaxText({
            text: ['const x = 1;', '// hello'].join('\n'),
            language: 'ts',
        });

        expect(tokens.some((t) => t.text === '\n')).toBe(true);
        expect(tokens.some((t) => t.type === 'keyword' && t.text.includes('const'))).toBe(true);
        expect(tokens.some((t) => t.type === 'number' && t.text.includes('1'))).toBe(true);
        expect(tokens.some((t) => t.type === 'comment' && t.text.includes('// hello'))).toBe(true);
    });
});

