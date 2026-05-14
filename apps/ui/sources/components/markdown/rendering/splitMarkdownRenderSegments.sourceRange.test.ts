import { describe, expect, it } from 'vitest';

import { splitMarkdownRenderSegments } from './splitMarkdownRenderSegments';

describe('splitMarkdownRenderSegments source ranges', () => {
    it('assigns source line ranges to enriched and special markdown segments', () => {
        const segments = splitMarkdownRenderSegments({
            markdown: [
                '# Title',
                '',
                'Paragraph',
                '',
                '```ts',
                'const value = 1;',
                '```',
            ].join('\n'),
            streamingMode: 'static',
        });

        expect(segments.map((segment) => segment.sourceRange)).toEqual([
            { startLine: 1, endLine: 3 },
            { startLine: 5, endLine: 7 },
        ]);
    });
});
