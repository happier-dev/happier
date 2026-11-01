import { describe, expect, it } from 'vitest';

import { parseMarkdownBlock } from './parseMarkdownBlock';

describe('parseMarkdownBlock (options)', () => {
    it('parses a continuation message without an opening wrapper and preserves following prose', () => {
        expect(parseMarkdownBlock([
            '  <option>Continue</option>  ',
            '<option>Review first</option>',
            '</options>',
            'More context',
        ].join('\n'), { includeSourceRanges: true })).toEqual([
            { type: 'options', items: ['Continue', 'Review first'], sourceRange: { startLine: 1, endLine: 3 } },
            { type: 'text', content: [{ styles: [], text: 'More context', url: null }], sourceRange: { startLine: 4, endLine: 4 } },
        ]);
    });

    it('accepts a dedicated option line without either wrapper', () => {
        expect(parseMarkdownBlock('<option>Continue</option>')).toEqual([
            { type: 'options', items: ['Continue'] },
        ]);
    });

    it.each([
        'Mention <option>Continue</option> in a sentence.',
        '<option>Continue</option> is an example.',
        '<option>Still arriving',
    ])('keeps prose and unfinished option lines as text: %s', (markdown) => {
        expect(parseMarkdownBlock(markdown).map((block) => block.type)).toEqual(['text']);
    });

    it('keeps option examples inside fenced code as code', () => {
        expect(parseMarkdownBlock('```xml\n<option>Continue</option>\n```')).toEqual([
            { type: 'code-block', language: 'xml', content: '<option>Continue</option>' },
        ]);
    });
});
