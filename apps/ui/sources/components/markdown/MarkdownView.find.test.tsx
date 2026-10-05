import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installMarkdownCommonModuleMocks } from './markdownTestHelpers';
import { MarkdownView } from './MarkdownView';

installMarkdownCommonModuleMocks();

describe('Markdown Find source mapping', () => {
    it('shows both occurrences and current characters across nested formatting, links, and code', async () => {
        const markdown = '**first *needle*** and [needle](https://example.com)\n\n```ts\nconst needle = 1;\n```';
        const starts = [...markdown.matchAll(/needle/g)].map((match) => match.index);
        const findSourceRanges = starts.map((start, index) => ({ start, end: start + 6, current: index === 1 }));
        const screen = await renderScreen(<MarkdownView markdown={markdown} {...{ findSourceRanges }} />);
        expect(screen.findAllHostsByTestId('find-match-all').map((node) => node.children.join(''))).toEqual(['needle', 'needle']);
        expect(screen.findAllHostsByTestId('find-match-current').map((node) => node.children.join(''))).toEqual(['needle']);
        const link = screen.findByType('Link');
        expect(link.props.href).toBe('https://example.com');
    });
});
