import React from 'react';
import TestRenderer from 'react-test-renderer';
import { describe, expect, it } from 'vitest';

type StreamingRevealModule = Readonly<{
    createStreamingRevealState: (params: Readonly<{
        enabled: boolean;
        activeRanges: readonly StreamingRevealRange[];
    }>) => {
        activeRanges: readonly StreamingRevealRange[];
    } | null;
    updateStreamingRevealRanges: (params: Readonly<{
        activeRanges: readonly StreamingRevealRange[];
        previousComparisonText: string;
        currentComparisonText: string;
        nowMs: number;
        ttlMs: number;
    }>) => readonly StreamingRevealRange[];
    readRenderedComparisonText: (node: MarkdownAstNode | null) => string;
    renderStreamingRevealText: (params: Readonly<{
        capabilities: {
            katex: null;
            streamingReveal?: {
                activeRanges: readonly StreamingRevealRange[];
            } | null;
        };
        text: string;
        revealable: boolean;
        startOffset: number;
    }>) => React.ReactNode;
}>;

type StreamingRevealRange = Readonly<{
    start: number;
    end: number;
    expiresAtMs: number;
}>;

type WebEnrichedMarkdownTextModule = Readonly<{
    EnrichedMarkdownText: React.ComponentType<{
        markdown: string;
        streamingAnimation?: boolean;
    }>;
}>;

type WebParseMarkdownModule = Readonly<{
    preloadMarkdownRuntime: () => Promise<void>;
}>;

type InlineRendererProps = Readonly<{
    node: {
        type: 'Text';
        content: string;
        streamingRevealStartOffset?: number;
    };
    parentType?: string;
    capabilities: {
        katex: null;
        streamingReveal?: {
            activeRanges: readonly StreamingRevealRange[];
        } | null;
    };
    style: Record<string, never>;
    styles: Record<string, never>;
    callbacks: Record<string, never>;
    renderChildren: () => React.ReactNode;
}>;

type InlineRenderersModule = Readonly<{
    inlineRenderers: Readonly<{
        Text?: (props: InlineRendererProps) => React.ReactNode;
    }>;
}>;

type WebRenderersModule = Readonly<{
    RenderNode: React.ComponentType<{
        node: MarkdownAstNode;
        style: Record<string, unknown>;
        styles: Record<string, unknown>;
        callbacks: Record<string, never>;
        capabilities: { katex: null };
    }>;
}>;

type MarkdownAstNode = Readonly<{
    type: string;
    content?: string;
    attributes?: Record<string, string | number | boolean | undefined>;
    children?: readonly MarkdownAstNode[];
}>;

type RevealSpanProps = Readonly<{
    children?: React.ReactNode;
    'data-happier-enriched-markdown-reveal'?: string;
}>;

async function loadPatchedStreamingReveal(): Promise<StreamingRevealModule> {
    const moduleUrl = new URL(
        '../../../../node_modules/react-native-enriched-markdown/lib/module/web/streamingReveal.js',
        import.meta.url,
    ).href;
    return import(/* @vite-ignore */ moduleUrl) as Promise<StreamingRevealModule>;
}

async function loadPatchedWebEnrichedMarkdownText(): Promise<WebEnrichedMarkdownTextModule> {
    const moduleUrl = new URL(
        '../../../../node_modules/react-native-enriched-markdown/src/web/EnrichedMarkdownText.tsx',
        import.meta.url,
    ).href;
    return import(/* @vite-ignore */ moduleUrl) as Promise<WebEnrichedMarkdownTextModule>;
}

async function loadPatchedWebParseMarkdown(): Promise<WebParseMarkdownModule> {
    const moduleUrl = new URL(
        '../../../../node_modules/react-native-enriched-markdown/lib/module/web/parseMarkdown.js',
        import.meta.url,
    ).href;
    return import(/* @vite-ignore */ moduleUrl) as Promise<WebParseMarkdownModule>;
}

async function loadPatchedInlineRenderers(): Promise<InlineRenderersModule> {
    const moduleUrl = new URL(
        '../../../../node_modules/react-native-enriched-markdown/src/web/renderers/InlineRenderers.tsx',
        import.meta.url,
    ).href;
    return import(/* @vite-ignore */ moduleUrl) as Promise<InlineRenderersModule>;
}

async function loadPatchedWebRenderers(): Promise<WebRenderersModule> {
    const moduleUrl = new URL(
        '../../../../node_modules/react-native-enriched-markdown/src/web/renderers/index.tsx',
        import.meta.url,
    ).href;
    return import(/* @vite-ignore */ moduleUrl) as Promise<WebRenderersModule>;
}

function spanChildren(node: React.ReactNode): string[] {
    if (!Array.isArray(node)) return [];
    return node
        .filter((child): child is React.ReactElement<RevealSpanProps> =>
            React.isValidElement<RevealSpanProps>(child)
            && child.props['data-happier-enriched-markdown-reveal'] === 'text')
        .map((child) => String(child.props.children));
}

function revealTextsFromNode(node: React.ReactNode): string[] {
    if (Array.isArray(node)) {
        return node.flatMap(revealTextsFromNode);
    }

    if (!React.isValidElement<RevealSpanProps>(node)) return [];

    if (node.props['data-happier-enriched-markdown-reveal'] === 'text') {
        return [String(node.props.children)];
    }

    return revealTextsFromNode(node.props.children);
}

function countJsonNodesByType(node: TestRenderer.ReactTestRendererJSON | TestRenderer.ReactTestRendererJSON[] | null, type: string): number {
    if (node === null) return 0;
    if (Array.isArray(node)) {
        return node.reduce((count, child) => count + countJsonNodesByType(child, type), 0);
    }

    return (node.type === type ? 1 : 0)
        + (node.children ?? []).reduce((count, child) => {
            if (typeof child === 'string') return count;
            return count + countJsonNodesByType(child, type);
        }, 0);
}

describe('EnrichedMarkdownText web streaming reveal', () => {
    it('computes rendered comparison text from prose, code, and math nodes', async () => {
        const reveal = await loadPatchedStreamingReveal();
        const ast: MarkdownAstNode = {
            type: 'Paragraph',
            children: [
                { type: 'Text', content: 'Look at ' },
                { type: 'Code', content: 'value' },
                { type: 'LatexMathInline', content: 'x^2' },
            ],
        };

        expect(reveal.readRenderedComparisonText(ast)).toBe('Look at valuex^2');
    });

    it('wraps only newly rendered prose text after the rendered common prefix', async () => {
        const reveal = await loadPatchedStreamingReveal();
        const ranges = reveal.updateStreamingRevealRanges({
            activeRanges: [],
            previousComparisonText: 'Hello ',
            currentComparisonText: 'Hello world',
            nowMs: 1_000,
            ttlMs: 200,
        });
        const streamingReveal = reveal.createStreamingRevealState({
            enabled: true,
            activeRanges: ranges,
        });
        expect(streamingReveal).not.toBe(null);

        const rendered = reveal.renderStreamingRevealText({
            capabilities: {
                katex: null,
                streamingReveal,
            },
            text: 'Hello world',
            revealable: true,
            startOffset: 0,
        });

        expect(spanChildren(rendered)).toEqual(['world']);
    });

    it('keeps earlier reveal ranges active while later streaming chunks arrive quickly', async () => {
        const reveal = await loadPatchedStreamingReveal();
        const firstRanges = reveal.updateStreamingRevealRanges({
            activeRanges: [],
            previousComparisonText: 'Hello ',
            currentComparisonText: 'Hello world',
            nowMs: 1_000,
            ttlMs: 200,
        });
        const secondRanges = reveal.updateStreamingRevealRanges({
            activeRanges: firstRanges,
            previousComparisonText: 'Hello world',
            currentComparisonText: 'Hello world again',
            nowMs: 1_050,
            ttlMs: 200,
        });
        const streamingReveal = reveal.createStreamingRevealState({
            enabled: true,
            activeRanges: secondRanges,
        });
        expect(streamingReveal).not.toBe(null);

        const rendered = reveal.renderStreamingRevealText({
            capabilities: {
                katex: null,
                streamingReveal,
            },
            text: 'Hello world again',
            revealable: true,
            startOffset: 0,
        });

        expect(spanChildren(rendered)).toEqual(['world', 'again']);
    });

    it('expires completed reveal ranges after their animation window', async () => {
        const reveal = await loadPatchedStreamingReveal();
        const ranges = reveal.updateStreamingRevealRanges({
            activeRanges: [],
            previousComparisonText: 'Hello ',
            currentComparisonText: 'Hello world',
            nowMs: 1_000,
            ttlMs: 100,
        });
        const expired = reveal.updateStreamingRevealRanges({
            activeRanges: ranges,
            previousComparisonText: 'Hello world',
            currentComparisonText: 'Hello world',
            nowMs: 1_101,
            ttlMs: 100,
        });
        const streamingReveal = reveal.createStreamingRevealState({
            enabled: true,
            activeRanges: expired,
        });

        const rendered = reveal.renderStreamingRevealText({
            capabilities: {
                katex: null,
                streamingReveal,
            },
            text: 'Hello world',
            revealable: true,
            startOffset: 0,
        });

        expect(expired).toEqual([]);
        expect(spanChildren(rendered)).toEqual([]);
    });

    it('uses explicit render offsets without wrapping non-revealable text', async () => {
        const reveal = await loadPatchedStreamingReveal();
        const ranges = reveal.updateStreamingRevealRanges({
            activeRanges: [],
            previousComparisonText: 'code ',
            currentComparisonText: 'code world',
            nowMs: 1_000,
            ttlMs: 200,
        });
        const streamingReveal = reveal.createStreamingRevealState({
            enabled: true,
            activeRanges: ranges,
        });
        expect(streamingReveal).not.toBe(null);

        const renderedCode = reveal.renderStreamingRevealText({
            capabilities: {
                katex: null,
                streamingReveal,
            },
            text: 'code ',
            revealable: false,
            startOffset: 0,
        });
        const renderedProse = reveal.renderStreamingRevealText({
            capabilities: {
                katex: null,
                streamingReveal,
            },
            text: 'world',
            revealable: true,
            startOffset: 'code '.length,
        });

        expect(renderedCode).toBe('code ');
        expect(spanChildren(renderedProse)).toEqual(['world']);
    });

    it('routes web inline text rendering through reveal spans with stamped offsets', async () => {
        const reveal = await loadPatchedStreamingReveal();
        const globalWithReact = globalThis as typeof globalThis & { React?: typeof React };
        globalWithReact.React = React;
        const { inlineRenderers } = await loadPatchedInlineRenderers();
        const textRenderer = inlineRenderers.Text;
        if (!textRenderer) {
            throw new Error('Expected web Text inline renderer to exist');
        }

        const ranges = reveal.updateStreamingRevealRanges({
            activeRanges: [],
            previousComparisonText: 'Hello ',
            currentComparisonText: 'Hello world',
            nowMs: 1_000,
            ttlMs: 200,
        });
        const streamingReveal = reveal.createStreamingRevealState({
            enabled: true,
            activeRanges: ranges,
        });
        expect(streamingReveal).not.toBe(null);

        const rendered = textRenderer({
            node: {
                type: 'Text',
                content: 'Hello world',
                streamingRevealStartOffset: 0,
            },
            parentType: 'Paragraph',
            capabilities: {
                katex: null,
                streamingReveal,
            },
            style: {},
            styles: {},
            callbacks: {},
            renderChildren: () => null,
        });

        expect(revealTextsFromNode(rendered)).toEqual(['world']);
    });

    it('classifies reveal ranges idempotently when React repeats a render pass', async () => {
        const reveal = await loadPatchedStreamingReveal();
        const ranges = reveal.updateStreamingRevealRanges({
            activeRanges: [],
            previousComparisonText: 'Hello ',
            currentComparisonText: 'Hello world',
            nowMs: 1_000,
            ttlMs: 200,
        });
        const streamingReveal = reveal.createStreamingRevealState({
            enabled: true,
            activeRanges: ranges,
        });
        expect(streamingReveal).not.toBe(null);

        const firstRender = reveal.renderStreamingRevealText({
            capabilities: {
                katex: null,
                streamingReveal,
            },
            text: 'Hello world',
            revealable: true,
            startOffset: 0,
        });
        const repeatedRender = reveal.renderStreamingRevealText({
            capabilities: {
                katex: null,
                streamingReveal,
            },
            text: 'Hello world',
            revealable: true,
            startOffset: 0,
        });

        expect(spanChildren(firstRender)).toEqual(['world']);
        expect(spanChildren(repeatedRender)).toEqual(['world']);
    });

    it('renders markdown text immediately before the async web parser resolves', async () => {
        const { EnrichedMarkdownText } = await loadPatchedWebEnrichedMarkdownText();
        const globalWithReact = globalThis as typeof globalThis & { React?: typeof React };
        globalWithReact.React = React;
        const rendererHolder: { current: TestRenderer.ReactTestRenderer | null } = { current: null };
        TestRenderer.act(() => {
            rendererHolder.current = TestRenderer.create(<EnrichedMarkdownText markdown="Immediate fallback text" />);
        });

        const renderer = rendererHolder.current;
        if (renderer === null) {
            throw new Error('Expected EnrichedMarkdownText test renderer to be created');
        }

        expect(JSON.stringify(renderer.toJSON())).toContain('Immediate fallback text');
        TestRenderer.act(() => {
            renderer.unmount();
        });
    });

    it('preserves paragraph block boundaries inside loose ordered list items', async () => {
        const { RenderNode } = await loadPatchedWebRenderers();
        const globalWithReact = globalThis as typeof globalThis & { React?: typeof React };
        globalWithReact.React = React;
        const ast: MarkdownAstNode = {
            type: 'OrderedList',
            children: [
                {
                    type: 'ListItem',
                    children: [
                        {
                            type: 'Paragraph',
                            children: [{ type: 'Text', content: 'First title' }],
                        },
                        {
                            type: 'Paragraph',
                            children: [{ type: 'Text', content: 'First continuation' }],
                        },
                    ],
                },
                {
                    type: 'ListItem',
                    children: [
                        {
                            type: 'Paragraph',
                            children: [{ type: 'Text', content: 'Second title' }],
                        },
                    ],
                },
            ],
        };
        const rendererHolder: { current: TestRenderer.ReactTestRenderer | null } = { current: null };
        TestRenderer.act(() => {
            rendererHolder.current = TestRenderer.create(
                <RenderNode
                    node={ast}
                    style={{}}
                    styles={{
                        list: {},
                        listNested: {},
                        listTask: {},
                        paragraph: {},
                        paragraphInListItem: {},
                        paragraphInLastListItemChild: {},
                    }}
                    callbacks={{}}
                    capabilities={{ katex: null }}
                />,
            );
        });
        const renderer = rendererHolder.current;
        if (renderer === null) {
            throw new Error('Expected RenderNode test renderer to be created');
        }

        expect(countJsonNodesByType(renderer.toJSON(), 'ol')).toBe(1);
        expect(countJsonNodesByType(renderer.toJSON(), 'li')).toBe(2);
        expect(countJsonNodesByType(renderer.toJSON(), 'p')).toBe(3);
        TestRenderer.act(() => {
            renderer.unmount();
        });
    });

    it('exposes a web parser warmup hook for transcript preloading', async () => {
        const parser = await loadPatchedWebParseMarkdown();

        await expect(parser.preloadMarkdownRuntime()).resolves.toBeUndefined();
    });
});
