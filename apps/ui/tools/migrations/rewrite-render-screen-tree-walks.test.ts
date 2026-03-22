import { describe, expect, it } from 'vitest';

describe('rewriteRenderScreenTreeWalks', () => {
    it('rewrites awaited direct press chains, direct text changes, and findAllByProps testID lookups', async () => {
        const migrationModule = await import('./rewrite-render-screen-tree-walks');

        const input = [
            "import { renderScreen } from '@/dev/testkit';",
            "it('works', async () => {",
            '    const tree = (await renderScreen(<Thing />)).tree;',
            "    await tree.root.findByProps({ testID: 'approve' }).props.onPress();",
            "    tree.root.findByProps({ testID: 'message-input' }).props.onChangeText('hello');",
            "    expect(tree.root.findAllByProps({ testID: 'approve' })).toHaveLength(0);",
            '});',
        ].join('\n');

        expect(typeof migrationModule.rewriteRenderScreenTreeWalks).toBe('function');

        const result = migrationModule.rewriteRenderScreenTreeWalks(input, 'tree-walk.test.tsx');

        expect(result.changed).toBe(true);
        expect(result.counts.pressByTestIdAsync).toBe(1);
        expect(result.counts.changeTextByTestId).toBe(1);
        expect(result.counts.findAllByTestId).toBe(1);
        expect(result.text).toContain("await tree.pressByTestIdAsync('approve');");
        expect(result.text).toContain("tree.changeTextByTestId('message-input', 'hello');");
        expect(result.text).toContain("expect(tree.findAllByTestId('approve')).toHaveLength(0);");
    });

    it('rewrites sync direct press and click chains to pressByTestId', async () => {
        const migrationModule = await import('./rewrite-render-screen-tree-walks');

        const input = [
            "import { renderScreen } from '@/dev/testkit';",
            "it('works', async () => {",
            '    const tree = (await renderScreen(<Thing />)).tree;',
            "    tree.root.findByProps({ testID: 'approve' }).props.onPress();",
            "    tree.root.findByProps({ testID: 'dismiss' }).props.onClick();",
            '});',
        ].join('\n');

        const result = migrationModule.rewriteRenderScreenTreeWalks(input, 'tree-walk-sync.test.tsx');

        expect(result.changed).toBe(true);
        expect(result.counts.pressByTestId).toBe(2);
        expect(result.text).toContain("tree.pressByTestId('approve');");
        expect(result.text).toContain("tree.pressByTestId('dismiss');");
    });

    it('rewrites plain root findByProps testID assertions onto the tree proxy without changing the expectation', async () => {
        const migrationModule = await import('./rewrite-render-screen-tree-walks');

        const input = [
            "import { renderScreen } from '@/dev/testkit';",
            "it('works', async () => {",
            '    const tree = (await renderScreen(<Thing />)).tree;',
            "    expect(() => tree.root.findByProps({ testID: 'approve' })).not.toThrow();",
            '});',
        ].join('\n');

        const result = migrationModule.rewriteRenderScreenTreeWalks(input, 'tree-walk-guard.test.tsx');

        expect(result.changed).toBe(true);
        expect(result.counts.pressByTestId).toBe(0);
        expect(result.counts.pressByTestIdAsync).toBe(0);
        expect(result.counts.changeTextByTestId).toBe(0);
        expect(result.counts.findAllByTestId).toBe(0);
        expect(result.counts.rootProxyFinds).toBe(1);
        expect(result.text).toContain("tree.findByProps({ testID: 'approve' })");
    });

    it('rewrites variable-bound awaited press nodes when the declaration sits immediately before the act block', async () => {
        const migrationModule = await import('./rewrite-render-screen-tree-walks');

        const input = [
            "import { act } from 'react-test-renderer';",
            "import { renderScreen } from '@/dev/testkit';",
            "it('works', async () => {",
            '    const tree = (await renderScreen(<Thing />)).tree;',
            "    const browseButton = tree.root.findByProps({ testID: 'path-browser-trigger' });",
            '    await act(async () => {',
            '        await browseButton.props.onPress();',
            '    });',
            '});',
        ].join('\n');

        const result = migrationModule.rewriteRenderScreenTreeWalks(input, 'tree-walk-variable-before-act.test.tsx');

        expect(result.changed).toBe(true);
        expect(result.counts.pressByTestIdAsync).toBe(1);
        expect(result.text).toContain("await act(async () => {\n        await tree.pressByTestIdAsync('path-browser-trigger');\n    });");
        expect(result.text).not.toContain('browseButton.props.onPress');
    });

    it('rewrites variable-bound sync press nodes when the declaration lives inside the act block', async () => {
        const migrationModule = await import('./rewrite-render-screen-tree-walks');

        const input = [
            "import { act } from 'react-test-renderer';",
            "import { renderScreen } from '@/dev/testkit';",
            "it('works', async () => {",
            '    const tree = (await renderScreen(<Thing />)).tree;',
            '    await act(async () => {',
            "        const filesTab = tree!.root.findByProps({ testID: 'session-rightpanel-tab:files' });",
            '        filesTab.props.onPress();',
            '    });',
            '});',
        ].join('\n');

        const result = migrationModule.rewriteRenderScreenTreeWalks(input, 'tree-walk-variable-inside-act.test.tsx');

        expect(result.changed).toBe(true);
        expect(result.counts.pressByTestId).toBe(1);
        expect(result.text).toContain("await act(async () => {\n        tree!.pressByTestId('session-rightpanel-tab:files');\n    });");
        expect(result.text).not.toContain('filesTab.props.onPress');
    });

    it('rewrites generic root find helpers onto tree proxies without changing the predicate shape', async () => {
        const migrationModule = await import('./rewrite-render-screen-tree-walks');

        const input = [
            "import { renderScreen } from '@/dev/testkit';",
            "it('works', async () => {",
            '    const tree = (await renderScreen(<Thing />)).tree;',
            "    const trigger = tree.root.findByType('Pressable');",
            "    const rows = tree.root.findAllByType('Pressable');",
            "    const card = tree.root.findByProps({ testID: 'card' });",
            "    const cards = tree.root.findAllByProps({ testID: 'card' });",
            "    const first = tree.root.find((node) => node.props?.testID === 'card');",
            "    const all = tree.root.findAll((node) => typeof node.type === 'string');",
            '});',
        ].join('\n');

        const result = migrationModule.rewriteRenderScreenTreeWalks(input, 'tree-walk-proxy.test.tsx');

        expect(result.changed).toBe(true);
        expect(result.counts.rootProxyFinds).toBe(5);
        expect(result.text).toContain("const trigger = tree.findByType('Pressable');");
        expect(result.text).toContain("const rows = tree.findAllByType('Pressable');");
        expect(result.text).toContain("const card = tree.findByProps({ testID: 'card' });");
        expect(result.text).toContain("const cards = tree.findAllByTestId('card');");
        expect(result.text).toContain("const first = tree.find((node) => node.props?.testID === 'card');");
        expect(result.text).toContain("const all = tree.findAll((node) => typeof node.type === 'string');");
    });

    it('rewrites optional-chained root find helpers onto optional tree proxies', async () => {
        const migrationModule = await import('./rewrite-render-screen-tree-walks');

        const input = [
            "import { renderScreen } from '@/dev/testkit';",
            "it('works', async () => {",
            '    const tree = (await renderScreen(<Thing />)).tree;',
            "    const child = tree?.root.findByType('PopoverChild');",
            "    const layers = tree?.root.findAllByType('Portal');",
            "    const effects = tree?.root.findAllByProps({ testID: 'popover-backdrop-effect' });",
            '});',
        ].join('\n');

        const result = migrationModule.rewriteRenderScreenTreeWalks(input, 'tree-walk-optional-proxy.test.tsx');

        expect(result.changed).toBe(true);
        expect(result.counts.rootProxyFinds).toBe(2);
        expect(result.counts.findAllByTestId).toBe(1);
        expect(result.text).toContain("const child = tree?.findByType('PopoverChild');");
        expect(result.text).toContain("const layers = tree?.findAllByType('Portal');");
        expect(result.text).toContain("const effects = tree?.findAllByTestId('popover-backdrop-effect');");
    });

    it('rewrites typed-collection exact prop filters onto the shared typed-props helper', async () => {
        const migrationModule = await import('./rewrite-render-screen-tree-walks');

        const input = [
            "import { renderScreen } from '@/dev/testkit';",
            "it('works', async () => {",
            '    const screen = await renderScreen(<Thing />);',
            "    const row = screen.root.findAllByType('Item' as any).find((node) => node.props?.title === '/tmp/worktree') ?? null;",
            "    const label = screen.findAllByType('Text' as any).find((node) => node.props?.children === 'Compact detail');",
            "    const optionalLabel = screen?.findAllByType('Text' as any).find((node) => node.props?.children === 'Optional detail');",
            '});',
        ].join('\n');

        const result = migrationModule.rewriteRenderScreenTreeWalks(input, 'tree-walk-typed-props.test.tsx');

        expect(result.changed).toBe(true);
        expect(result.text).toContain("import { findTestInstanceByTypeWithProps, renderScreen } from '@/dev/testkit';");
        expect(result.text).toContain("const row = findTestInstanceByTypeWithProps(screen, 'Item' as any, { title: '/tmp/worktree' }) ?? null;");
        expect(result.text).toContain("const label = findTestInstanceByTypeWithProps(screen, 'Text' as any, { children: 'Compact detail' });");
        expect(result.text).toContain("const optionalLabel = screen ? findTestInstanceByTypeWithProps(screen, 'Text' as any, { children: 'Optional detail' }) : undefined;");
    });

    it('rewrites casted host-type root lookups onto shared host-type helpers', async () => {
        const migrationModule = await import('./rewrite-render-screen-tree-walks');

        const input = [
            "import { renderScreen } from '@/dev/testkit';",
            "it('works', async () => {",
            '    const tree = (await renderScreen(<Thing />)).tree;',
            "    const webHandle = (tree! as any).root.findByType('Pressable');",
            "    expect((tree! as any).root.findAllByType('Pressable')).toHaveLength(0);",
            "    expect((tree! as any).root.findAllByType('ViewStub')).toHaveLength(1);",
            '});',
        ].join('\n');

        const result = migrationModule.rewriteRenderScreenTreeWalks(input, 'tree-walk-casted-host-types.test.tsx');

        expect(result.changed).toBe(true);
        expect(result.counts.rootProxyFinds).toBe(3);
        expect(result.text).toContain("import { findAllByType, findFirstByType, renderScreen } from '@/dev/testkit';");
        expect(result.text).toContain("const webHandle = findFirstByType(tree!, 'Pressable');");
        expect(result.text).toContain("expect(findAllByType(tree!, 'Pressable')).toHaveLength(0);");
        expect(result.text).toContain("expect(findAllByType(tree!, 'ViewStub')).toHaveLength(1);");
    });

    it('rewrites variable-bound press handlers onto shared test-instance helpers and updates the import', async () => {
        const migrationModule = await import('./rewrite-render-screen-tree-walks');

        const input = [
            "import { renderScreen } from '@/dev/testkit';",
            "import { act } from 'react-test-renderer';",
            "it('works', async () => {",
            '    const tree = (await renderScreen(<Thing />)).tree;',
            "    const trigger = tree.findByType('Pressable');",
            '    await act(async () => {',
            '        trigger.props.onPress();',
            '    });',
            '    const rows = tree.findAllByType(\'Pressable\');',
            '    await act(async () => {',
            '        await rows[1]!.props.onClick?.();',
            '        await Promise.resolve();',
            '    });',
            '});',
        ].join('\n');

        const result = migrationModule.rewriteRenderScreenTreeWalks(input, 'tree-walk-instance-press.test.tsx');

        expect(result.changed).toBe(true);
        expect(result.counts.pressInstanceAsync).toBe(2);
        expect(result.text).toContain("import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';");
        expect(result.text).toContain("await pressTestInstanceAsync(trigger);");
        expect(result.text).toContain("await pressTestInstanceAsync(rows[1]!);");
    });

    it('rewrites flexible-indent async press handlers and preserves setup lines before the press', async () => {
        const migrationModule = await import('./rewrite-render-screen-tree-walks');

        const input = [
            "import { renderScreen } from '@/dev/testkit';",
            "import { act } from 'react-test-renderer';",
            "it('works', async () => {",
            '    const tree = (await renderScreen(<Thing />)).tree;',
            "    const findingHeader = tree.findAllByType('Pressable').find(Boolean);",
            '    await act(async () => {',
            '      findingHeader!.props.onPress?.();',
            '    });',
            "    const sessionInput = tree.find((node) => String(node.props?.testID) === 'voiceQa.sessionIdInput');",
            "    const startButton = tree.find((node) => String(node.props?.testID) === 'voiceQa.start');",
            '    await act(async () => {',
            "      sessionInput.props.onChangeText('session_latest');",
            '      await startButton.props.onPress();',
            '    });',
            '});',
        ].join('\n');

        const result = migrationModule.rewriteRenderScreenTreeWalks(input, 'tree-walk-flex-indent-instance-press.test.tsx');

        expect(result.changed).toBe(true);
        expect(result.counts.pressInstanceAsync).toBe(2);
        expect(result.text).toContain("import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';");
        expect(result.text).toContain([
            '    await act(async () => {',
            '      await pressTestInstanceAsync(findingHeader!);',
            '    });',
        ].join('\n'));
        expect(result.text).toContain([
            '    await act(async () => {',
            "      sessionInput.props.onChangeText('session_latest');",
            '      await pressTestInstanceAsync(startButton);',
            '    });',
        ].join('\n'));
    });

    it('rewrites sync optional press handlers onto the sync shared helper without bleeding from earlier async blocks', async () => {
        const migrationModule = await import('./rewrite-render-screen-tree-walks');

        const input = [
            "import { renderScreen } from '@/dev/testkit';",
            "import { act } from 'react-test-renderer';",
            "it('works', async () => {",
            '    const tree = (await renderScreen(<Thing />)).tree;',
            "    const rows = tree.findAllByType('Row');",
            '    await act(async () => {',
            "      tree.findByProps({ testID: 'warmup' });",
            '      await Promise.resolve();',
            '    });',
            '    act(() => {',
            '      rows[0]?.props.onPress?.();',
            '    });',
            '});',
        ].join('\n');

        const result = migrationModule.rewriteRenderScreenTreeWalks(input, 'tree-walk-sync-optional-instance-press.test.tsx');

        expect(result.changed).toBe(true);
        expect(result.counts.pressInstance).toBe(1);
        expect(result.counts.pressInstanceAsync).toBe(0);
        expect(result.text).toContain("import { pressTestInstance, renderScreen } from '@/dev/testkit';");
        expect(result.text).toContain([
            '    act(() => {',
            '      pressTestInstance(rows[0]);',
            '    });',
        ].join('\n'));
    });

    it('rewrites variable-bound onPressIn handlers onto the generic instance-handler helper and preserves payload setup', async () => {
        const migrationModule = await import('./rewrite-render-screen-tree-walks');

        const input = [
            "import { renderScreen } from '@/dev/testkit';",
            "import { act } from 'react-test-renderer';",
            "it('works', async () => {",
            '    const tree = (await renderScreen(<Thing />)).tree;',
            "    const webHandle = tree.findByType('Pressable');",
            '    await act(async () => {',
            '        webHandle.props.onPressIn({',
            '            clientX: 320,',
            '            preventDefault: vi.fn(),',
            '            stopPropagation: vi.fn(),',
            '        });',
            '    });',
            '});',
        ].join('\n');

        const result = migrationModule.rewriteRenderScreenTreeWalks(input, 'tree-walk-instance-handler.test.tsx');

        expect(result.changed).toBe(true);
        expect(result.text).toContain("import { invokeTestInstanceHandler, renderScreen } from '@/dev/testkit';");
        expect(result.text).toContain([
            '    await act(async () => {',
            "        invokeTestInstanceHandler(webHandle, 'onPressIn', {",
            '            clientX: 320,',
            '            preventDefault: vi.fn(),',
            '            stopPropagation: vi.fn(),',
            '        });',
            '    });',
        ].join('\n'));
    });

    it('rewrites nested-text pressable lookups and variable-bound input changes onto shared helpers', async () => {
        const migrationModule = await import('./rewrite-render-screen-tree-walks');

        const input = [
            "import { act } from 'react-test-renderer';",
            "import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';",
            "it('works', async () => {",
            '    const tree = (await renderScreen(<Thing />)).tree;',
            "    const clarify = tree!.findAllByType('Pressable').find((p: any) => {",
            "      const texts = p.findAllByType?.('Text') ?? [];",
            "      return texts.some((t: any) => String(t.props.children ?? '').includes('Ask for clarification'));",
            '    });',
            '    const inputs = tree!.findAllByType(\'TextInput\');',
            '    await act(async () => {',
            "      inputs[0]!.props.onChangeText?.('please clarify the impact');",
            '    });',
            '    await act(async () => {',
            '      await pressTestInstanceAsync(clarify!);',
            '    });',
            '});',
        ].join('\n');

        const result = migrationModule.rewriteRenderScreenTreeWalks(input, 'tree-walk-nested-text-selector.test.tsx');

        expect(result.changed).toBe(true);
        expect(result.text).toContain("import { changeTextTestInstance, findTestInstanceByTypeContainingText, pressTestInstanceAsync, renderScreen } from '@/dev/testkit';");
        expect(result.text).toContain("const clarify = findTestInstanceByTypeContainingText(tree!, 'Pressable', 'Ask for clarification');");
        expect(result.text).toContain([
            '    await act(async () => {',
            "      changeTextTestInstance(inputs[0]!, 'please clarify the impact');",
            '    });',
        ].join('\n'));
    });

    it('rewrites findAllByType(...).find(node.props.testID===...) selectors onto findByTestId for later helper reuse', async () => {
        const migrationModule = await import('./rewrite-render-screen-tree-walks');

        const input = [
            "import { act } from 'react-test-renderer';",
            "import { renderScreen } from '@/dev/testkit';",
            "it('works', async () => {",
            '    const tree = (await renderScreen(<Thing />)).tree;',
            "    const searchInput = tree.root.findAllByType('TextInput').find((node) => node.props?.testID === 'promptRegistries.searchQuery');",
            "    const registryItem = tree.root.findAllByType('Item').find((node) => node.props?.testID === 'promptRegistries.item.0');",
            '    await act(async () => {',
            "      searchInput?.props?.onChangeText?.('design');",
            '      registryItem?.props?.onPress?.();',
            '    });',
            '});',
        ].join('\n');

        const result = migrationModule.rewriteRenderScreenTreeWalks(input, 'tree-walk-find-by-testid-from-type.test.tsx');

        expect(result.changed).toBe(true);
        expect(result.text).toContain("const searchInput = tree.findByTestId('promptRegistries.searchQuery');");
        expect(result.text).toContain("const registryItem = tree.findByTestId('promptRegistries.item.0');");
    });

    it('rewrites optional-chain instance handlers after findByTestId lookups onto shared helpers', async () => {
        const migrationModule = await import('./rewrite-render-screen-tree-walks');

        const input = [
            "import { act } from 'react-test-renderer';",
            "import { renderScreen } from '@/dev/testkit';",
            "it('works', async () => {",
            '    const tree = (await renderScreen(<Thing />)).tree;',
            "    const searchInput = tree.findByTestId('promptRegistries.searchQuery');",
            "    const registryItem = tree.findByTestId('promptRegistries.item.0');",
            '    await act(async () => {',
            "      searchInput?.props?.onChangeText?.('design');",
            '    });',
            '    await act(async () => {',
            '      await registryItem?.props?.onPress?.();',
            '    });',
            '});',
        ].join('\n');

        const result = migrationModule.rewriteRenderScreenTreeWalks(input, 'tree-walk-optional-instance-from-testid.test.tsx');

        expect(result.changed).toBe(true);
        expect(result.text).toContain("import { changeTextTestInstance, pressTestInstanceAsync, renderScreen } from '@/dev/testkit';");
        expect(result.text).toContain([
            '    await act(async () => {',
            "      changeTextTestInstance(searchInput, 'design');",
            '    });',
        ].join('\n'));
        expect(result.text).toContain([
            '    await act(async () => {',
            '      await pressTestInstanceAsync(registryItem);',
            '    });',
        ].join('\n'));
    });

    it('drops a dangling optional marker from direct instance press rewrites before calling the shared helper', async () => {
        const migrationModule = await import('./rewrite-render-screen-tree-walks');

        const input = [
            "import { act } from 'react-test-renderer';",
            "import { renderScreen } from '@/dev/testkit';",
            "it('works', async () => {",
            '    const tree = (await renderScreen(<Thing />)).tree;',
            "    const expandAddServer = tree.findByType('Item' as any);",
            '    await act(async () => {',
            '        await expandAddServer?.props.onPress?.();',
            '    });',
            '});',
        ].join('\n');

        const result = migrationModule.rewriteRenderScreenTreeWalks(input, 'tree-walk-optional-direct-instance-press.test.tsx');

        expect(result.changed).toBe(true);
        expect(result.text).toContain("import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';");
        expect(result.text).toContain([
            '    await act(async () => {',
            '        await pressTestInstanceAsync(expandAddServer);',
            '    });',
        ].join('\n'));
    });
});
