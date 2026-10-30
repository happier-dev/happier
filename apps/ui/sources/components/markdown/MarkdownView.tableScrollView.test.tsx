import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';
import { findNearestHostParent, flattenTestStyle } from '@/dev/testkit/harness/popoverHarness';
import { installMarkdownCommonModuleMocks } from './markdownTestHelpers';
import { MarkdownView } from './MarkdownView';
import { MarkdownBlockView } from './MarkdownBlockView';
import { parseMarkdown } from './parseMarkdown';


declare global {
    // eslint-disable-next-line no-var
    var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

installMarkdownCommonModuleMocks({
    storage: () => vi.importActual('@/sync/domains/state/storage'),
});

const clipboard = vi.hoisted(() => ({ setStringAsync: vi.fn(async (_text: string) => true) }));
// The platform clipboard is an external boundary.
vi.mock('expo-clipboard', () => clipboard);

async function mockPlatform(os: 'android' | 'ios' | 'web') {
    // The canonical boundary mock is shared by the real renderers. Changing its
    // platform avoids resetting and reloading the entire UI graph for each cell case.
    const { Platform } = await import('react-native');
    const { createReactNativeNativeMock, createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    const boundary = os === 'web' ? await createReactNativeWebMock() : await createReactNativeNativeMock({ platformOS: os });
    Object.defineProperties(Platform, Object.getOwnPropertyDescriptors(boundary.Platform));
}

async function renderTable(markdown: string, onLinkPress?: (url: string) => boolean | void) {
    const block = parseMarkdown(markdown)[0];
    if (block?.type !== 'table') throw new Error('Expected a Markdown table fixture');

    return renderScreen(<MarkdownBlockView
        block={block}
        first
        last
        selectable
        onLinkPress={onLinkPress}
        variant="default"
        profile="default"
        streamingReveal={false}
        agentTexMath={false}
    />);
}

describe('MarkdownView (tables)', () => {
    it('copies the rendered table as Markdown with alignment and escaped pipes', async () => {
        await mockPlatform('android');
        clipboard.setStringAsync.mockClear();
        const screen = await renderTable('| Left | Right |\n| :--- | ---: |\n| a \\| b | value |\n| short |');
        const button = screen.findByTestId('markdown-table-copy');
        expect(button).not.toBeNull();
        await pressTestInstanceAsync(button!, 'table copy');
        expect(clipboard.setStringAsync).toHaveBeenCalledWith('| Left | Right |\n| :--- | ---: |\n| a \\| b | value |\n| short |  |');
    });

    it('renders tables inside the native ScrollView so Android drags share nested scrolling with the transcript', async () => {
        await mockPlatform('android');

        const markdown = [
            '| A | B | C |',
            '|---|---|---|',
            '| 1 | 2 | 3 |',
        ].join('\n');

        const screen = await renderScreen(<MarkdownView markdown={markdown} />);

        expect(screen.findAllByType('GestureHandlerScrollView' as any)).toHaveLength(0);
        const scrollViews = screen.findAllByType('ScrollView' as any);
        expect(scrollViews).toHaveLength(1);
        expect(scrollViews[0]!.props.horizontal).toBe(true);
        expect(scrollViews[0]!.props.nestedScrollEnabled).toBe(true);
    }, 60_000);

    it('uses a visible horizontal scrollbar on web and does not clip the scroll shell', async () => {
        await mockPlatform('web');

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

        const scrollShell = screen.findAllByType('View' as any).find((node) => {
            const style = Array.isArray(node.props?.style) ? node.props.style.flat() : [node.props?.style];
            return style.some((entry: any) => entry?.overflow === 'visible');
        });
        expect(scrollShell).toBeTruthy();
        const shellStyle = flattenTestStyle(scrollShell?.props?.style);
        expect(shellStyle.alignSelf).toBe('flex-start');
        expect(shellStyle.maxWidth).toBe('100%');
    }, 60_000);

    it('suppresses table selection only on Android, preserving iOS and web selection', async () => {
        const markdown = '| A | B |\n|---|---|\n| 1 | 2 |';
        for (const [os, selectable] of [['android', false], ['ios', true], ['web', true]] as const) {
            await mockPlatform(os);
            const screen = await renderScreen(<MarkdownView markdown={markdown} />);
            const text = screen.findAllByType('Text' as any);
            expect(text.find((node) => node.props.children === 'A')!.props.selectable, os).toBe(selectable);
            expect(text.find((node) => node.props.children === '1')!.props.selectable, os).toBe(selectable);
        }
    }, 60_000);

    it('applies GitHub table column alignment to header and body cells', async () => {
        await mockPlatform('web');

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

    it.each(['android', 'web'] as const)('renders inline table formatting and handles header/body links on %s', async (os) => {
        await mockPlatform(os);
        const onLinkPress = vi.fn(() => true);
        const markdown = [
            '| **Name** | [Docs](https://example.com/docs) | Plain |',
            '|---|---|---|',
            '| *Claude* `git diff` | [File](./src/index.ts:12) | ordinary |',
        ].join('\n');

        const screen = await renderTable(markdown, onLinkPress);
        const textNodes = screen.findAllByType('Text');
        const findText = (value: string) => textNodes.find((node) => node.props.children === value);

        expect(findText('Name')).toBeDefined();
        expect(findText('Claude')).toBeDefined();
        expect(findText('git diff')).toBeDefined();
        expect(textNodes.filter((node) => node.props.children === 'ordinary')).toHaveLength(1);
        expect(findText('ordinary')?.props.selectable).toBe(os !== 'android');

        const docsLink = findText('Docs');
        const fileLink = findText('File');
        expect(docsLink?.props.accessibilityRole).toBe('link');
        expect(fileLink?.props.accessibilityRole).toBe('link');
        await pressTestInstanceAsync(docsLink, 'table header link');
        await pressTestInstanceAsync(fileLink, 'table body link');
        expect(onLinkPress.mock.calls).toEqual([
            ['https://example.com/docs'],
            ['./src/index.ts:12'],
        ]);
    });

    it.each(['android', 'web'] as const)('uses canonical link navigation for table autolinks on %s', async (os) => {
        await mockPlatform(os);
        const markdown = '| Site |\n|---|\n| www.example.com |';

        const screen = await renderTable(markdown);

        const link = screen.findByType('Link');
        expect(link.props.href).toBe('https://www.example.com');
        expect(link.props.target).toBe('_blank');
        expect(link.props.rel).toBe('noopener noreferrer');
        expect(link.props.asChild).toBe(os !== 'web');
    });

    it.each(['android', 'web'] as const)('routes agent TeX table cells through the enriched parser without changing generic cells on %s', async (os) => {
        await mockPlatform(os);
        const markdown = [
            '| Symbol | Meaning |',
            '|---|---|',
            '| \\(x\\) | ordinary |',
        ].join('\n');

        const genericScreen = await renderScreen(<MarkdownView markdown={markdown} />);
        expect(genericScreen.findAllByProps({ 'data-testid': 'markdown-table-cell-enriched' })).toHaveLength(0);

        const agentScreen = await renderScreen(<MarkdownView markdown={markdown} agentTexMath />);
        const enrichedCells = agentScreen.findAllByType('EnrichedMarkdownText');
        expect(enrichedCells).toHaveLength(1);
        expect(enrichedCells[0]!.props.md4cFlags).toMatchObject({ texMathBackslashDelimiters: true });
        expect(enrichedCells[0]!.props.selectable).toBe(os !== 'android');
    }, 60_000);

    it('handles links in math-bearing cells through the enriched renderer', async () => {
        await mockPlatform('web');
        const onLinkPress = vi.fn(() => true);
        const markdown = '| Formula |\n|---|\n| $x$ [Docs](https://example.com/math) |';

        const screen = await renderTable(markdown, onLinkPress);

        const cell = screen.findByType('EnrichedMarkdownText');
        cell.props.onLinkPress({ url: 'https://example.com/math' });
        expect(onLinkPress).toHaveBeenCalledWith('https://example.com/math');
    });
});
