import React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { renderScreen } from '@/dev/testkit';


declare global {
    // eslint-disable-next-line no-var
    var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe('MarkdownView (tables)', () => {
    it('renders tables inside a gesture-handler ScrollView so horizontal scrolling works reliably on Android', async () => {
        const { MarkdownView } = await import('./MarkdownView');

        const markdown = [
            '| A | B | C |',
            '|---|---|---|',
            '| 1 | 2 | 3 |',
        ].join('\n');

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<MarkdownView markdown={markdown} />)).tree;

        const scrollViews = tree!.root.findAllByType('GestureHandlerScrollView' as any);
        expect(scrollViews).toHaveLength(1);
        expect(scrollViews[0]!.props.horizontal).toBe(true);
        expect(scrollViews[0]!.props.nestedScrollEnabled).toBe(true);
        expect(scrollViews[0]!.props.disallowInterruption).toBe(true);
    }, 60_000);

    it('renders table header/cell text as selectable so users can copy values from transcripts', async () => {
        const { MarkdownView } = await import('./MarkdownView');

        const markdown = [
            '| A | B |',
            '|---|---|',
            '| 1 | 2 |',
        ].join('\n');

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<MarkdownView markdown={markdown} />)).tree;

        const findTextNode = (text: string) =>
            tree!.root.findAll((n) => typeof n.props?.children === 'string' && n.props.children === text)[0]!;

        expect(findTextNode('A').props.selectable).toBe(true);
        expect(findTextNode('1').props.selectable).toBe(true);
    }, 60_000);
});
