// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { describe, expect, it, vi } from 'vitest';
import { enrichedMarkdownPackageFileUrl } from '@/dev/testkit/harness/enrichedMarkdownPackage';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as typeof globalThis & { React: typeof React }).React = React;

type Producer = { EnrichedMarkdownText: React.ComponentType<{
    markdown: string; md4cFlags: { latexMath: boolean; texMathBackslashDelimiters: boolean };
}> };
const flags = { latexMath: true, texMathBackslashDelimiters: true };
const cases = [
    // The first 86 characters of the archived ORC assistant answer (seq 4).
    { name: 'real partial assistant paragraph', math: 2, markdown: 'Using \\(M=1{,}000{,}003\\), the binary expansion is\n\\[\n123=64+32+16+8+2+1.\n\\]\nSo we nee' },
    { name: 'Strong and Link ancestors', math: 2, markdown: '**$$x^2$$** and [$$y^2$$](https://example.com).' },
    { name: 'blockquote and list ancestors', math: 2, markdown: '> \\[\n> q^2\n> \\]\n\n- \\[\n  r^2\n  \\]' },
    { name: 'task span ancestor', math: 1, markdown: '- [x] Done $$x^2$$' },
    { name: 'complete array math', math: 1, markdown: 'Before\n\\[\n\\begin{array}{c|r}a&1\\\\b&2\\end{array}\n\\]\nAfter' },
] as const;

function invalidFlowDescendants(container: HTMLElement): Element[] {
    return [...container.querySelectorAll('p, strong, em, a, s, u, span')]
        .flatMap(parent => [...parent.querySelectorAll('div, pre, p, ul, ol, blockquote, table, section')]);
}

async function loadProducer(kind: 'source' | 'emitted') {
    // KaTeX readiness is module state, and a block mounted after it settled renders math in its
    // first commit: start each case from fresh modules so its cold phase is really cold.
    vi.resetModules();
    const file = (name: string, extension = 'ts') => enrichedMarkdownPackageFileUrl(kind === 'source'
        ? `src/web/${name}.${extension}` : `lib/module/web/${name}.js`);
    const parser = await import(/* @vite-ignore */ file('parseMarkdown')) as { preloadMarkdownRuntime(): Promise<void> };
    await parser.preloadMarkdownRuntime();
    const math = await import(/* @vite-ignore */ file('katex')) as { loadKaTeX(): Promise<unknown> };
    const producer = await import(/* @vite-ignore */ file('EnrichedMarkdownText', 'tsx')) as Producer;
    return { ...producer, math };
}

describe.each(['source', 'emitted'] as const)('real %s enriched Markdown math DOM', kind => {
    it.each(cases)('keeps $name valid during cold fallback and optional math readiness', async ({ markdown, math: count, name }) => {
        const { EnrichedMarkdownText, math } = await loadProducer(kind);
        const container = document.createElement('div');
        document.body.append(container);
        const root = createRoot(container);
        const warnings: unknown[][] = [];
        const errors = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { warnings.push(args); });
        try {
            let coldInvalid: Element[] = [];
            let coldText = '';
            let coldStyles: string[] = [];
            await act(async () => {
                flushSync(() => root.render(<EnrichedMarkdownText markdown={markdown} md4cFlags={flags} />));
                coldInvalid = invalidFlowDescendants(container);
                const nodes = [...container.querySelectorAll<HTMLElement>('[role="math"]')];
                expect(nodes).toHaveLength(count);
                coldText = container.textContent ?? '';
                coldStyles = nodes.map(node => [node.style.fontSize, node.style.color, node.style.padding,
                    node.style.marginTop, node.style.marginBottom, node.style.textAlign, node.style.overflowX].join('|'));
                for (const node of nodes.filter(node => node.textContent?.startsWith('$$'))) {
                    expect(getComputedStyle(node).display).toBe('block');
                    expect(getComputedStyle(node).whiteSpace).toBe('pre');
                    expect(getComputedStyle(node).fontFamily).toBe('monospace');
                }
                await math.loadKaTeX();
            });
            const warmNodes = [...container.querySelectorAll<HTMLElement>('[role="math"]')];
            expect(coldText).toContain('$');
            expect(warmNodes).toHaveLength(count);
            expect(container.querySelectorAll('math')).toHaveLength(count);
            expect(warmNodes.map(node => [node.style.fontSize, node.style.color, node.style.padding,
                node.style.marginTop, node.style.marginBottom, node.style.textAlign, node.style.overflowX].join('|'))).toEqual(coldStyles);
            if (name === 'complete array math') expect(container.querySelector('mtable')).not.toBeNull();
            if (name === 'Strong and Link ancestors') expect(container.querySelector('a')?.getAttribute('href')).toBe('https://example.com');
            expect({ coldInvalid: coldInvalid.map(node => node.tagName), warmInvalid: invalidFlowDescendants(container).map(node => node.tagName) })
                .toEqual({ coldInvalid: [], warmInvalid: [] });
            expect(warnings).toEqual([]);
        } finally {
            await act(async () => root.unmount());
            container.remove();
            errors.mockRestore();
        }
    });

    it('keeps incomplete delimiters literal and publishes complete math on the next input', async () => {
        const { EnrichedMarkdownText, math } = await loadProducer(kind);
        await math.loadKaTeX();
        const container = document.createElement('div');
        document.body.append(container);
        const root = createRoot(container);
        try {
            await act(async () => { root.render(<EnrichedMarkdownText markdown={'Value: \\(pending'} md4cFlags={flags} />); });
            expect(container.textContent).toContain('\\(pending');
            expect(container.querySelector('[role="math"]')).toBeNull();
            await act(async () => { root.render(<EnrichedMarkdownText markdown={'Value: \\(x\\).'} md4cFlags={flags} />); });
            expect(container.querySelector('[role="math"]')?.getAttribute('aria-label')).toBe('x');
            expect(container.querySelector('math')).not.toBeNull();
            expect(invalidFlowDescendants(container)).toEqual([]);
        } finally { await act(async () => root.unmount()); container.remove(); }
    });
});
