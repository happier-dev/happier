import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { findNearestHostParent, flattenTestStyle } from '@/dev/testkit/harness/popoverHarness';
import { installMarkdownCommonModuleMocks } from './markdownTestHelpers';


declare global {
    // eslint-disable-next-line no-var
    var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

installMarkdownCommonModuleMocks();

function mockPlatform(os: 'android' | 'web') {
    vi.doMock('react-native', async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: os,
            },
        });
    });
}

describe('MarkdownView (tables)', () => {
    beforeEach(() => {
        vi.resetModules();
    });

    it('renders tables inside a gesture-handler ScrollView so horizontal scrolling works reliably on Android', async () => {
        mockPlatform('android');
        const { MarkdownView } = await import('./MarkdownView');

        const markdown = [
            '| A | B | C |',
            '|---|---|---|',
            '| 1 | 2 | 3 |',
        ].join('\n');

        const screen = await renderScreen(<MarkdownView markdown={markdown} />);

        const scrollViews = screen.findAllByType('GestureHandlerScrollView' as any);
        expect(scrollViews).toHaveLength(1);
        expect(scrollViews[0]!.props.horizontal).toBe(true);
        expect(scrollViews[0]!.props.nestedScrollEnabled).toBe(true);
        expect(scrollViews[0]!.props.disallowInterruption).toBe(true);
    }, 60_000);

    it('uses a visible horizontal scrollbar on web and does not clip the scroll shell', async () => {
        mockPlatform('web');
        const { MarkdownView } = await import('./MarkdownView');

        const markdown = [
            '| Name | Reliability | Notes |',
            '|---|---|---|',
            '| Claude | High | Long cell content that exceeds the viewport width |',
        ].join('\n');

        const screen = await renderScreen(<MarkdownView markdown={markdown} />);

        const scrollViews = screen.findAllByType('ScrollView' as any);
        expect(scrollViews).toHaveLength(1);
        expect(scrollViews[0]!.props.horizontal).toBe(true);
        expect(scrollViews[0]!.props.showsHorizontalScrollIndicator).toBe(true);

        const scrollShell = findNearestHostParent(scrollViews[0]);
        expect(scrollShell).toBeTruthy();
        const shellStyle = flattenTestStyle(scrollShell?.props?.style);
        expect(shellStyle.alignSelf).toBe('flex-start');
        expect(shellStyle.maxWidth).toBe('100%');
    }, 60_000);

    it('renders table header/cell text as selectable so users can copy values from transcripts', async () => {
        mockPlatform('android');
        const { MarkdownView } = await import('./MarkdownView');

        const markdown = [
            '| A | B |',
            '|---|---|',
            '| 1 | 2 |',
        ].join('\n');

        const screen = await renderScreen(<MarkdownView markdown={markdown} />);

        const findTextNode = (text: string) =>
            screen.findAllByType('Text' as any).find((n) => n.props?.children === text)!;

        expect(findTextNode('A').props.selectable).toBe(true);
        expect(findTextNode('1').props.selectable).toBe(true);
    }, 60_000);

    it('applies GitHub table column alignment to header and body cells', async () => {
        mockPlatform('web');
        const { MarkdownView } = await import('./MarkdownView');

        const markdown = [
            '| Left | Center | Right |',
            '| :--- | :---: | ---: |',
            '| Alpha | Bravo | Charlie |',
        ].join('\n');

        const screen = await renderScreen(<MarkdownView markdown={markdown} />);

        const findTextNode = (text: string) =>
            screen.findAllByType('Text' as any).find((n) => n.props?.children === text)!;

        expect(flattenTestStyle(findTextNode('Alpha').props.style).textAlign).toBe('left');
        expect(flattenTestStyle(findTextNode('Bravo').props.style).textAlign).toBe('center');
        expect(flattenTestStyle(findTextNode('Charlie').props.style).textAlign).toBe('right');

        const rightCell = findNearestHostParent(findTextNode('Charlie'), 'View');
        expect(flattenTestStyle(rightCell?.props?.style).alignItems).toBe('flex-end');
    }, 60_000);
});
