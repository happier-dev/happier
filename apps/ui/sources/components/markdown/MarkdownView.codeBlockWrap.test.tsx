import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it } from 'vitest';

import { pressTestInstanceAsync, renderScreen, standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storage';
import { MarkdownView } from './MarkdownView';
import { MarkdownCodeBlockWrapStateProvider } from './MarkdownCodeBlockWrapState';

afterEach(() => {
    standardCleanup();
    storage.getState().applySettingsLocal({ showChatCodeBlockWrapControls: true, wrapChatCodeBlocks: false });
});

describe('MarkdownView code block wrapping', () => {
    it('hides chat wrap controls while honoring the default independently of file/diff wrapping', async () => {
        storage.getState().applySettingsLocal({ showChatCodeBlockWrapControls: false, wrapChatCodeBlocks: true, wrapLinesInDiffs: false, filesDiffSyntaxHighlightingMode: 'off' });
        const screen = await renderScreen(<MarkdownView markdown={'```\nlong code line\n```'} />);
        expect(screen.findAllByTestId('code-wrap-lines-toggle')).toHaveLength(0);
        expect(screen.findAllByTestId('markdown-code-block-scroll')).toHaveLength(0);
        await act(async () => { storage.getState().applySettingsLocal({ wrapChatCodeBlocks: false }); });
        expect(screen.findAllByTestId('code-wrap-lines-toggle')).toHaveLength(0);
        expect(screen.findAllByTestId('markdown-code-block-scroll').filter(node => typeof node.type === 'string')).toHaveLength(1);
        expect(storage.getState().settings.wrapLinesInDiffs).toBe(false);
    });

    it('retains explicit wrapped and unwrapped choices while untouched blocks follow changing defaults', async () => {
        storage.getState().applySettingsLocal({ showChatCodeBlockWrapControls: true, wrapChatCodeBlocks: false, filesDiffSyntaxHighlightingMode: 'off' });
        const markdown = ['```', 'first', '```', '', '```', 'second', '```', '', '```', 'untouched', '```'].join('\n');
        function Transcript({ visible }: Readonly<{ visible: boolean }>) {
            return <MarkdownCodeBlockWrapStateProvider>{visible ? <MarkdownView markdown={markdown} codeBlockStateKey="session:a/message:a" /> : null}</MarkdownCodeBlockWrapStateProvider>;
        }
        const screen = await renderScreen(<Transcript visible />);
        const switches = () => screen.findAllByProps({ accessibilityRole: 'switch' }).filter(node => typeof node.type === 'string');
        const checked = () => switches().map(node => node.props.accessibilityState.checked);
        await pressTestInstanceAsync(switches()[0]!, 'explicitly wrap first');
        await pressTestInstanceAsync(switches()[1]!, 'wrap second');
        await pressTestInstanceAsync(switches()[1]!, 'explicitly unwrap second');
        await act(async () => { storage.getState().applySettingsLocal({ wrapChatCodeBlocks: true }); });
        expect(checked()).toEqual([true, false, true]);
        await screen.update(<Transcript visible={false} />);
        await screen.update(<Transcript visible />);
        expect(checked()).toEqual([true, false, true]);
        await act(async () => { storage.getState().applySettingsLocal({ wrapChatCodeBlocks: false }); });
        expect(checked()).toEqual([true, false, false]);
    });

    it('retains each message/block choice when virtualized rows unmount and remount', async () => {
        storage.getState().applySettingsLocal({ filesDiffSyntaxHighlightingMode: 'off' });
        const markdown = ['```', 'identical content', '```', '', '```', 'identical content', '```'].join('\n');
        function Transcript({ visible }: Readonly<{ visible: boolean }>) {
            return (
                <MarkdownCodeBlockWrapStateProvider>
                    {visible ? <MarkdownView markdown={markdown} codeBlockStateKey="session:a/message:a" /> : null}
                    <MarkdownView markdown={markdown} codeBlockStateKey="session:a/message:b" />
                </MarkdownCodeBlockWrapStateProvider>
            );
        }
        const screen = await renderScreen(<Transcript visible />);
        const switches = () => screen.findAllByProps({ accessibilityRole: 'switch' })
            .filter(node => typeof node.type === 'string');
        await pressTestInstanceAsync(switches()[0]!, 'wrap first message/block');
        expect(switches().map(node => node.props.accessibilityState.checked)).toEqual([true, false, false, false]);
        await screen.update(<Transcript visible={false} />);
        await screen.update(<Transcript visible />);
        expect(switches().map(node => node.props.accessibilityState.checked)).toEqual([true, false, false, false]);
    });

    it('toggles individual fenced blocks without changing the file/diff setting', async () => {
        storage.getState().applySettingsLocal({ wrapLinesInDiffs: true, filesDiffSyntaxHighlightingMode: 'off' });
        const markdown = ['```yaml', 'description: ' + 'long description '.repeat(30), '```', '', '```', 'same content', '```'].join('\n');
        const screen = await renderScreen(<MarkdownView markdown={markdown} />);
        const switches = () => screen.findAllByProps({ accessibilityRole: 'switch' })
            .filter(node => typeof node.type === 'string');
        const scrollers = () => screen.findAllByTestId('markdown-code-block-scroll')
            .filter(node => typeof node.type === 'string');

        expect(switches()).toHaveLength(2);
        expect(switches().map(node => node.props.accessibilityState.checked)).toEqual([false, false]);
        expect(scrollers()).toHaveLength(2);
        await pressTestInstanceAsync(switches()[0]!, 'first code block wrap');
        expect(switches().map(node => node.props.accessibilityState.checked)).toEqual([true, false]);
        expect(scrollers()).toHaveLength(1);
        expect(storage.getState().settings.wrapLinesInDiffs).toBe(true);
        await pressTestInstanceAsync(switches()[0]!, 'unwrap first code block');
        expect(scrollers()).toHaveLength(2);
    });

    it.each(['diff', 'patch'])('retains the local code wrap choice when switching a %s fence between modes', async (language) => {
        storage.getState().applySettingsLocal({ wrapLinesInDiffs: true, filesDiffSyntaxHighlightingMode: 'off' });
        const markdown = ['```' + language, 'diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts', '@@ -1 +1 @@', '-old', '+new', '```'].join('\n');
        const screen = await renderScreen(<MarkdownView markdown={markdown} />);
        const switches = () => screen.findAllByProps({ accessibilityRole: 'switch' })
            .filter(node => typeof node.type === 'string');
        expect(switches()).toHaveLength(0);
        await screen.pressByTestIdAsync('markdown-code-block-toggle:code');
        expect(switches()).toHaveLength(1);
        expect(switches()[0]!.props.accessibilityState.checked).toBe(false);
        await pressTestInstanceAsync(switches()[0]!, 'wrap code fence');
        expect(switches()[0]!.props.accessibilityState.checked).toBe(true);
        expect(screen.findAllByTestId('markdown-code-block-scroll')).toHaveLength(0);
        await screen.pressByTestIdAsync('markdown-code-block-toggle:diff');
        await screen.pressByTestIdAsync('markdown-code-block-toggle:code');
        expect(switches()[0]!.props.accessibilityState.checked).toBe(true);
        expect(storage.getState().settings.wrapLinesInDiffs).toBe(true);
    });

    it.each([
        { label: 'over-budget', budget: 1, content: 'a long plain line '.repeat(30) },
        { label: 'empty', budget: 1_000_000, content: '' },
    ])('keeps wrapping available for $label diff fences', async ({ budget, content }) => {
        storage.getState().applySettingsLocal({ filesDiffTokenizationMaxBytes: budget, filesDiffSyntaxHighlightingMode: 'off' });
        const screen = await renderScreen(<MarkdownView markdown={'```diff\n' + content + '\n```'} />);
        await screen.pressByTestIdAsync('code-wrap-lines-toggle');
        expect(screen.findAllByTestId('markdown-code-block-scroll')).toHaveLength(0);
    });
});
