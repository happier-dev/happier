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

    it('preserves transcript-local relative links so transcript handlers can resolve them', async () => {
        const { MarkdownView } = await import('./MarkdownView');
        const onLinkPress = vi.fn(() => true);

        const screen = await renderScreen(
            React.createElement(MarkdownView as any, {
                markdown: '[src](src/index.ts:8:2)',
                selectable: true,
                profile: 'transcript',
                onLinkPress,
            }),
        );

        const enrichedRun = screen.findByType('EnrichedMarkdownText');
        expect(enrichedRun.props.markdown).toBe('[src](src/index.ts:8:2)');

        enrichedRun.props.onLinkPress({ url: 'src/index.ts:8:2' });

        expect(onLinkPress).toHaveBeenCalledWith('src/index.ts:8:2');
    });

    it('preserves file URLs so transcript handlers can resolve them before any external open', async () => {
        const { MarkdownView } = await import('./MarkdownView');
        const onLinkPress = vi.fn(() => true);

        const screen = await renderScreen(
            React.createElement(MarkdownView as any, {
                markdown: '[src](file:///Users/leeroy/project/src/index.ts:8)',
                selectable: true,
                profile: 'transcript',
                onLinkPress,
            }),
        );

        const enrichedRun = screen.findByType('EnrichedMarkdownText');
        expect(enrichedRun.props.markdown).toBe('[src](file:///Users/leeroy/project/src/index.ts:8)');

        enrichedRun.props.onLinkPress({ url: 'file:///Users/leeroy/project/src/index.ts:8' });

        expect(onLinkPress).toHaveBeenCalledWith('file:///Users/leeroy/project/src/index.ts:8');
    });

    it('sanitizes enriched markdown link destinations before rendering them', async () => {
        const { MarkdownView } = await import('./MarkdownView');

        const markdown = [
            '[safe](www.example.com)',
            '',
            '[local](src/index.ts:5)',
            '',
            '[file](file:///Users/leeroy/project/src/index.ts:8)',
            '',
            '[unsafe](javascript:alert(1))',
        ].join('\n');

        const screen = await renderScreen(
            <MarkdownView markdown={markdown} selectable profile="transcript" />,
        );

        const enrichedRun = screen.findByType('EnrichedMarkdownText');
        expect(enrichedRun.props.markdown).toBe([
            '[safe](https://www.example.com)',
            '',
            '[local](src/index.ts:5)',
            '',
            '[file](file:///Users/leeroy/project/src/index.ts:8)',
            '',
            'unsafe',
        ].join('\n'));
    });
});
