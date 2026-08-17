import React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { parseMarkdown } from '../../../node_modules/react-native-enriched-markdown/src/web/parseMarkdown';
import type { ASTNode } from '../../../node_modules/react-native-enriched-markdown/src/web/types';
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

function findFirstNode(root: ASTNode, type: ASTNode['type']): ASTNode | null {
    if (root.type === type) return root;
    for (const child of root.children ?? []) {
        const match = findFirstNode(child, type);
        if (match) return match;
    }
    return null;
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
        expect(enrichedRuns[0]!.props.md4cFlags).toEqual({
            latexMath: true,
            texMathBackslashDelimiters: false,
        });
        expect(enrichedRuns[0]!.props.testID).toBeUndefined();
        expect(enrichedRuns[0]!.props['data-testid']).toBe('markdown-enriched-run');
        expect(enrichedRuns[0]!.props.renderRawFallback).toBeUndefined();
        expect(enrichedRuns[0]!.props.enableLinkPreview).toBeUndefined();
        expect(enrichedRuns[0]!.props.allowFontScaling).toBeUndefined();
        expect(enrichedRuns[0]!.props.streamingAnimation).toBeUndefined();
    });

    it('enables backslash TeX delimiters only when the caller marks agent output', async () => {
        const { MarkdownView } = await import('./MarkdownView');

        const genericScreen = await renderScreen(
            <MarkdownView markdown={'Use \\(foo\\) literally.'} profile="transcript" />,
        );
        expect(genericScreen.findByType('EnrichedMarkdownText').props.md4cFlags).toMatchObject({
            texMathBackslashDelimiters: false,
        });

        const agentScreen = await renderScreen(
            <MarkdownView markdown={'Value: \\(x\\).'} profile="transcript" agentTexMath />,
        );
        expect(agentScreen.findByType('EnrichedMarkdownText').props.md4cFlags).toMatchObject({
            texMathBackslashDelimiters: true,
        });
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

    it.each([
        { raw: 'javascript:alert(1)', rendered: 'target' },
        { raw: 'data:text/html,hello', rendered: 'target' },
        { raw: 'README.md', rendered: 'target' },
        { raw: './README.md', rendered: '[target](./README.md)' },
        { raw: 'mailto:test@example.com', rendered: '[target](mailto:test@example.com)' },
        { raw: 'https://example.com/path', rendered: '[target](https://example.com/path)' },
        { raw: 'http://example.com/path', rendered: '[target](http://example.com/path)' },
    ])('validates $raw before exposing it to the renderer', async ({ raw, rendered }) => {
        const { MarkdownView } = await import('./MarkdownView');
        const screen = await renderScreen(
            <MarkdownView markdown={`[target](${raw})`} profile="transcript" />,
        );

        expect(screen.findByType('EnrichedMarkdownText').props.markdown).toBe(rendered);
    });

    it.each([
        { definition: 'javascript:alert(1)', parserUrl: 'javascript:alert(1)' },
        { definition: 'data:text/html,hello', parserUrl: 'data:text/html,hello' },
        { definition: 'javascript&#58;alert(1)', parserUrl: 'javascript&#58;alert(1)' },
    ])('does not expose an invalid reference destination to a custom callback: $definition', async ({ definition, parserUrl }) => {
        const { MarkdownView } = await import('./MarkdownView');
        const onLinkPress = vi.fn();
        const markdown = `[target][unsafe]\n\n[unsafe]: ${definition}`;
        const parsedLink = findFirstNode(await parseMarkdown(markdown), 'Link');
        expect(parsedLink?.attributes?.url).toBe(parserUrl);
        const screen = await renderScreen(
            <MarkdownView
                markdown={markdown}
                onLinkPress={onLinkPress}
                profile="transcript"
            />,
        );
        const enrichedRun = screen.findByType('EnrichedMarkdownText');

        enrichedRun.props.onLinkPress({ url: parsedLink!.attributes!.url });

        expect(onLinkPress).not.toHaveBeenCalled();
    });

    it('fails inline and reference Markdown images closed before rendering', async () => {
        const { MarkdownView } = await import('./MarkdownView');
        const trackingPixel = 'https://tracker.example/pixel.gif';
        const screen = await renderScreen(
            <MarkdownView
                markdown={`before ![inline](${trackingPixel}) ![reference][pixel] ![shortcut] after\n\n[pixel]: ${trackingPixel}\n[shortcut]: ${trackingPixel}`}
                profile="transcript"
            />,
        );
        const rendered = screen.findByType('EnrichedMarkdownText').props.markdown as string;

        expect(rendered).not.toContain('![');
        expect(rendered).not.toContain(`](${trackingPixel})`);
        expect(rendered).toContain('before inline reference shortcut after');
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

    /**
     * `FileContentPanel` keeps `renderAfterSourceRange` mounted for the whole file whenever review
     * comments are enabled, and flips `onPressSourceRange` on and off as the user enters and leaves
     * review-comment mode. If the segment answered that flip by changing its wrapper element type —
     * or by dropping the wrapper entirely — React would unmount and remount every rendered segment
     * of the open file on each toggle, taking its measurements, text selection and reveal state with
     * it. The wrapper's identity must therefore follow the source-range capability, which is fixed
     * for a call site, and only its callback and role may change.
     */
    it('keeps one wrapper element for every segment when the source-range press handler toggles', async () => {
        const { MarkdownView } = await import('./MarkdownView');
        const onPressSourceRange = vi.fn();
        let enterCommentMode: (() => void) | null = null;

        function ReviewModeHarness(): React.ReactElement {
            const [commentMode, setCommentMode] = React.useState(false);
            enterCommentMode = () => setCommentMode(true);
            return React.createElement(MarkdownView as any, {
                markdown: '# Title',
                selectable: true,
                profile: 'default',
                renderAfterSourceRange: () => null,
                highlightSourceRange: null,
                onPressSourceRange: commentMode ? onPressSourceRange : undefined,
            });
        }

        const screen = await renderScreen(<ReviewModeHarness />);

        const inactive = screen.findByProps({ testID: 'markdown-source-range-trigger:1-1' });
        expect(inactive.props.accessibilityRole).toBeUndefined();

        await act(async () => {
            enterCommentMode?.();
        });

        const active = screen.findByProps({ testID: 'markdown-source-range-trigger:1-1' });
        expect(active.type).toBe(inactive.type);
        expect(active.props.accessibilityRole).toBe('button');

        active.props.onPress();
        expect(onPressSourceRange).toHaveBeenCalledWith({
            sourceRange: { startLine: 1, endLine: 1 },
            markdown: '# Title',
        });
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
