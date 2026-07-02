import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installMarkdownCommonModuleMocks } from './markdownTestHelpers';

declare global {
    // eslint-disable-next-line no-var
    var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

installMarkdownCommonModuleMocks();

vi.mock('./MarkdownCodeBlock', () => ({
    MarkdownCodeBlock: (props: Record<string, unknown>) =>
        React.createElement('MarkdownCodeBlock', props),
}));

vi.mock('./MermaidRenderer', () => ({
    MermaidRenderer: (props: Record<string, unknown>) =>
        React.createElement('MermaidRenderer', props),
}));

function flattenStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) {
        return Object.assign({}, ...style.map((entry) => flattenStyle(entry)));
    }
    if (style && typeof style === 'object') return style as Record<string, unknown>;
    return {};
}

describe('MarkdownView (enriched renderer)', () => {
    it('renders package-safe prose as one selectable enriched markdown run', async () => {
        const { MarkdownView } = await import('./MarkdownView');

        const markdown = [
            'Hello **there**.',
            '',
            '- one',
            '- two',
        ].join('\n');

        const screen = await renderScreen(
            <MarkdownView markdown={markdown} selectable profile="transcript" />,
        );

        const enrichedRuns = screen.findAllByType('EnrichedMarkdownText');
        expect(enrichedRuns).toHaveLength(1);
        expect(enrichedRuns[0]!.props.markdown).toBe(markdown);
        expect(enrichedRuns[0]!.props.selectable).toBe(true);
        expect(enrichedRuns[0]!.props.flavor).toBe('commonmark');
        expect(enrichedRuns[0]!.props.md4cFlags).toEqual({ latexMath: true });
        expect(enrichedRuns[0]!.props.testID).toBeUndefined();
        expect(enrichedRuns[0]!.props['data-testid']).toBe('markdown-enriched-run');
        expect(enrichedRuns[0]!.props.renderRawFallback).toBe('hidden');
        expect(enrichedRuns[0]!.props.enableLinkPreview).toBeUndefined();
        expect(enrichedRuns[0]!.props.allowFontScaling).toBeUndefined();
        expect(enrichedRuns[0]!.props.streamingAnimation).toBeUndefined();
    });

    it('keeps code fences as special blocks while grouping surrounding prose into enriched runs', async () => {
        const { MarkdownView } = await import('./MarkdownView');

        const markdown = [
            'Before',
            '',
            '```ts',
            'const value = 1;',
            '```',
            '',
            'After',
        ].join('\n');

        const screen = await renderScreen(
            <MarkdownView markdown={markdown} selectable profile="transcript" />,
        );

        const enrichedRuns = screen.findAllByType('EnrichedMarkdownText');
        expect(enrichedRuns.map((node) => node.props.markdown)).toEqual(['Before', 'After']);
        expect(screen.findAllByType('MarkdownCodeBlock')).toHaveLength(1);
    });

    it('lets callers handle enriched markdown links before opening externally', async () => {
        const { MarkdownView } = await import('./MarkdownView');
        const onLinkPress = vi.fn(() => true);

        const screen = await renderScreen(
            React.createElement(MarkdownView as any, {
                markdown: '[src](http://localhost:18829/repo/src/index.ts:8)',
                selectable: true,
                profile: 'transcript',
                onLinkPress,
            }),
        );

        const enrichedRun = screen.findByType('EnrichedMarkdownText');
        enrichedRun.props.onLinkPress({ url: 'http://localhost:18829/repo/src/index.ts:8' });

        expect(onLinkPress).toHaveBeenCalledWith('http://localhost:18829/repo/src/index.ts:8');
    });

    it('lets callers handle markdown source ranges without centering markdown content', async () => {
        const { MarkdownView } = await import('./MarkdownView');
        const onPressSourceRange = vi.fn();

        const screen = await renderScreen(
            React.createElement(MarkdownView as any, {
                markdown: '# Title',
                selectable: true,
                profile: 'transcript',
                onPressSourceRange,
            }),
        );

        const trigger = screen.findByProps({ testID: 'markdown-source-range-trigger:1-1' });
        trigger.props.onPress();

        expect(onPressSourceRange).toHaveBeenCalledWith({
            sourceRange: { startLine: 1, endLine: 1 },
            markdown: '# Title',
        });
        expect(flattenStyle(trigger.props.style)).toMatchObject({
            width: '100%',
            alignSelf: 'stretch',
            alignItems: 'stretch',
            textAlign: 'left',
        });
        expect(screen.findAllByType('EnrichedMarkdownText')).toHaveLength(1);
    });

    it('uses separate source-range targets for separate prose blocks in comment mode', async () => {
        const { MarkdownView } = await import('./MarkdownView');
        const onPressSourceRange = vi.fn();
        const markdown = [
            '# Title',
            '',
            'Second paragraph.',
        ].join('\n');

        const screen = await renderScreen(
            React.createElement(MarkdownView as any, {
                markdown,
                selectable: true,
                profile: 'transcript',
                onPressSourceRange,
            }),
        );

        const titleTrigger = screen.findByProps({ testID: 'markdown-source-range-trigger:1-1' });
        const paragraphTrigger = screen.findByProps({ testID: 'markdown-source-range-trigger:3-3' });
        expect(titleTrigger).toBeTruthy();
        expect(flattenStyle(paragraphTrigger.props.style)).toMatchObject({
            alignItems: 'stretch',
            justifyContent: 'flex-start',
        });

        paragraphTrigger.props.onPress();

        expect(onPressSourceRange).toHaveBeenCalledWith({
            sourceRange: { startLine: 3, endLine: 3 },
            markdown: 'Second paragraph.',
        });
        expect(screen.findAllByType('EnrichedMarkdownText')).toHaveLength(2);
    });
});
