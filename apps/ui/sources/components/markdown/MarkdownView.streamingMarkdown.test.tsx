import React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installMarkdownCommonModuleMocks } from './markdownTestHelpers';
import { MarkdownCodeBlock } from './MarkdownCodeBlock';

declare global {
    // eslint-disable-next-line no-var
    var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

installMarkdownCommonModuleMocks();

vi.mock('./MermaidRenderer', () => ({
    MermaidRenderer: (props: Record<string, unknown>) =>
        React.createElement('MermaidRenderer', props),
}));

function textNodes(screen: Awaited<ReturnType<typeof renderScreen>>) {
    return screen
        .findAll((node) => typeof node.props?.children === 'string')
        .map((node) => String(node.props.children));
}

function visibleText(screen: Awaited<ReturnType<typeof renderScreen>>) {
    return textNodes(screen).join('');
}

async function renderStreamingMarkdown(markdown: string, props: Record<string, unknown> = {}) {
    const { MarkdownView } = await import('./MarkdownView');
    return renderScreen(
        React.createElement(MarkdownView, {
            markdown,
            streamingMode: 'streaming',
            ...props,
        }),
    );
}

describe('MarkdownView (streaming markdown)', () => {
    it('repairs incomplete bold spans before passing prose to the enriched renderer', async () => {
        const screen = await renderStreamingMarkdown('This is **half');

        const enrichedRun = screen.findByType('EnrichedMarkdownText');
        expect(enrichedRun.props.markdown).toBe('This is **half**');
    }, 60_000);

    it('renders incomplete code fences as cheap text while streaming', async () => {
        const screen = await renderStreamingMarkdown(['```ts', 'const value = 1;'].join('\n'));

        expect(screen.findAllByType(MarkdownCodeBlock)).toHaveLength(0);
        expect(visibleText(screen)).toContain('const value = 1;');
    }, 60_000);

    it('does not instantiate Mermaid for incomplete mermaid fences while streaming', async () => {
        const screen = await renderStreamingMarkdown(['```mermaid', 'graph TD;', 'A-->B'].join('\n'));

        expect(screen.findAllByType('MermaidRenderer')).toHaveLength(0);
        expect(visibleText(screen)).toContain('graph TD;');
    }, 60_000);

    it('keeps incomplete tables out of the table layout while streaming', async () => {
        const screen = await renderStreamingMarkdown(['| A | B |', '| --- | --- |'].join('\n'));

        expect(screen.findByTestId('markdown-table-scroll')).toBe(null);
        expect(visibleText(screen)).toContain('| A | B |');
    }, 60_000);

    it('keeps incomplete options blocks non-clickable while streaming', async () => {
        const screen = await renderStreamingMarkdown(['<options>', '<option>Run command</option>'].join('\n'));

        expect(screen.findAllByType('Pressable')).toHaveLength(0);
        expect(visibleText(screen)).toContain('Run command');
    }, 60_000);

    it.each(['static', 'streaming'] as const)('renders continuation choices through the existing option controls in %s mode', async (streamingMode) => {
        const onOptionPress = vi.fn();
        const screen = await renderStreamingMarkdown([
            '<option>Continue</option>',
            '<option>Review first</option>',
            '</options>',
        ].join('\n'), { streamingMode, onOptionPress });

        const buttons = screen.findAllByType('Pressable');
        expect(buttons).toHaveLength(2);
        expect(visibleText(screen)).not.toContain('</options>');
        await act(async () => {
            buttons[1]!.props.onPress();
        });
        expect(onOptionPress).toHaveBeenCalledWith({ title: 'Review first' });
    }, 60_000);

    it('keeps option tap and long-press copy handling separate', async () => {
        const { MarkdownView } = await import('./MarkdownView');
        const onOptionPress = vi.fn();
        const onOptionLongPress = vi.fn(async () => true);
        const markdown = [
            '<options>',
            '<option>Run command</option>',
            '</options>',
        ].join('\n');

        const screen = await renderScreen(
            React.createElement(MarkdownView as any, {
                markdown,
                onOptionPress,
                onOptionLongPress,
                selectable: true,
                profile: 'transcript',
            }),
        );

        const [optionButton] = screen.findAllByType('Pressable');
        expect(optionButton).toBeTruthy();

        await act(async () => {
            await optionButton!.props.onLongPress?.();
        });

        expect(onOptionLongPress).toHaveBeenCalledWith({ title: 'Run command' });
        expect(onOptionPress).not.toHaveBeenCalled();
        expect(screen.findByTestId('markdown-option-copy-feedback:0')).toBeTruthy();

        await act(async () => {
            optionButton!.props.onPress?.();
        });

        expect(onOptionPress).not.toHaveBeenCalled();

        await act(async () => {
            optionButton!.props.onPress?.();
        });

        expect(onOptionPress).toHaveBeenCalledWith({ title: 'Run command' });
    }, 60_000);

    it('passes web streaming animation to enriched prose without legacy outer run wrappers', async () => {
        const screen = await renderStreamingMarkdown('Hello `code` world', { streamingAnimated: true });

        const revealNodes = screen.findAll((node) => node.props?.['data-happier-streaming-text-reveal'] === 'word');
        expect(revealNodes).toHaveLength(0);
        const markdownRevealNodes = screen.findAll((node) =>
            node.props?.['data-happier-streaming-markdown-reveal'] === 'run'
        );
        expect(markdownRevealNodes).toHaveLength(0);
        const enrichedRun = screen.findByType('EnrichedMarkdownText');
        expect(enrichedRun.props.markdown).toBe('Hello `code` world');
        // Web streaming reveal is per word, driven by the package's reveal ranges. Marking
        // the enriched CONTAINER instead makes the injected keyframe fade the whole block in
        // on every mount — including list-windowing remounts of content already on screen —
        // and CSS cannot tell that the block was already visible, so the mount guard that
        // fixed the per-word path cannot help at block granularity.
        expect(enrichedRun.props.streamingAnimation).toBe(true);
        expect(enrichedRun.props['data-happier-enriched-markdown-reveal']).toBeUndefined();
    }, 60_000);

    it('updates streamed complete code block content without remounting the code block component', async () => {
        const { MarkdownView } = await import('./MarkdownView');
        const firstMarkdown = ['```ts', 'const value = 1;', '```'].join('\n');
        const nextMarkdown = ['```ts', 'const value = 1;', 'const next = 2;', '```'].join('\n');
        const screen = await renderScreen(
            React.createElement(MarkdownView, {
                markdown: firstMarkdown,
                streamingMode: 'streaming',
                streamingAnimated: true,
            }),
        );

        const firstCodeBlock = screen.findByType(MarkdownCodeBlock);

        await act(async () => {
            await screen.update(
                React.createElement(MarkdownView, {
                    markdown: nextMarkdown,
                    streamingMode: 'streaming',
                    streamingAnimated: true,
                }),
            );
        });

        const nextCodeBlock = screen.findByType(MarkdownCodeBlock);
        expect(nextCodeBlock).toBe(firstCodeBlock);
        expect(nextCodeBlock.props.content).toBe('const value = 1;\nconst next = 2;');
    }, 60_000);
});
