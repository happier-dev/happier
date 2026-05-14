import { describe, expect, it } from 'vitest';

import { buildEnrichedMarkdownStyle } from '@/components/markdown/enriched/useEnrichedMarkdownStyle';
import { transcriptMarkdownTextStyle } from './transcriptMarkdownTypography';

const colors = {
    text: {
        primary: '#111111',
        secondary: '#666666',
        link: '#2255ff',
    },
    surface: {
        inset: '#f4f4f4',
        elevated: '#ffffff',
        selected: '#f8f8f8',
    },
    border: { default: '#dddddd' },
} as const;

function requireMarkdownStyle<T>(style: T | undefined, name: string): T {
    expect(style).toBeDefined();
    if (style === undefined) {
        throw new Error(`Expected markdown style ${name} to be defined`);
    }
    return style;
}

function requireNumber(value: number | undefined, name: string): number {
    expect(value).toEqual(expect.any(Number));
    if (typeof value !== 'number') {
        throw new Error(`Expected markdown style value ${name} to be a number`);
    }
    return value;
}

describe('transcriptMarkdownTypography', () => {
    it('keeps transcript text metrics without collapsing markdown block spacing', () => {
        const { markdownStyle } = buildEnrichedMarkdownStyle({
            colors,
            profile: 'transcript',
            uiFontScale: 1,
            textStyle: transcriptMarkdownTextStyle,
        });

        const paragraph = requireMarkdownStyle(markdownStyle.paragraph, 'paragraph');
        const h1 = requireMarkdownStyle(markdownStyle.h1, 'h1');
        const h2 = requireMarkdownStyle(markdownStyle.h2, 'h2');
        const h3 = requireMarkdownStyle(markdownStyle.h3, 'h3');
        const h4 = requireMarkdownStyle(markdownStyle.h4, 'h4');

        expect(paragraph).toMatchObject({ fontSize: 16, lineHeight: 24, marginTop: 0, marginBottom: 8 });
        expect(h1.marginTop).toBeGreaterThan(0);
        expect(h1.marginBottom).toBeGreaterThan(0);
        expect(h2).toMatchObject({ marginTop: 16, marginBottom: 8 });
        expect(requireNumber(h2.fontSize, 'h2.fontSize')).toBeGreaterThan(
            requireNumber(paragraph.fontSize, 'paragraph.fontSize'),
        );
        expect(h3.marginBottom).toBeGreaterThan(0);
        expect(h4.marginBottom).toBeGreaterThan(0);
        expect(markdownStyle.math).toMatchObject({ marginTop: 8, marginBottom: 8 });
        expect(markdownStyle.thematicBreak).toMatchObject({ marginTop: 8, marginBottom: 8 });
    });

    it('ignores margin values in caller text styles for thinking markdown structure', () => {
        const { markdownStyle } = buildEnrichedMarkdownStyle({
            colors,
            profile: 'thinking',
            uiFontScale: 1,
            textStyle: {
                fontSize: 14,
                lineHeight: 20,
                marginTop: 0,
                marginBottom: 0,
                color: '#555555',
                fontStyle: 'italic',
            },
        });

        const paragraph = requireMarkdownStyle(markdownStyle.paragraph, 'paragraph');
        const h1 = requireMarkdownStyle(markdownStyle.h1, 'h1');
        const h2 = requireMarkdownStyle(markdownStyle.h2, 'h2');
        const h3 = requireMarkdownStyle(markdownStyle.h3, 'h3');
        const h4 = requireMarkdownStyle(markdownStyle.h4, 'h4');

        expect(paragraph).toMatchObject({ fontSize: 14, lineHeight: 20, marginTop: 0, marginBottom: 8 });
        expect(h1.marginTop).toBeGreaterThan(0);
        expect(h1.marginBottom).toBeGreaterThan(0);
        expect(requireNumber(h2.fontSize, 'h2.fontSize')).toBeGreaterThan(
            requireNumber(paragraph.fontSize, 'paragraph.fontSize'),
        );
        expect(h2).toMatchObject({ marginTop: 16, marginBottom: 8 });
        expect(h3.marginBottom).toBeGreaterThan(0);
        expect(h4.marginBottom).toBeGreaterThan(0);
        expect(markdownStyle.math).toMatchObject({ marginTop: 8, marginBottom: 8 });
        expect(markdownStyle.thematicBreak).toMatchObject({ marginTop: 8, marginBottom: 8 });
    });
});
