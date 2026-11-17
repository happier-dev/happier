import { expect, it, vi } from 'vitest';
import type { ComponentType } from 'react';
import type { ReactTestRenderer } from 'react-test-renderer';
import { enrichedMarkdownPackageFileUrl } from '@/dev/testkit/harness/enrichedMarkdownPackage';

function renderedText(node: ReturnType<ReactTestRenderer['toJSON']>): string {
    if (!node) return '';
    if (Array.isArray(node)) return node.map(renderedText).join('');
    return (node.children ?? []).map((child) => typeof child === 'string' ? child : renderedText(child)).join('');
}

// Diagnostic-only React renderer boundary: observe committed work without replacing renderers.
function createCommittedTextCounter() {
    type Fiber = {
        tag: number; flags: number; type: unknown;
        alternate: Fiber | null; child: Fiber | null; sibling: Fiber | null; return: Fiber | null;
        stateNode?: { current?: Fiber };
        memoizedProps: { node?: { content?: unknown } } | null;
    };
    const current = new WeakMap<Fiber, boolean>();
    let renders = 0;
    return {
        observe(screen: ReactTestRenderer, active: boolean) {
            // react-test-renderer's untyped diagnostic root; no component logic is replaced.
            let root = (screen.root as unknown as { _fiber?: Fiber })._fiber;
            if (!root) throw new Error('Renderer diagnostic fiber unavailable');
            while (root.return) root = root.return;
            const committed = root.stateNode?.current;
            if (!committed) throw new Error('Committed root unavailable');
            const stack = [committed];
            let observedNodes = 0;
            while (stack.length) {
                const fiber = stack.pop()!;
                const performed = current.get(fiber) !== true
                    && (!fiber.alternate || (fiber.flags & 1) === 1);
                const content = fiber.memoizedProps?.node?.content;
                if (typeof fiber.type === 'function'
                    && fiber.type.name === 'TextRenderer'
                    && typeof content === 'string' && content.startsWith('Committed ')) {
                    observedNodes++;
                    if (active && performed) renders++;
                }
                current.set(fiber, true);
                if (fiber.alternate) current.set(fiber.alternate, false);
                if (fiber.sibling) stack.push(fiber.sibling);
                if (fiber.child) stack.push(fiber.child);
            }
            return { renders, observedNodes };
        },
    };
}

it.each([
    { runtime: 'source', parserPath: 'src/web/parseMarkdown.ts', componentPath: 'src/web/EnrichedMarkdownText.tsx' },
    { runtime: 'emitted ESM', parserPath: 'lib/module/web/parseMarkdown.js', componentPath: 'lib/module/web/EnrichedMarkdownText.js' },
])('does not rerender earlier prose nodes when only the last block streams ($runtime)', async ({ parserPath, componentPath }) => {
    const React = await import('react');
    const renderer = await import('react-test-renderer');
    const parserUrl = enrichedMarkdownPackageFileUrl(parserPath);
    const parser = await import(/* @vite-ignore */ parserUrl) as { preloadMarkdownRuntime: () => Promise<void> };
    await parser.preloadMarkdownRuntime();
    vi.useFakeTimers();
    const moduleUrl = enrichedMarkdownPackageFileUrl(componentPath);
    const { EnrichedMarkdownText } = await import(/* @vite-ignore */ moduleUrl) as {
        EnrichedMarkdownText: ComponentType<{ markdown: string; md4cFlags: { latexMath: boolean }; streamingAnimation: boolean }>;
    };
    const prefix = Array.from({ length: 40 }, (_, index) => `Committed paragraph ${index}.`).join('\n\n');
    const flags = { latexMath: false };
    const element = (tail: string) => React.createElement(EnrichedMarkdownText, {
        markdown: `${prefix}\n\nDraft ${tail}`, md4cFlags: flags, streamingAnimation: true,
    });
    let screen: ReturnType<typeof renderer.create> | undefined;
    const observer = createCommittedTextCounter();
    try {
        await renderer.act(async () => { screen = renderer.create(element('start')); });
        expect(observer.observe(screen!, false).observedNodes).toBe(40);
        let unchangedNodeRenders = 0;
        for (let index = 1; index <= 10; index++) {
            await renderer.act(async () => { screen!.update(element('word '.repeat(index))); });
            unchangedNodeRenders = observer.observe(screen!, true).renders;
            const output = renderedText(screen!.toJSON());
            expect(output.endsWith(`Draft ${'word '.repeat(index).trimEnd()}`)).toBe(true);
            expect(output).toContain('Committed paragraph 39.');
        }
        // A frozen renderer would pass the cost assertion but fail this positive freshness check.
        expect(JSON.stringify(screen!.toJSON())).toContain('word');
        expect(unchangedNodeRenders).toBe(0);
    } finally {
        if (screen) await renderer.act(async () => { screen!.unmount(); });
        vi.useRealTimers();
    }
});

it('keeps reveal expiry, callbacks, styles and reordered task indices fresh after sharing a prefix', async () => {
    const React = await import('react');
    const renderer = await import('react-test-renderer');
    const parserUrl = enrichedMarkdownPackageFileUrl('src/web/parseMarkdown.ts');
    const parser = await import(/* @vite-ignore */ parserUrl) as { preloadMarkdownRuntime: () => Promise<void> };
    await parser.preloadMarkdownRuntime();
    type Props = {
        markdown: string;
        markdownStyle?: { paragraph?: { color: string } };
        md4cFlags: { latexMath: boolean };
        streamingAnimation: boolean;
        onLinkPress?: (event: { url: string }) => void;
        onTaskListItemPress?: (event: { index: number; checked: boolean; text: string }) => void;
    };
    const moduleUrl = enrichedMarkdownPackageFileUrl('src/web/EnrichedMarkdownText.tsx');
    const { EnrichedMarkdownText } = await import(/* @vite-ignore */ moduleUrl) as { EnrichedMarkdownText: ComponentType<Props> };
    const flags = { latexMath: false };
    const oldLink = vi.fn();
    const newLink = vi.fn();
    const task = vi.fn();
    const base = '[Open](https://example.com) and `code`.\n\n- [ ] first\n- [x] second\n\nDraft';
    const element = (markdown: string, onLinkPress = oldLink, color = 'red') => React.createElement(EnrichedMarkdownText, {
        markdown, md4cFlags: flags, streamingAnimation: true,
        markdownStyle: { paragraph: { color } }, onLinkPress, onTaskListItemPress: task,
    });
    let screen: ReactTestRenderer | undefined;
    vi.useFakeTimers();
    try {
        await renderer.act(async () => { screen = renderer.create(element(base)); });
        await renderer.act(async () => { screen!.update(element(`${base} newly streamed`)); });
        expect(screen!.root.findAllByProps({ 'data-happier-enriched-markdown-reveal': 'text' }).length).toBeGreaterThan(0);
        await renderer.act(async () => { vi.advanceTimersByTime(300); });
        expect(screen!.root.findAllByProps({ 'data-happier-enriched-markdown-reveal': 'text' })).toHaveLength(0);
        expect(renderedText(screen!.toJSON())).toContain('newly streamed');
        const oldColor = screen!.root.findAllByType('p')[0]!.props.style.color;
        await renderer.act(async () => { screen!.update(element(`${base} newly streamed`, newLink, 'blue')); });
        const anchor = screen!.root.findByType('a');
        await renderer.act(async () => { anchor.props.onClick({ preventDefault: vi.fn() }); });
        expect(oldLink).not.toHaveBeenCalled();
        expect(newLink).toHaveBeenCalledWith({ url: 'https://example.com' });
        expect(screen!.root.findAllByType('p')[0]!.props.style.color).not.toBe(oldColor);
        const reordered = base.replace('- [ ] first\n- [x] second', '- [x] second\n- [ ] first');
        await renderer.act(async () => { screen!.update(element(reordered, newLink, 'blue')); });
        const firstTask = screen!.root.findByProps({ 'aria-label': 'Task: first' });
        await renderer.act(async () => { firstTask.props.onChange(); });
        expect(task).toHaveBeenCalledWith({ index: 1, checked: true, text: 'first' });
        expect(screen!.root.findByProps({ 'aria-label': 'Task: first' }).props.checked).toBe(true);
    } finally {
        if (screen) await renderer.act(async () => { screen!.unmount(); });
        vi.useRealTimers();
    }
});

it('does not leak caller mutations or render annotations into another parse', async () => {
    type Node = { type: string; content?: string; attributes?: Record<string, unknown>; children?: Node[] };
    const parserUrl = enrichedMarkdownPackageFileUrl('src/web/parseMarkdown.ts');
    const parser = await import(/* @vite-ignore */ parserUrl) as { parseMarkdown: (markdown: string) => Promise<Node> };
    const markdown = '- [ ] isolated';
    const first = await parser.parseMarkdown(markdown);
    const text = (node: Node): Node | undefined => node.type === 'Text' ? node : node.children?.map(text).find(Boolean);
    text(first)!.content = 'corrupted';
    first.children![0]!.attributes = { mutated: true };
    const second = await parser.parseMarkdown(markdown);
    expect(text(second)?.content).toBe('isolated');
    expect(second.children![0]!.attributes?.mutated).toBeUndefined();
    expect(JSON.stringify(second)).not.toContain('taskIndex');
    expect(JSON.stringify(second)).not.toContain('streamingRevealStartOffset');
});

// Diagnostic-only React renderer boundary: counts function components that rendered in the last commit.
function createCommittedRenderCounter() {
    type Fiber = {
        flags: number; type: unknown;
        alternate: Fiber | null; child: Fiber | null; sibling: Fiber | null; return: Fiber | null;
        stateNode?: { current?: Fiber };
    };
    const current = new WeakMap<Fiber, boolean>();
    return (screen: ReactTestRenderer): number => {
        let root = (screen.root as unknown as { _fiber?: Fiber })._fiber;
        if (!root) throw new Error('Renderer diagnostic fiber unavailable');
        while (root.return) root = root.return;
        const committed = root.stateNode?.current;
        if (!committed) throw new Error('Committed root unavailable');
        let renders = 0;
        const stack = [committed];
        while (stack.length) {
            const fiber = stack.pop()!;
            const performed = current.get(fiber) !== true && (!fiber.alternate || (fiber.flags & 1) === 1);
            const component = typeof fiber.type === 'function'
                || (typeof fiber.type === 'object' && fiber.type !== null && 'type' in fiber.type);
            if (component && performed) renders++;
            current.set(fiber, true);
            if (fiber.alternate) current.set(fiber.alternate, false);
            if (fiber.sibling) stack.push(fiber.sibling);
            if (fiber.child) stack.push(fiber.child);
        }
        return renders;
    };
}

it.each([
    { runtime: 'source', parserPath: 'src/web/parseMarkdown.ts', componentPath: 'src/web/EnrichedMarkdownText.tsx' },
    { runtime: 'emitted ESM', parserPath: 'lib/module/web/parseMarkdown.js', componentPath: 'lib/module/web/EnrichedMarkdownText.js' },
])('renders a streamed append into one long paragraph in time bounded by the tail, not the paragraph ($runtime)', async ({ parserPath, componentPath }) => {
    // Workload: an agent replying with numbered lines and no blank lines streams ONE growing
    // paragraph (soft breaks), so block-level sharing cannot isolate the tail.
    const React = await import('react');
    const renderer = await import('react-test-renderer');
    const parser = await import(/* @vite-ignore */ enrichedMarkdownPackageFileUrl(parserPath)) as { preloadMarkdownRuntime: () => Promise<void> };
    await parser.preloadMarkdownRuntime();
    const { EnrichedMarkdownText } = await import(/* @vite-ignore */ enrichedMarkdownPackageFileUrl(componentPath)) as {
        EnrichedMarkdownText: ComponentType<{ markdown: string; md4cFlags: { latexMath: boolean }; streamingAnimation: boolean }>;
    };
    const sentence = 'Caching hot paths and avoiding repeated work keeps software fast.';
    const lines = Array.from({ length: 660 }, (_, index) => `L${index + 1}: ${sentence}`).join('\n');
    const prefixLength = (count: number) => lines.split('\n').slice(0, count).join('\n').length + 1;
    const flags = { latexMath: true };
    const element = (markdown: string) => React.createElement(EnrichedMarkdownText, { markdown, md4cFlags: flags, streamingAnimation: true });
    vi.useFakeTimers();
    const rendersPerUpdate = async (lineCount: number) => {
        let screen: ReactTestRenderer | undefined;
        const count = createCommittedRenderCounter();
        let length = prefixLength(lineCount);
        try {
            await renderer.act(async () => { screen = renderer.create(element(lines.slice(0, length))); });
            count(screen!);
            let renders = 0;
            // 9 appends of a third of a line: three of them start a new line (a new soft break + text node).
            for (let update = 0; update < 9; update++) {
                length += 23;
                await renderer.act(async () => { screen!.update(element(lines.slice(0, length))); });
                renders += count(screen!);
                // Freshness: the streamed tail is painted.
                expect(renderedText(screen!.toJSON()).endsWith(lines.slice(length - 10, length).replace(/\n/g, '').trimEnd())).toBe(true);
            }
            expect(renderedText(screen!.toJSON())).toContain(`L1: ${sentence}`);
            return renders / 9;
        } finally {
            if (screen) await renderer.act(async () => { screen!.unmount(); });
        }
    };
    try {
        const short = await rendersPerUpdate(160);
        const long = await rendersPerUpdate(650);
        // Before: 409 → 1,635 component renders per update (every line's RenderNode, a third of
        // its renderers). Flat means the 650-line paragraph costs what the 160-line one does.
        expect({ short, long: Math.max(long, short) }).toEqual({ short, long: short });
        expect(long).toBeLessThanOrEqual(16);
    } finally {
        vi.useRealTimers();
    }
});

it.each([
    { runtime: 'source', parserPath: 'src/web/parseMarkdown.ts', mathPath: 'src/web/katex.ts', componentPath: 'src/web/EnrichedMarkdownText.tsx' },
    { runtime: 'emitted ESM', parserPath: 'lib/module/web/parseMarkdown.js', mathPath: 'lib/module/web/katex.js', componentPath: 'lib/module/web/EnrichedMarkdownText.js' },
])('mounts a block in one commit once KaTeX has loaded, with math rendered in it ($runtime)', async ({ parserPath, mathPath, componentPath }) => {
    // Long-thread scroll mounts markdown blocks long after KaTeX settled; each extra commit
    // re-renders the block's whole document (P03-JOURNEYS-4 §1.3).
    const React = await import('react');
    const renderer = await import('react-test-renderer');
    const parser = await import(/* @vite-ignore */ enrichedMarkdownPackageFileUrl(parserPath)) as { preloadMarkdownRuntime: () => Promise<void> };
    await parser.preloadMarkdownRuntime();
    const math = await import(/* @vite-ignore */ enrichedMarkdownPackageFileUrl(mathPath)) as { loadKaTeX: () => Promise<unknown> };
    expect(await math.loadKaTeX()).not.toBeNull();
    const { EnrichedMarkdownText } = await import(/* @vite-ignore */ enrichedMarkdownPackageFileUrl(componentPath)) as {
        EnrichedMarkdownText: ComponentType<{ markdown: string; md4cFlags: { latexMath: boolean } }>;
    };
    let commits = 0;
    const flags = { latexMath: true };
    let screen: ReactTestRenderer | undefined;
    try {
        await renderer.act(async () => {
            screen = renderer.create(React.createElement(React.Profiler, { id: 'block', onRender: () => { commits++; } },
                React.createElement(EnrichedMarkdownText, { markdown: 'Prose with $$x^2$$ math.', md4cFlags: flags })));
        });
        await renderer.act(async () => { await math.loadKaTeX(); });
        expect(JSON.stringify(screen!.toJSON())).toContain('katex');
        expect(commits).toBe(1);
    } finally {
        if (screen) await renderer.act(async () => { screen!.unmount(); });
    }
});
