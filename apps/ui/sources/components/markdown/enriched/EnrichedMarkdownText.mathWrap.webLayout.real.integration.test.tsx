// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { enrichedMarkdownPackageFileUrl } from '@/dev/testkit/harness/enrichedMarkdownPackage';
import { measureWebLayout } from '@/dev/testkit/render/measureWebLayout';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as typeof globalThis & { React: typeof React }).React = React;

type Producer = { EnrichedMarkdownText: React.ComponentType<{
    markdown: string; md4cFlags: { latexMath: boolean; texMathBackslashDelimiters: boolean };
}> };
const flags = { latexMath: true, texMathBackslashDelimiters: true };

// The square-and-reduce table of an archived ORC assistant answer: wide numeric cells in four columns.
const residueTable = String.raw`Residues, squared and reduced:

\[
\begin{array}{c|r|r|l}
k & \text{residue squared} & \text{quotient and remainder} & \text{check of square}\\\hline
1 & 7919^2=62{,}710{,}561
&62M+710{,}375
&(7900+19)^2=62{,}410{,}000+300{,}200+361\\
2 &710{,}375^2=504{,}632{,}640{,}625
&504{,}631M+126{,}732
&(710{,}000+375)^2=504{,}100{,}000{,}000+532{,}500{,}000+140{,}625\\
16 &585{,}867^2=343{,}240{,}141{,}689
&343{,}239M+111{,}972
&(586{,}000-133)^2=343{,}396{,}000{,}000-155{,}876{,}000+17{,}689\\
64 &691{,}173^2=477{,}720{,}115{,}929
&477{,}718M+682{,}775
&(691{,}000+173)^2=477{,}481{,}000{,}000+239{,}086{,}000+29{,}929
\end{array}
\]

Then the prose carries on, including /an/extremely/long/path/segment/that/has/no/break/opportunity/anywhere/in/the/whole/line/of/text.txt`;

afterEach(() => { document.body.replaceChildren(); document.head.querySelectorAll('style[data-test-theme]').forEach(node => node.remove()); });

async function renderTranscriptMarkdown(markdown: string) {
    const url = (name: string, extension = 'ts') => enrichedMarkdownPackageFileUrl(`src/web/${name}.${extension}`);
    const parser = await import(/* @vite-ignore */ url('parseMarkdown')) as { preloadMarkdownRuntime(): Promise<void> };
    await parser.preloadMarkdownRuntime();
    const math = await import(/* @vite-ignore */ url('katex')) as { loadKaTeX(): Promise<unknown> };
    await math.loadKaTeX();
    const { EnrichedMarkdownText } = await import(/* @vite-ignore */ url('EnrichedMarkdownText', 'tsx')) as Producer;
    // The product's global stylesheet owns the transcript wrapping policy.
    const theme = document.createElement('style');
    theme.dataset.testTheme = '';
    theme.textContent = readFileSync(resolve(process.cwd(), 'sources/theme.css'), 'utf8');
    document.head.append(theme);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
        root.render(
            <div data-happier-enriched-markdown-profile="transcript">
                <EnrichedMarkdownText markdown={markdown} md4cFlags={flags} />
            </div>,
        );
    });
    return host;
}

/** Marks the math block and every leaf glyph run of each array cell, so the browser reports their boxes. */
function tagMath(host: HTMLElement): string[][][] {
    host.querySelector('[role="math"]')?.setAttribute('data-testid', 'math-block');
    [...host.querySelectorAll('p')].find(p => p.textContent?.includes('/an/extremely/'))?.setAttribute('data-testid', 'long-path');
    return [...host.querySelectorAll('mtable > mtr')].map((row, r) => [...row.children].map((cell, c) => {
        const leaves = [...cell.querySelectorAll('mn, mi, mo, mtext')];
        leaves.forEach((leaf, a) => leaf.setAttribute('data-testid', `cell-${r}-${c}-${a}`));
        return leaves.map((_, a) => `cell-${r}-${c}-${a}`);
    }));
}

describe('transcript math keeps its intrinsic layout', () => {
    it.each([818, 358])('lays an array out in complete, non-overlapping cells inside a %ipx transcript', async (width) => {
        const host = await renderTranscriptMarkdown(residueTable);
        const cells = tagMath(host);
        expect(cells.length).toBe(5);
        const layout = await measureWebLayout(host, { viewport: { width, height: 800 } });

        const extent = (ids: string[]) => ({
            left: Math.min(...ids.map(id => layout.rect(id).left)),
            right: Math.max(...ids.map(id => layout.rect(id).right)),
        });
        const overlaps: string[] = [];
        cells.forEach((row, r) => row.slice(1).forEach((ids, index) => {
            const previous = extent(row[index]!);
            const next = extent(ids);
            if (previous.right > next.left + 0.5) overlaps.push(`row ${r}: column ${index} runs into column ${index + 1}`);
        }));
        expect(overlaps).toEqual([]);

        // The block stays inside the transcript column and owns the horizontal scroll to both ends.
        const block = layout.rect('math-block');
        expect(block.width).toBeLessThanOrEqual(width);
        // Prose keeps its emergency wrapping: the unbreakable path breaks inside the column.
        expect(layout.rect('long-path').scrollWidth).toBeLessThanOrEqual(layout.rect('long-path').clientWidth! + 1);
        const rightmost = Math.max(...cells.flat(2).map(id => layout.rect(id).right));
        expect(rightmost - block.left).toBeLessThanOrEqual((block.scrollWidth ?? 0) + 1);
    });
});
