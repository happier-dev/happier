import { describe, expect, it } from 'vitest';

import { parseMarkdownBlock } from './parseMarkdownBlock';

function codeBlocksFrom(markdown: string) {
    return parseMarkdownBlock(markdown).filter((block) => block.type === 'code-block');
}

describe('parseMarkdownBlock (code fences)', () => {
    it('preserves shorter backtick fences inside a longer backtick code fence', () => {
        const markdown = [
            '````markdown',
            'FIRST',
            '```python',
            'INNER',
            '```',
            'AFTER',
            '````',
        ].join('\n');

        expect(parseMarkdownBlock(markdown)).toEqual([
            {
                type: 'code-block',
                language: 'markdown',
                content: ['FIRST', '```python', 'INNER', '```', 'AFTER'].join('\n'),
            },
        ]);
    });

    it('parses tilde code fences with embedded backtick fences as literal content', () => {
        const markdown = [
            '~~~markdown',
            'FIRST',
            '```python',
            'INNER',
            '```',
            'AFTER',
            '~~~',
        ].join('\n');

        expect(parseMarkdownBlock(markdown)).toEqual([
            {
                type: 'code-block',
                language: 'markdown',
                content: ['FIRST', '```python', 'INNER', '```', 'AFTER'].join('\n'),
            },
        ]);
    });

    it('removes matching indentation from content inside indented code fences', () => {
        const markdown = ['  ```ts', '  const x = 1;', '    const y = 2;', '  ```'].join('\n');

        expect(codeBlocksFrom(markdown)).toEqual([
            {
                type: 'code-block',
                language: 'ts',
                content: ['const x = 1;', '  const y = 2;'].join('\n'),
            },
        ]);
    });

    it('keeps closing-looking tilde fences with trailing info as content', () => {
        const markdown = ['~~~', '~~~ not-a-close', '~~~'].join('\n');

        expect(codeBlocksFrom(markdown)).toEqual([
            {
                type: 'code-block',
                language: null,
                content: '~~~ not-a-close',
            },
        ]);
    });

    it('keeps unclosed longer fences open until the end of the document', () => {
        const markdown = ['````txt', 'before', '```', 'after'].join('\n');

        expect(parseMarkdownBlock(markdown)).toEqual([
            {
                type: 'code-block',
                language: 'txt',
                content: ['before', '```', 'after'].join('\n'),
            },
        ]);
    });
});
