import { DiffHunksRenderer, getSingularPatch, parseDiffFromFile } from '@pierre/diffs';
import { describe, expect, it } from 'vitest';
import { buildPierreDiffOptionsBase } from './buildPierreDiffOptionsBase.web';

describe('Pierre unified old/new gutter', () => {
    it('renders genuine context expansion when both complete sources are available', async () => {
        const contents = Array.from({ length: 40 }, (_, index) => `line ${index}`).join('\n');
        const fileDiff = parseDiffFromFile({ name: 'a.txt', contents }, { name: 'a.txt', contents: contents.replace('line 20', 'changed 20') }, { context: 3 });
        const renderer = new DiffHunksRenderer({ diffStyle: 'unified', theme: 'pierre-light', hunkSeparators: 'line-info', disableFileHeader: true });
        try {
            const rendered = await renderer.asyncRender(fileDiff);
            expect(renderer.renderFullHTML(rendered)).toContain('data-expand-button');
        } finally {
            renderer.cleanUp();
        }
    });
    it('names the hunk context and marks changed words without promising absent patch context', async () => {
        const patchText = '--- a/a.ts\n+++ b/a.ts\n@@ -5 +5 @@ export function example() {\n-const key = route.path + width;\n+const key = route.path;\n';
        const patch = getSingularPatch(patchText);
        if (!patch) throw new Error('Expected parsed patch');
        const renderer = new DiffHunksRenderer(buildPierreDiffOptionsBase({
            isDark: false, diffStyle: 'unified', patchText, wrapLines: true, showLineNumbers: true, showPrefix: true,
            tokenizeMaxLineLength: 1000, themeIds: { light: 'pierre-light', dark: 'pierre-dark' },
            intraLineDiff: { enabled: true, maxPatchLines: 2000, maxLineLength: 1000 },
        }));
        try {
            const rendered = await renderer.asyncRender(patch);
            const html = renderer.renderFullHTML(rendered);
            expect(html).toContain('data-hunk-context');
            expect(html).toContain('export function example()');
            expect(html).toContain('data-diff-span');
            expect(html).not.toContain('data-expand-button');
        } finally {
            renderer.cleanUp();
        }
    });

    it('keeps both source coordinates while preserving the interactive line identity', async () => {
        const patch = getSingularPatch([
            '--- a/a.txt', '+++ b/a.txt', '@@ -4,3 +9,3 @@',
            ' context', '-before', '+after', ' tail', '',
        ].join('\n'));
        if (!patch) throw new Error('Expected a parsed patch');
        const renderer = new DiffHunksRenderer({ diffStyle: 'unified', theme: 'pierre-light', disableFileHeader: true });
        try {
            const rendered = await renderer.asyncRender(patch);
            const rows = rendered.unifiedGutterAST?.filter((node) => node.type === 'element' && node.properties?.['data-column-number'] != null);
            expect(rows?.map((row) => row.type === 'element' ? [row.properties['data-column-number'], row.properties['data-old-line-number'], row.properties['data-new-line-number']] : [])).toEqual([
                [9, 4, 9], [5, 5, undefined], [10, undefined, 10], [11, 6, 11],
            ]);
        } finally {
            renderer.cleanUp();
        }
    });
});
