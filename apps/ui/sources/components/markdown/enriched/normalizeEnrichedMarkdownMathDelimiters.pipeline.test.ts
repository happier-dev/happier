import { describe, expect, it } from 'vitest';

import { splitMarkdownRenderSegments } from '../rendering/splitMarkdownRenderSegments';
import {
    containsRenderableEnrichedMarkdownMath,
    normalizeEnrichedMarkdownMathDelimiters,
} from './normalizeEnrichedMarkdownMathDelimiters';

describe('enriched Markdown math normalization pipeline', () => {
    it('normalizes enriched prose after code blocks have been separated', () => {
        const segments = splitMarkdownRenderSegments({
            markdown: [
                'Before \\(x\\).',
                '',
                '```tex',
                '\\(fenced code\\)',
                '```',
                '',
                '    \\(indented code\\)',
                '',
                'After \\(y\\).',
            ].join('\n'),
            streamingMode: 'static',
        });

        const specialMarkdown = segments
            .filter((segment) => segment.type === 'special-block')
            .map((segment) => segment.markdown);
        const normalizedEnrichedMarkdown = segments
            .filter((segment) => segment.type === 'enriched-markdown')
            .map((segment) => normalizeEnrichedMarkdownMathDelimiters(segment.markdown));

        expect(specialMarkdown).toEqual([
            '```tex\n\\(fenced code\\)\n```',
        ]);
        expect(normalizedEnrichedMarkdown).toEqual([
            'Before $x$.',
            '    \\(indented code\\)\n\nAfter $y$.',
        ]);
    });

    it('keeps list math in the enriched renderer path', () => {
        const segments = splitMarkdownRenderSegments({
            markdown: '- Area \\(A\\)',
            streamingMode: 'static',
        });

        expect(segments).toHaveLength(1);
        expect(segments[0]).toMatchObject({
            type: 'enriched-markdown',
            markdown: '- Area \\(A\\)',
        });
        expect(normalizeEnrichedMarkdownMathDelimiters(segments[0]!.markdown)).toBe('- Area $A$');
    });

    it('identifies math cells inside legacy-owned table segments', () => {
        const segments = splitMarkdownRenderSegments({
            markdown: [
                '| Formula | Existing | Plain |',
                '|---|---|---|',
                '| \\(x_i\\) | $y_i$ | value |',
            ].join('\n'),
            streamingMode: 'static',
        });

        expect(segments).toHaveLength(1);
        expect(segments[0]?.type).toBe('special-block');
        if (segments[0]?.type !== 'special-block') throw new Error('Expected a table special block');

        const table = segments[0].blocks.find((block) => block.type === 'table');
        expect(table?.type).toBe('table');
        if (table?.type !== 'table') throw new Error('Expected a parsed table');

        expect(table.rows[0]?.map(containsRenderableEnrichedMarkdownMath)).toEqual([
            true,
            true,
            false,
        ]);
    });
});
