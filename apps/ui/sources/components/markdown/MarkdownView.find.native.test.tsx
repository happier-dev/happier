import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installMarkdownCommonModuleMocks } from './markdownTestHelpers';

installMarkdownCommonModuleMocks({ reactNative: async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock({ platformOS: 'ios' });
} });

describe('Native Markdown Find fallback', () => {
    it('keeps headings, lists, links and selectable text while highlighting the exact source occurrence in a table', async () => {
        const { MarkdownView } = await import('./MarkdownView');
        const markdown = '# needle\n\n- **needle**\n- [needle](https://example.com)\n\n| needle | right |\n| --- | --- |\n| needle | value |';
        const starts = [...markdown.matchAll(/needle/g)].map((match) => match.index);
        const screen = await renderScreen(<MarkdownView markdown={markdown} findSourceRanges={starts.map((start, index) => ({
            start, end: start + 6, current: index === 4,
        }))} />);
        expect(screen.findAllHostsByTestId('find-match-all').map((node) => node.children.join(''))).toEqual(['needle', 'needle', 'needle', 'needle']);
        expect(screen.findAllHostsByTestId('find-match-current').map((node) => node.children.join(''))).toEqual(['needle']);
        expect(screen.findAllHostsByTestId('markdown-list-item-row')).toHaveLength(2);
        expect(screen.findAllHostsByTestId('markdown-table-scroll')).toHaveLength(1);
        expect(screen.findByType('Link').props.asChild).toBe(true);
    });

    it('highlights literal option text without changing option activation', async () => {
        const { MarkdownView } = await import('./MarkdownView');
        const markdown = '<options>\n<option>**needle**</option>\n<option>needle</option>\n</options>';
        const start = markdown.lastIndexOf('needle');
        let selection: string | undefined;
        const screen = await renderScreen(<MarkdownView markdown={markdown} onOptionPress={(option) => { selection = option.title; }}
            findSourceRanges={[{ start, end: start + 6, current: true }]} />);
        expect(screen.findAllHostsByTestId('find-match-current').map((node) => node.children.join(''))).toEqual(['needle']);
        const buttons = screen.findAllByType('Pressable').filter((node) => typeof node.props.onPress === 'function');
        buttons.at(-1)?.props.onPress();
        expect(selection).toBe('needle');
    });
});
