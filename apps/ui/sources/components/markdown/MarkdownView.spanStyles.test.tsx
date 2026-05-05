import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';


declare global {
    // eslint-disable-next-line no-var
    var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('./MermaidRenderer', () => ({
    MermaidRenderer: () => null,
}));

describe('MarkdownView (span styles)', () => {
    it('passes bold/italic/code typography through the enriched markdown style contract', async () => {
        const { MarkdownView } = await import('./MarkdownView');

        const markdown = '**Exploring Reasoning Options** *Considering tools* `git diff`';
        const textStyle = {
            fontStyle: 'italic' as const,
            fontSize: 14,
            lineHeight: 20,
            color: 'rgb(120, 120, 120)',
        };

        const screen = await renderScreen(<MarkdownView markdown={markdown} textStyle={textStyle} />);

        const enrichedRun = screen.findByType('EnrichedMarkdownText');
        const markdownStyle = enrichedRun.props.markdownStyle;

        expect(markdownStyle.strong.fontFamily).toBe('Inter-SemiBold');
        expect(markdownStyle.em.fontFamily).toBe('Inter-Italic');
        expect(markdownStyle.code.fontFamily).toBe('IBMPlexMono-Regular');
        expect(markdownStyle.code.fontSize).toBeLessThan(markdownStyle.paragraph.fontSize);
        expect(markdownStyle.code.color).toBe('rgb(120, 120, 120)');
        expect(markdownStyle.code.borderColor).toBe('transparent');
        expect(markdownStyle.inlineMath.color).toBe(markdownStyle.paragraph.color);
        expect(markdownStyle.math.fontSize).toBe(markdownStyle.paragraph.fontSize);
        expect(markdownStyle.math.color).toBe(markdownStyle.paragraph.color);
        expect(markdownStyle.math.backgroundColor).toBe('transparent');
        expect(markdownStyle.list.marginLeft).toBeGreaterThan(0);
        expect(markdownStyle.paragraph.marginTop).toBe(0);
        expect(markdownStyle.paragraph.lineHeight).toBe(20);
    }, 60_000);
});
