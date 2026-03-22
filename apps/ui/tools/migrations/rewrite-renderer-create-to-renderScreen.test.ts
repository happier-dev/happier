import { describe, expect, it } from 'vitest';

describe('rewrite-renderer-create-to-renderScreen script', () => {
    it('rewrites wrapped async act blocks when trailing statements are only microtask flushes', async () => {
        const migrationModule = await import('./rewrite-renderer-create-to-renderScreen');

        const input = [
            "import renderer, { act } from 'react-test-renderer';",
            "import { it } from 'vitest';",
            "it('works', async () => {",
            '    let tree = null;',
            '    await act(async () => {',
            '        tree = renderer.create(<Thing />);',
            '        await Promise.resolve();',
            '        await Promise.resolve();',
            '    });',
            '    expect(tree).toBeTruthy();',
            '});',
        ].join('\n');

        expect(typeof migrationModule.rewriteRendererCreateToRenderScreen).toBe('function');

        const result = migrationModule.rewriteRendererCreateToRenderScreen(input, 'wrapped-render.test.tsx');

        expect(result.changed).toBe(true);
        expect(result.counts.wrappedDirectCreateAssignment).toBe(1);
        expect(result.text).toContain("import { renderScreen } from '@/dev/testkit';");
        expect(result.text).toContain('tree = (await renderScreen(<Thing />)).tree;');
        expect(result.text).not.toContain('await act(async () => {');
        expect(result.text).not.toContain('await Promise.resolve();');
    });

    it('does not rewrite wrapped async act blocks when trailing statements are custom flush helpers', async () => {
        const migrationModule = await import('./rewrite-renderer-create-to-renderScreen');

        const input = [
            "import renderer, { act } from 'react-test-renderer';",
            "import { it } from 'vitest';",
            "it('works', async () => {",
            '    let tree = null;',
            '    await act(async () => {',
            '        tree = renderer.create(<Thing />);',
            '        await flushAsyncTurns();',
            '    });',
            '    expect(tree).toBeTruthy();',
            '});',
        ].join('\n');

        const result = migrationModule.rewriteRendererCreateToRenderScreen(input, 'wrapped-render.guard.test.tsx');

        expect(result.changed).toBe(false);
        expect(result.counts.wrappedDirectCreateAssignment).toBe(0);
        expect(result.text).toContain('await act(async () => {');
        expect(result.text).toContain('await flushAsyncTurns();');
    });

    it('rewrites wrapped async act blocks when trailing statements use the local flushEffects helper', async () => {
        const migrationModule = await import('./rewrite-renderer-create-to-renderScreen');

        const input = [
            "import renderer, { act } from 'react-test-renderer';",
            "import { it } from 'vitest';",
            'async function flushEffects(turns = 2) {',
            '    for (let index = 0; index < turns; index += 1) {',
            '        await Promise.resolve();',
            '    }',
            '}',
            "it('works', async () => {",
            '    let tree = null;',
            '    await act(async () => {',
            '        tree = renderer.create(<Thing />);',
            '        await flushEffects(4);',
            '    });',
            '    expect(tree).toBeTruthy();',
            '});',
        ].join('\n');

        const result = migrationModule.rewriteRendererCreateToRenderScreen(input, 'wrapped-render-flush-effects.test.tsx');

        expect(result.changed).toBe(true);
        expect(result.counts.wrappedDirectCreateAssignment).toBe(1);
        expect(result.text).toContain("import { renderScreen } from '@/dev/testkit';");
        expect(result.text).toContain('tree = (await renderScreen(<Thing />)).tree;');
        expect(result.text).not.toContain('await act(async () => {');
        expect(result.text).not.toContain('await flushEffects(4);');
    });

    it('rewrites wrapped async act blocks when trailing statements wait on a zero-timeout promise flush', async () => {
        const migrationModule = await import('./rewrite-renderer-create-to-renderScreen');

        const input = [
            "import renderer, { act } from 'react-test-renderer';",
            "import { it } from 'vitest';",
            "it('works', async () => {",
            '    let tree = null;',
            '    await act(async () => {',
            '        tree = renderer.create(<Thing />);',
            '        await new Promise((resolve) => setTimeout(resolve, 0));',
            '    });',
            '    expect(tree).toBeTruthy();',
            '});',
        ].join('\n');

        const result = migrationModule.rewriteRendererCreateToRenderScreen(input, 'wrapped-render-timeout-flush.test.tsx');

        expect(result.changed).toBe(true);
        expect(result.counts.wrappedDirectCreateAssignment).toBe(1);
        expect(result.text).toContain("import { renderScreen } from '@/dev/testkit';");
        expect(result.text).toContain('tree = (await renderScreen(<Thing />)).tree;');
        expect(result.text).not.toContain('await act(async () => {');
        expect(result.text).not.toContain('await new Promise((resolve) => setTimeout(resolve, 0));');
    });

    it('rewrites wrapped async act blocks when trailing statements use a local composed flush helper', async () => {
        const migrationModule = await import('./rewrite-renderer-create-to-renderScreen');

        const input = [
            "import renderer, { act } from 'react-test-renderer';",
            "import { it } from 'vitest';",
            'async function flushMicrotasks(count = 3) {',
            '    for (let index = 0; index < count; index += 1) {',
            '        await Promise.resolve();',
            '    }',
            '}',
            'async function flushAsync(count = 3) {',
            '    await flushMicrotasks(count);',
            '    await new Promise((resolve) => setTimeout(resolve, 0));',
            '}',
            "it('works', async () => {",
            '    let tree = null;',
            '    await act(async () => {',
            '        tree = renderer.create(<Thing />);',
            '        await flushAsync(4);',
            '    });',
            '    expect(tree).toBeTruthy();',
            '});',
        ].join('\n');

        const result = migrationModule.rewriteRendererCreateToRenderScreen(input, 'wrapped-render-local-flush-helper.test.tsx');

        expect(result.changed).toBe(true);
        expect(result.counts.wrappedDirectCreateAssignment).toBe(1);
        expect(result.text).toContain("import { renderScreen } from '@/dev/testkit';");
        expect(result.text).toContain('tree = (await renderScreen(<Thing />)).tree;');
        expect(result.text).not.toContain('await act(async () => {');
        expect(result.text).not.toContain('await flushAsync(4);');
    });

    it('rewrites wrapped async act blocks and preserves non-ignorable flushHookEffects follow-up calls', async () => {
        const migrationModule = await import('./rewrite-renderer-create-to-renderScreen');

        const input = [
            "import renderer, { act } from 'react-test-renderer';",
            "import { it } from 'vitest';",
            "import { flushHookEffects } from '@/hooks/server/serverFeatureHookHarness.testHelpers';",
            "it('works', async () => {",
            '    let tree = null;',
            '    await act(async () => {',
            '        tree = renderer.create(<Thing />);',
            '        await flushHookEffects(6);',
            '    });',
            '    expect(tree).toBeTruthy();',
            '});',
        ].join('\n');

        const result = migrationModule.rewriteRendererCreateToRenderScreen(input, 'wrapped-render-flush-hook-effects.test.tsx');

        expect(result.changed).toBe(true);
        expect(result.counts.wrappedDirectCreateAssignment).toBe(1);
        expect(result.text).toContain("import { renderScreen } from '@/dev/testkit';");
        expect(result.text).toContain('tree = (await renderScreen(<Thing />)).tree;');
        expect(result.text).toContain('await flushHookEffects(6);');
        expect(result.text).not.toContain('await act(async () => {');
    });

    it('rewrites sync act assignment mounts by promoting the enclosing test callback to async', async () => {
        const migrationModule = await import('./rewrite-renderer-create-to-renderScreen');

        const input = [
            "import renderer, { act } from 'react-test-renderer';",
            "import { it } from 'vitest';",
            "it('works', () => {",
            '    let root = null;',
            '    act(() => {',
            '        root = renderer.create(React.createElement(Test));',
            '    });',
            '    expect(root).toBeTruthy();',
            '});',
        ].join('\n');

        const result = migrationModule.rewriteRendererCreateToRenderScreen(input, 'wrapped-sync-render.test.tsx');

        expect(result.changed).toBe(true);
        expect(result.counts.wrappedDirectCreateAssignment).toBe(1);
        expect(result.text).toContain("import { renderScreen } from '@/dev/testkit';");
        expect(result.text).toContain("it('works', async () => {");
        expect(result.text).toContain('root = (await renderScreen(React.createElement(Test))).tree;');
        expect(result.text).not.toContain('act(() => {');
    });

    it('rewrites sync act standalone mounts by promoting the enclosing test callback to async', async () => {
        const migrationModule = await import('./rewrite-renderer-create-to-renderScreen');

        const input = [
            "import renderer, { act } from 'react-test-renderer';",
            "import { it } from 'vitest';",
            "it('works', () => {",
            '    act(() => {',
            '        renderer.create(<Probe />);',
            '    });',
            '});',
        ].join('\n');

        const result = migrationModule.rewriteRendererCreateToRenderScreen(input, 'wrapped-sync-standalone.test.tsx');

        expect(result.changed).toBe(true);
        expect(result.counts.wrappedStandaloneCreateCall).toBe(1);
        expect(result.text).toContain("import { renderScreen } from '@/dev/testkit';");
        expect(result.text).toContain("it('works', async () => {");
        expect(result.text).toContain('await renderScreen(<Probe />);');
        expect(result.text).not.toContain('act(() => {');
    });

    it('rewrites wrapped async renderer.act blocks when trailing statements are only microtask flushes', async () => {
        const migrationModule = await import('./rewrite-renderer-create-to-renderScreen');

        const input = [
            "import renderer from 'react-test-renderer';",
            "import { it } from 'vitest';",
            "it('works', async () => {",
            '    let tree = null;',
            '    await renderer.act(async () => {',
            '        tree = renderer.create(<Thing />);',
            '        await Promise.resolve();',
            '    });',
            '    expect(tree).toBeTruthy();',
            '});',
        ].join('\n');

        const result = migrationModule.rewriteRendererCreateToRenderScreen(input, 'wrapped-renderer-act.test.tsx');

        expect(result.changed).toBe(true);
        expect(result.counts.wrappedDirectCreateAssignment).toBe(1);
        expect(result.text).toContain("import { renderScreen } from '@/dev/testkit';");
        expect(result.text).toContain('tree = (await renderScreen(<Thing />)).tree;');
        expect(result.text).not.toContain('await renderer.act(async () => {');
        expect(result.text).not.toContain('await Promise.resolve();');
    });

    it('rewrites helper-wrapped renderer.create assignments inside async act blocks', async () => {
        const migrationModule = await import('./rewrite-renderer-create-to-renderScreen');

        const input = [
            "import renderer, { act } from 'react-test-renderer';",
            "import { it } from 'vitest';",
            'const trackTree = (tree) => tree;',
            "it('works', async () => {",
            '    let tree = null;',
            '    await act(async () => {',
            '        tree = trackTree(renderer.create(<Thing />));',
            '        await Promise.resolve();',
            '    });',
            '    expect(tree).toBeTruthy();',
            '});',
        ].join('\n');

        const result = migrationModule.rewriteRendererCreateToRenderScreen(input, 'wrapped-render-helper.test.tsx');

        expect(result.changed).toBe(true);
        expect(result.counts.wrappedDirectCreateAssignment).toBe(1);
        expect(result.text).toContain("import { renderScreen } from '@/dev/testkit';");
        expect(result.text).toContain('tree = trackTree((await renderScreen(<Thing />)).tree);');
        expect(result.text).not.toContain('await act(async () => {');
        expect(result.text).not.toContain('await Promise.resolve();');
    });

    it('rewrites wrapped async act blocks when synchronous setup statements precede the mount', async () => {
        const migrationModule = await import('./rewrite-renderer-create-to-renderScreen');

        const input = [
            "import renderer, { act } from 'react-test-renderer';",
            "import { it } from 'vitest';",
            'const trackTree = (tree) => tree;',
            "it('works', async () => {",
            '    let tree = null;',
            '    await act(async () => {',
            "        store.begin('session-1');",
            "        store.bind('session-2');",
            '        tree = trackTree(renderer.create(<Thing />));',
            '        await Promise.resolve();',
            '    });',
            '    expect(tree).toBeTruthy();',
            '});',
        ].join('\n');

        const result = migrationModule.rewriteRendererCreateToRenderScreen(input, 'wrapped-render-leading-setup.test.tsx');

        expect(result.changed).toBe(true);
        expect(result.counts.wrappedDirectCreateAssignment).toBe(1);
        expect(result.text).toContain("import { renderScreen } from '@/dev/testkit';");
        expect(result.text).toContain("store.begin('session-1');");
        expect(result.text).toContain("store.bind('session-2');");
        expect(result.text).toContain('tree = trackTree((await renderScreen(<Thing />)).tree);');
        expect(result.text).not.toContain('await act(async () => {');
        expect(result.text).not.toContain('await Promise.resolve();');
    });

    it('rewrites sync renderer.act assignment mounts by promoting the enclosing test callback to async', async () => {
        const migrationModule = await import('./rewrite-renderer-create-to-renderScreen');

        const input = [
            "import renderer from 'react-test-renderer';",
            "import { it } from 'vitest';",
            "it('works', () => {",
            '    let root = null;',
            '    renderer.act(() => {',
            '        root = renderer.create(React.createElement(Test));',
            '    });',
            '    expect(root).toBeTruthy();',
            '});',
        ].join('\n');

        const result = migrationModule.rewriteRendererCreateToRenderScreen(input, 'wrapped-sync-renderer-act.test.tsx');

        expect(result.changed).toBe(true);
        expect(result.counts.wrappedDirectCreateAssignment).toBe(1);
        expect(result.text).toContain("import { renderScreen } from '@/dev/testkit';");
        expect(result.text).toContain("it('works', async () => {");
        expect(result.text).toContain('root = (await renderScreen(React.createElement(Test))).tree;');
        expect(result.text).not.toContain('renderer.act(() => {');
    });
});
