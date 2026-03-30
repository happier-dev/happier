import { describe, expect, it } from 'vitest';

import { rewriteRendererCreateToRenderScreen, rewriteStandardCleanup } from './rendererCreateRewriter';

describe('rewriteRendererCreateToRenderScreen', () => {
    it('rewrites async renderer.create callsites to await renderScreen', () => {
        const input = [
            "import renderer from 'react-test-renderer';",
            "import { it } from 'vitest';",
            "it('works', async () => {",
            '    const tree = renderer.create(<Thing />);',
            '    expect(tree).toBeTruthy();',
            '});',
        ].join('\n');

        const result = rewriteRendererCreateToRenderScreen(input, { filePath: 'render.test.tsx' });

        expect(result.rewrites).toEqual([
            {
                kind: 'rendererCreate',
                summary: 'renderer.create(...) -> await renderScreen(...)',
            },
        ]);
        expect(result.text).toContain("import { renderScreen } from '@/dev/testkit';");
        expect(result.text).toContain('const tree = await renderScreen(<Thing />);');
    });
});

describe('rewriteStandardCleanup', () => {
    it('adds standardCleanup after renderScreen files that lack cleanup', () => {
        const input = [
            "import { it } from 'vitest';",
            "import { renderScreen } from '@/dev/testkit';",
            "it('works', async () => {",
            '    await renderScreen(<Thing />);',
            '});',
        ].join('\n');

        const result = rewriteStandardCleanup(input, { filePath: 'cleanup.test.tsx' });

        expect(result.rewrites).toEqual([
            {
                kind: 'standardCleanup',
                summary: 'added afterEach(standardCleanup)',
            },
        ]);
        expect(result.text).toContain("import { afterEach, it } from 'vitest';");
        expect(result.text).toContain("import { renderScreen, standardCleanup } from '@/dev/testkit';");
        expect(result.text).toContain('afterEach(() => {');
        expect(result.text).toContain('standardCleanup();');
    });
});
