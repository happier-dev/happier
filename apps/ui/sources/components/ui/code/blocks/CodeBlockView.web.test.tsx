import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createThemeFixture, flushHookEffects, renderScreen } from '@/dev/testkit';
import { installCodeBlockCommonModuleMocks } from './codeBlockTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const themeOverrides = {
    dark: false,
    colors: {
        border: { default: '#ddd' },
        surface: { base: '#fff', inset: '#fff' },
        text: { primary: '#111', secondary: '#666' },
        syntax: {
            default: '#111',
            keyword: '#123456',
            string: '#0a3069',
            comment: '#666',
            number: '#0550ae',
            function: '#8250df',
        },
    },
};

installCodeBlockCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: ({ children, ...props }: any) => React.createElement('View', props, children),
            Text: ({ children, ...props }: any) => React.createElement('Text', props, children),
            Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
            ScrollView: ({ children, ...props }: any) => React.createElement('ScrollView', props, children),
            Platform: {
                OS: 'web',
                select: (options: any) => options?.web ?? options?.default ?? options?.ios ?? options?.android,
            },
            AppState: {
                addEventListener: () => ({ remove: () => {} }),
            },
        });
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock().module;
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key: string) => key });
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
            theme: themeOverrides,
        });
    },
});

vi.mock('expo-clipboard', () => ({
    setStringAsync: vi.fn(async () => {}),
}));

// Storage's consumer graph reaches the native/theme boundary; install it before loading that graph.
const { storage } = await import('@/sync/domains/state/storage');
const initialSettings = storage.getState().settings;
beforeEach(() => storage.setState({ settings: { ...initialSettings, experiments: true,
    featureToggles: { ...initialSettings.featureToggles, 'files.diffSyntaxHighlighting': true,
        'files.syntaxHighlighting.advanced': true },
    filesDiffSyntaxHighlightingMode: 'advanced', filesDiffTokenizationMaxBytes: 1_000_000,
    filesDiffTokenizationMaxLines: 10_000, filesDiffTokenizationMaxLineLength: 10_000 } }));
afterEach(() => storage.setState({ settings: initialSettings }));

const createHighlighterSpy = vi.fn(async (..._args: any[]) => ({
    loadLanguage: async () => {},
    codeToTokens: (code: string) => ({
        fg: '#000',
        tokens: code.split('\n').map(line => line.startsWith('const')
            ? [{ content: 'const', color: '#f00' }, { content: line.slice(5), color: '#000' }]
            : [{ content: line.slice(0, 12), color: '#666' }, { content: line.slice(12), color: '#666' }]),
    }),
}));

// Shiki is the external syntax engine. The tokenizer builds its highlighter through `shiki/core`.
vi.mock('shiki/core', () => ({
    createBundledHighlighter: () => (...args: any[]) => createHighlighterSpy(...args),
}));
// The generated grammar inventory references packaged `.json.bundle` assets, which only a bundler can load; the
// faked engine above takes no grammars.
vi.mock('@/components/ui/code/highlighting/shiki/generatedShikiGrammarAssets', () => ({ SHIKI_LANGUAGE_ASSETS: {} }));

async function flushReactAsyncWork(): Promise<void> {
    await flushHookEffects({ cycles: 10, turns: 25 });
}

describe('CodeBlockView (web)', () => {
    it.each(['off', 'simple', 'advanced'] as const)('keeps Read and diff code marks through the web %s renderer', async (mode) => {
        storage.setState({ settings: { ...storage.getState().settings, filesDiffSyntaxHighlightingMode: mode } });
        // Shiki is the external syntax engine; retain every source line and split the matched
        // phrase across token boundaries, as its real output does.
        const code = Array.from({ length: 15 }, (_, index) => index === 14
            ? '// must not remount the modal' : `const line${index + 1} = ${index + 1};`).join('\r\n');
        const text = 'must not remount the modal';
        const start = code.indexOf(text);
        const { CodeBlockView } = await import('./CodeBlockView.web');
        const screen = await renderScreen(<CodeBlockView code={code} language="typescript"
            findRanges={[{ start, end: start + text.length, current: true }]} />);
        await flushReactAsyncWork();
        const marked = () => screen.findAllHostsByTestId('find-match-current').map(node => node.children.join('')).join('');
        expect(marked()).toBe(text);
        await screen.update(<CodeBlockView code={code} language="typescript"
            findRanges={[{ start, end: start + text.length, current: false }]} />);
        expect(marked()).toBe('');
        expect(screen.findAllHostsByTestId('find-match-all').map(node => node.children.join('')).join('')).toBe(text);
        await screen.update(<CodeBlockView code={code} language="typescript" />);
        expect(screen.findAllHostsByTestId('find-match-all')).toHaveLength(0);
        await screen.unmount();
    });
    it('applies an owner-scoped container surface', async () => {
        const { CodeBlockView } = await import('./CodeBlockView.web');

        const screen = await renderScreen(
            <CodeBlockView
                code="happier setup"
                containerStyle={{ backgroundColor: '#abcdef' }}
            />,
        );

        expect(JSON.stringify(screen.tree.toJSON())).toContain('#abcdef');
    });

    it('uses Shiki tokens when advanced highlighting is enabled', async () => {
        // Earlier mark cases populate the real cache, while Vitest clears SDK spy history.
        // Evict that theme through its existing owner before asserting engine initialization.
        const { clearShikiCacheForKey, resolveHappierShikiThemeId } = await import('../highlighting/shiki/shikiTokenize');
        clearShikiCacheForKey(resolveHappierShikiThemeId({
            isDark: false,
            colors: createThemeFixture(themeOverrides).colors,
        }));

        const { CodeBlockView } = await import('./CodeBlockView.web');

        const screen = await renderScreen(<CodeBlockView
                    code={'const x = 1;'}
                    language={'typescript'}
                    showCopyButton={false}
                    wrap={true}
                />);
        const tree = screen.tree;
        let hasRed = false;
        for (let i = 0; i < 10; i++) {
            // eslint-disable-next-line no-await-in-loop
            await flushReactAsyncWork();
            const redNodes = screen.findAllByType('Text').filter((n) => {
                if ((n as any).type !== 'Text') return false;
                const style = n.props?.style;
                const flattened = Array.isArray(style) ? style.flat() : [style];
                return flattened.some((s: any) => s?.color === '#f00');
            });
            if (redNodes.length > 0) {
                hasRed = true;
                break;
            }
        }

        expect(createHighlighterSpy.mock.calls[0]?.[0]?.themes?.[0]?.name).toMatch(/^happier-light-/);
        expect(hasRed).toBe(true);
        expect(JSON.stringify(tree.toJSON())).toContain('const');
    });

    it('mounts a block with its tokens once the highlighter is ready, without a plain first pass', async () => {
        // A Session switch or a recycled transcript row mounts code blocks whose language is already loaded:
        // they draw their colors in the commit that mounts them instead of mounting plain text and redrawing.
        const { CodeBlockView } = await import('./CodeBlockView.web');
        const warm = await renderScreen(<CodeBlockView code={'const warm = 1;'} language={'typescript'} showCopyButton={false} />);
        await flushReactAsyncWork();
        await warm.unmount();

        const commits: string[] = [];
        const screen = await renderScreen(<React.Profiler id="block" onRender={(_id, phase) => { commits.push(phase); }}>
            <CodeBlockView code={'const fresh = 2;'} language={'typescript'} showCopyButton={false} />
        </React.Profiler>);
        await flushReactAsyncWork();
        const red = screen.findAllByType('Text').filter((n) => {
            const style = n.props?.style;
            return (Array.isArray(style) ? style.flat() : [style]).some((s: any) => s?.color === '#f00');
        });
        expect(red.length).toBeGreaterThan(0);
        expect(commits).toEqual(['mount']);
        await screen.unmount();
    });

    it('mounts each Shiki token as an inherited span, not another app text component', async () => {
        // The block's one app Text owns typography, scaling and selectability; a token only paints its color.
        const { CodeBlockView } = await import('./CodeBlockView.web');
        const code = Array.from({ length: 6 }, (_, index) => `const line${index} = ${index};`).join('\n');
        const screen = await renderScreen(<CodeBlockView code={code} language={'typescript'} showHeaderRow={false} />);
        await flushReactAsyncWork();
        const tokens = screen.findAllByType('Text').filter((n) => (Array.isArray(n.props?.style) ? n.props.style.flat() : [n.props?.style])
            .some((s: any) => s?.color === '#f00'));
        expect(tokens).toHaveLength(6);
        expect(tokens.every((token) => token.props.selectable === undefined)).toBe(true);
        expect(screen.tree.root.findAll((n) => (n.type as { render?: { name?: string } } | null)?.render?.name === 'AppText')).toHaveLength(1);
        await screen.unmount();
    });

    it('does not invoke Shiki when highlighting is off', async () => {
        storage.setState({ settings: { ...storage.getState().settings, filesDiffSyntaxHighlightingMode: 'off' } });
        createHighlighterSpy.mockClear();

        const { CodeBlockView } = await import('./CodeBlockView.web');

        const screen = await renderScreen(<CodeBlockView
                    code={'const x = 1;'}
                    language={'typescript'}
                    showCopyButton={false}
                    wrap={true}
                />);
        await flushReactAsyncWork();

        expect(createHighlighterSpy).toHaveBeenCalledTimes(0);
        expect(screen.getTextContent()).toContain('const x = 1;');
    });
    it('wraps a plain command only between its words, so a flag never splits across lines', async () => {
        storage.setState({ settings: { ...storage.getState().settings, filesDiffSyntaxHighlightingMode: 'off' } });
        const { CodeBlockView } = await import('./CodeBlockView.web');

        const screen = await renderScreen(<CodeBlockView code={'$ python3 -u --bind 127.0.0.1'} showHeaderRow={false} wrap />);
        await flushReactAsyncWork();

        const unit = screen.findAllByType('Text').find((node) => node.props.children === '--bind');
        expect(unit).toBeDefined();
        const style = ([] as any[]).concat(unit!.props.style).flat();
        expect(style.some((entry: any) => entry?.display === 'inline-block')).toBe(true);
        expect(JSON.stringify(screen.tree.toJSON())).toContain('127.0.0.1');
        // Each word is a span of the block's one app Text, not an app text component per word.
        expect(screen.tree.root.findAll((n) => (n.type as { render?: { name?: string } } | null)?.render?.name === 'AppText')).toHaveLength(1);
    });
});
