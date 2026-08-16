import React from 'react';
import { act } from 'react-test-renderer';
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
        expect(enrichedRuns[0]!.props.md4cFlags).toEqual({ latexMath: true, texMathBackslashDelimiters: false });
        expect(enrichedRuns[0]!.props.testID).toBeUndefined();
        expect(enrichedRuns[0]!.props['data-testid']).toBe('markdown-enriched-run');
        // The raw fallback is only hidden while the enriched runtime is still loading;
        // here it has settled, so a fallback would mean a parse failure and must stay
        // visible. Both directions are owned by EnrichedMarkdownRuntimeReadiness.
        expect(enrichedRuns[0]!.props.renderRawFallback).toBe(true);
        expect(enrichedRuns[0]!.props.enableLinkPreview).toBeUndefined();
        expect(enrichedRuns[0]!.props.allowFontScaling).toBeUndefined();
        expect(enrichedRuns[0]!.props.streamingAnimation).toBeUndefined();
    });

    it('enables agent TeX parsing without rewriting the Markdown source', async () => {
        const { MarkdownView } = await import('./MarkdownView');
        const markdown = 'Coordinates: [\\(x\\), \\(y\\)]';

        const screen = await renderScreen(
            <MarkdownView markdown={markdown} selectable profile="transcript" agentTexMath />,
        );

        const enrichedRun = screen.findByType('EnrichedMarkdownText');
        expect(enrichedRun.props.markdown).toBe(markdown);
        expect(enrichedRun.props.md4cFlags).toEqual({ latexMath: true, texMathBackslashDelimiters: true });
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

    it('lets callers handle markdown source ranges without changing normal enriched rendering', async () => {
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

    it('passes the original markdown source for special block source range actions', async () => {
        const { MarkdownView } = await import('./MarkdownView');
        const onPressSourceRange = vi.fn();
        const markdown = [
            '```ts',
            'const value = 1;',
            '```',
        ].join('\n');

        const screen = await renderScreen(
            React.createElement(MarkdownView as any, {
                markdown,
                selectable: true,
                profile: 'transcript',
                onPressSourceRange,
            }),
        );

        const trigger = screen.findByProps({ testID: 'markdown-source-range-trigger:1-3' });
        trigger.props.onPress();

        expect(onPressSourceRange).toHaveBeenCalledWith({
            sourceRange: { startLine: 1, endLine: 3 },
            markdown,
        });
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

    it.each([
        { raw: 'javascript:alert(1)', rendered: 'target', callbackUrl: null },
        { raw: 'data:text/html,hello', rendered: 'target', callbackUrl: null },
        { raw: 'README.md', rendered: 'target', callbackUrl: null },
        { raw: './README.md', rendered: '[target](./README.md)', callbackUrl: './README.md' },
        { raw: 'mailto:test@example.com', rendered: '[target](mailto:test@example.com)', callbackUrl: 'mailto:test@example.com' },
        { raw: 'https://example.com/path', rendered: '[target](https://example.com/path)', callbackUrl: 'https://example.com/path' },
        { raw: 'http://example.com/path', rendered: '[target](http://example.com/path)', callbackUrl: 'http://example.com/path' },
    ])('validates $raw before exposing a destination to the renderer or callback', async ({ raw, rendered, callbackUrl }) => {
        const { MarkdownView } = await import('./MarkdownView');
        const onLinkPress = vi.fn();
        const screen = await renderScreen(
            <MarkdownView markdown={`[target](${raw})`} onLinkPress={onLinkPress} profile="transcript" />,
        );
        const enrichedRun = screen.findByType('EnrichedMarkdownText');

        expect(enrichedRun.props.markdown).toBe(rendered);
        if (callbackUrl == null) {
            expect(enrichedRun.props.markdown).not.toContain(raw);
            expect(onLinkPress).not.toHaveBeenCalled();
            return;
        }

        enrichedRun.props.onLinkPress({ url: callbackUrl });
        expect(onLinkPress).toHaveBeenCalledWith(callbackUrl);
    });

    it('fails Markdown images closed before the enriched renderer can mount a tracking pixel', async () => {
        const { MarkdownView } = await import('./MarkdownView');
        const trackingPixel = 'https://tracker.example/pixel.gif?secret=transcript-known';
        const screen = await renderScreen(
            <MarkdownView
                markdown={`before ![architecture diagram](${trackingPixel}) after`}
                profile="transcript"
            />,
        );
        const enrichedRun = screen.findByType('EnrichedMarkdownText');

        expect(enrichedRun.props.markdown).toBe('before architecture diagram after');
        expect(enrichedRun.props.markdown).not.toContain(trackingPixel);
    });

    it('fails reference-style Markdown images closed before rendering', async () => {
        const { MarkdownView } = await import('./MarkdownView');
        const trackingPixel = 'https://tracker.example/reference.gif';
        const screen = await renderScreen(
            <MarkdownView
                markdown={`![diagram][tracking]\n\n![shortcut]\n\n[tracking]: ${trackingPixel}\n[shortcut]: ${trackingPixel}`}
                profile="transcript"
            />,
        );
        const enrichedRun = screen.findByType('EnrichedMarkdownText');

        expect(enrichedRun.props.markdown).toBe(`diagram\n\nshortcut\n\n[tracking]: ${trackingPixel}\n[shortcut]: ${trackingPixel}`);
        expect(enrichedRun.props.markdown).not.toContain('![');
    });
});
