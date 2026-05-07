import { describe, expect, it } from 'vitest';

import { buildEnrichedMarkdownStyle } from '@/components/markdown/enriched/useEnrichedMarkdownStyle';
import { transcriptMarkdownTextStyle } from './transcriptMarkdownTypography';

const colors = {
    text: '#111111',
    textSecondary: '#666666',
    textLink: '#2255ff',
    surfaceHigh: '#f4f4f4',
    surfaceHighest: '#ffffff',
    divider: '#dddddd',
} as const;

describe('transcriptMarkdownTypography', () => {
    it('preserves zero block margins in transcript markdown styles', () => {
        const { markdownStyle } = buildEnrichedMarkdownStyle({
            colors,
            profile: 'transcript',
            uiFontScale: 1,
            textStyle: transcriptMarkdownTextStyle,
        });

        expect(markdownStyle.paragraph).toMatchObject({ marginTop: 0, marginBottom: 0 });
        expect(markdownStyle.h1).toMatchObject({ marginTop: 0, marginBottom: 0 });
        expect(markdownStyle.h2).toMatchObject({ marginTop: 0, marginBottom: 0 });
        expect(markdownStyle.h3).toMatchObject({ marginTop: 0, marginBottom: 0 });
        expect(markdownStyle.h4).toMatchObject({ marginTop: 0, marginBottom: 0 });
        expect(markdownStyle.math).toMatchObject({ marginTop: 0, marginBottom: 0 });
        expect(markdownStyle.thematicBreak).toMatchObject({ marginTop: 0, marginBottom: 0 });
    });

    it('preserves zero block margins for thinking-style overrides', () => {
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

        expect(markdownStyle.paragraph).toMatchObject({ marginTop: 0, marginBottom: 0 });
        expect(markdownStyle.h1).toMatchObject({ marginTop: 0, marginBottom: 0 });
        expect(markdownStyle.h2).toMatchObject({ marginTop: 0, marginBottom: 0 });
        expect(markdownStyle.h3).toMatchObject({ marginTop: 0, marginBottom: 0 });
        expect(markdownStyle.h4).toMatchObject({ marginTop: 0, marginBottom: 0 });
        expect(markdownStyle.math).toMatchObject({ marginTop: 0, marginBottom: 0 });
        expect(markdownStyle.thematicBreak).toMatchObject({ marginTop: 0, marginBottom: 0 });
    });
});
