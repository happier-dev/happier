import React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { parseMarkdown } from 'react-native-enriched-markdown/src/web/parseMarkdown';
import type { ASTNode } from 'react-native-enriched-markdown/src/web/types';
import { installMarkdownCommonModuleMocks } from './markdownTestHelpers';
import type { MarkdownImageResolver } from './markdownImages';
import type { MarkdownSourceRangeAction } from './MarkdownView';
import { MarkdownCodeBlock } from './MarkdownCodeBlock';

declare global {
    // eslint-disable-next-line no-var
    var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

installMarkdownCommonModuleMocks();

const documentImages: MarkdownImageResolver = {
    resolve: () => ({ kind: 'blocked' }), remoteLoaded: false, onLoadRemote() {},
};

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
    it('resolves themed web stylesheet text metrics and ink before flattening style arrays', async () => {
        const { MarkdownView } = await import('./MarkdownView');
        const { useUnistyles } = await import('react-native-unistyles');
        const { theme } = useUnistyles();
        // Unistyles 3 web/create.ts keeps the stylesheet/key/arguments non-enumerable
        // in its secret; CSS-class entries need resolving against the current theme.
        const stylesheet = (currentTheme: typeof theme) => ({
            prose: (compact: boolean) => ({
                fontSize: compact ? 15 : 16,
                lineHeight: compact ? 23 : 24,
                color: currentTheme.colors.text.secondary,
            }),
        });
        const secret = Object.defineProperties({}, {
            __uni__stylesheet: { value: stylesheet },
            __uni__key: { value: 'prose' },
            __uni__args: { value: [true] },
        });
        const themedStyle = Object.defineProperty({}, 'unistyles_prose', { value: secret, enumerable: true });
        const screen = await renderScreen(
            <MarkdownView markdown="Themed prose" textStyle={[themedStyle, { fontWeight: '500' }]} />,
        );
        expect(screen.findByType('EnrichedMarkdownText').props.markdownStyle.paragraph).toMatchObject({
            fontSize: 15, lineHeight: 23, color: theme.colors.text.secondary,
        });
        const overridden = await renderScreen(
            <MarkdownView markdown="Overridden prose" textStyle={[themedStyle, { fontSize: 14, color: theme.colors.text.primary }]} />,
        );
        expect(overridden.findByType('EnrichedMarkdownText').props.markdownStyle.paragraph).toMatchObject({
            fontSize: 14, lineHeight: 23, color: theme.colors.text.primary,
        });
    });

    it('resolves native stylesheet metrics and applies the UI font scale once', async () => {
        const { buildEnrichedMarkdownStyle } = await import('./enriched/useEnrichedMarkdownStyle');
        const { useUnistyles } = await import('react-native-unistyles');
        const { theme } = useUnistyles();
        const style = Object.defineProperty({}, 'unistyles_native', {
            enumerable: true,
            value: { uni__getStyles: () => ({ fontSize: 15, lineHeight: 23, color: theme.colors.text.primary }) },
        });
        expect(buildEnrichedMarkdownStyle({
            colors: theme.colors,
            profile: 'transcript',
            uiFontScale: 1.1,
            textStyle: [style, { color: theme.colors.text.secondary }],
        }).markdownStyle.paragraph).toMatchObject({
            fontSize: 16.5, lineHeight: 25.3, color: theme.colors.text.secondary,
        });
    });

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
        expect(screen.findAllByType(MarkdownCodeBlock)).toHaveLength(1);
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
        { raw: 'https://host.test/a?x=1&amp;y=2', rendered: '[target](https://host.test/a?x=1&amp;y=2)' },
    ])('validates $raw before exposing it to the renderer', async ({ raw, rendered }) => {
        const { MarkdownView } = await import('./MarkdownView');
        const screen = await renderScreen(
            <MarkdownView markdown={`[target](${raw})`} profile="transcript" />,
        );

        expect(screen.findByType('EnrichedMarkdownText').props.markdown).toBe(rendered);
    });

    it.each(['README.md', '#section', 'spec:draft.pdf'])('keeps %s available only in a resolver-enabled document', async (url) => {
        const { MarkdownView } = await import('./MarkdownView');
        const onLinkPress = vi.fn(() => true);
        const screen = await renderScreen(<MarkdownView markdown={`[target](${url})`} images={documentImages} onLinkPress={onLinkPress} />);
        const run = screen.findByType('EnrichedMarkdownText');
        expect(run.props.markdown).toBe(`[target](${url})`);
        run.props.onLinkPress({ url });
        expect(onLinkPress).toHaveBeenCalledWith(url);
    });

    it.each([undefined, documentImages])('keeps absolute URL entities while rejecting encoded local-path schemes, with resolver %s', async (images) => {
        const { MarkdownView } = await import('./MarkdownView');
        const onLinkPress = vi.fn(() => true);
        const screen = await renderScreen(<MarkdownView markdown={'[target](https://host.test/a?x=1&amp;y=2)'} images={images} onLinkPress={onLinkPress} />);
        const run = screen.findByType('EnrichedMarkdownText');
        expect(run.props.markdown).toBe('[target](https://host.test/a?x=1&amp;y=2)');
        run.props.onLinkPress({ url: 'https://host.test/a?x=1&amp;y=2' });
        expect(onLinkPress).toHaveBeenCalledWith('https://host.test/a?x=1&amp;y=2');
        onLinkPress.mockClear();
        for (const url of ['javascript&#58;alert(1)', 'java&#x73;cript:alert(1)', 'javascript&colon;alert(1)', 'javascript&#58alert(1)', 'data&colon;text/html,hello']) {
            run.props.onLinkPress({ url });
        }
        expect(onLinkPress).not.toHaveBeenCalled();
    });

    it('uses the same document link policy while Find replaces the enriched renderer', async () => {
        const { MarkdownView } = await import('./MarkdownView');
        const onLinkPress = vi.fn();
        const blocked = await renderScreen(<MarkdownView markdown="[target](javascript&#58;alert(1))" findActive onLinkPress={onLinkPress} images={documentImages} />);
        expect(blocked.findAll(node => node.props.accessibilityRole === 'link')).toHaveLength(0);
        const document = await renderScreen(<MarkdownView markdown="[target](README.md)" findActive onLinkPress={onLinkPress} images={documentImages} />);
        const links = document.findAll(node => node.props.accessibilityRole === 'link');
        expect(links.length).toBeGreaterThan(0);
        links[0]!.props.onPress();
        expect(onLinkPress).toHaveBeenCalledWith('README.md');
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
            renderMarkdown: '# Title',
            sourceStart: 0,
            sourceLength: '# Title'.length,
        });
        expect(flattenStyle(trigger.props.style)).toMatchObject({
            width: '100%',
            alignSelf: 'stretch',
            alignItems: 'stretch',
            textAlign: 'left',
        });
        expect(screen.findAllByType('EnrichedMarkdownText')).toHaveLength(1);
    });

    it('keeps document reference definitions in the native selection renderer input', async () => {
        const { MarkdownView } = await import('./MarkdownView');
        const onPressSourceRange = vi.fn<(action: MarkdownSourceRangeAction) => void>();
        const markdown = '[target][ref]\n\n[ref]: https://example.com';
        const screen = await renderScreen(<MarkdownView markdown={markdown} onPressSourceRange={onPressSourceRange} />);
        screen.findByProps({ testID: 'markdown-source-range-trigger:1-1' }).props.onPress();
        const action = onPressSourceRange.mock.calls[0]![0];
        expect(action.markdown).toBe('[target][ref]');
        expect(action.renderMarkdown).toContain('[ref]: https://example.com');
        expect(action.renderMarkdown).toContain('[target][ref]');
        expect(markdown.slice(action.sourceStart, action.sourceStart + action.sourceLength)).toBe(action.markdown);
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
        const content = screen.findByType('EnrichedMarkdownText');
        expect(inactive.props.accessibilityRole).toBeUndefined();

        await act(async () => {
            enterCommentMode?.();
        });

        const active = screen.findByProps({ testID: 'markdown-source-range-trigger:1-1' });
        expect(active).toBe(inactive);
        expect(screen.findByType('EnrichedMarkdownText')).toBe(content);
        expect(active.props.accessibilityRole).toBe('button');

        active.props.onPress();
        expect(onPressSourceRange).toHaveBeenCalledWith({
            sourceRange: { startLine: 1, endLine: 1 },
            markdown: '# Title',
            renderMarkdown: '# Title',
            sourceStart: 0,
            sourceLength: '# Title'.length,
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
            renderMarkdown: 'Second paragraph.',
            sourceStart: markdown.indexOf('Second paragraph.'),
            sourceLength: 'Second paragraph.'.length,
        });
        expect(screen.findAllByType('EnrichedMarkdownText')).toHaveLength(2);
    });
});
