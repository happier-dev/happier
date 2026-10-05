import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installMarkdownCommonModuleMocks } from './markdownTestHelpers';
import { MarkdownSpansView } from './MarkdownSpansView';

installMarkdownCommonModuleMocks();

describe('Markdown character Find', () => {
    it('decorates all and current ranges across formatting without changing links or text', async () => {
        const findRanges = [{ start: 1, end: 5, current: false }, { start: 7, end: 9, current: true }];
        const screen = await renderScreen(<MarkdownSpansView {...{ findRanges }} spans={[
            { text: 'abc', styles: [], url: null },
            { text: 'def', styles: ['bold'], url: null },
            { text: 'ghi', styles: [], url: 'https://example.com' },
        ]} />);
        const all = screen.findAllHostsByTestId('find-match-all');
        const current = screen.findAllHostsByTestId('find-match-current');
        expect(all.map((node) => node.children.join(''))).toEqual(['bc', 'de']);
        expect(current.map((node) => node.children.join(''))).toEqual(['hi']);
        expect(screen.findByType('Link').props.href).toBe('https://example.com');
    });
});
