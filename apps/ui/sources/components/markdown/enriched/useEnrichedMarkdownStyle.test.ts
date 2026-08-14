import { describe, expect, it } from 'vitest';

import { buildEnrichedMarkdownStyle } from './useEnrichedMarkdownStyle';

const colors = {
    text: { primary: '#111111', secondary: '#666666', link: '#0066cc' },
    surface: { inset: '#eeeeee', elevated: '#ffffff', selected: '#dddddd' },
    border: { default: '#cccccc' },
} as const;

// Mirrors the transcript's real web textStyle: a Unistyles-registered style whose numeric
// metrics are non-enumerable, non-writable (but configurable) data properties.
function createWebUnistylesTextStyle(values: Record<string, number>): unknown {
    const style: Record<string, unknown> = {};
    Object.defineProperties(
        style,
        Object.fromEntries(Object.entries(values).map(([key, value]) => [key, {
            value,
            enumerable: false,
            configurable: true,
        }])),
    );
    style.unistyles_test = {};
    return style;
}

describe('buildEnrichedMarkdownStyle uiFontScale', () => {
    it('scales the markdown metrics from a plain transcript textStyle', () => {
        const bundle = buildEnrichedMarkdownStyle({
            colors,
            profile: 'transcript',
            uiFontScale: 1.3,
            textStyle: { fontSize: 16, lineHeight: 24 },
        });

        expect(bundle.markdownStyle.paragraph?.fontSize).toBe(20.8);
        expect(bundle.markdownStyle.paragraph?.lineHeight).toBe(31.2);
        expect(bundle.markdownStyle.codeBlock?.fontSize).toBe(18.2);
    });

    it('scales the markdown metrics from a web Unistyles transcript textStyle', () => {
        const bundle = buildEnrichedMarkdownStyle({
            colors,
            profile: 'transcript',
            uiFontScale: 1.3,
            textStyle: createWebUnistylesTextStyle({ fontSize: 16, lineHeight: 24 }) as never,
        });

        expect(bundle.markdownStyle.paragraph?.fontSize).toBe(20.8);
        expect(bundle.markdownStyle.paragraph?.lineHeight).toBe(31.2);
        expect(bundle.markdownStyle.list?.fontSize).toBe(20.8);
        expect(bundle.markdownStyle.h1?.fontSize).toBe(31.2);
    });

    it('keeps the unscaled metrics at scale 1', () => {
        const bundle = buildEnrichedMarkdownStyle({
            colors,
            profile: 'transcript',
            uiFontScale: 1,
            textStyle: createWebUnistylesTextStyle({ fontSize: 16, lineHeight: 24 }) as never,
        });

        expect(bundle.markdownStyle.paragraph?.fontSize).toBe(16);
        expect(bundle.markdownStyle.paragraph?.lineHeight).toBe(24);
    });
});
