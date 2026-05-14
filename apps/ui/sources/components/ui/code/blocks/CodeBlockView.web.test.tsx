import React from 'react';
import type { ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { flushHookEffects, renderScreen } from '@/dev/testkit';
import { installCodeBlockCommonModuleMocks } from './codeBlockTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

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
            theme: {
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
            },
        });
    },
});

vi.mock('expo-clipboard', () => ({
    setStringAsync: vi.fn(async () => {}),
}));

const featureSpy = vi.fn((id: string) => (id === 'files.diffSyntaxHighlighting' || id === 'files.syntaxHighlighting.advanced'));
vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (id: string) => featureSpy(id),
}));

const settingSpy = vi.fn((key: string): 'advanced' | 'off' | number | null => {
    if (key === 'filesDiffSyntaxHighlightingMode') return 'advanced';
    if (key === 'filesDiffTokenizationMaxBytes') return 1_000_000;
    if (key === 'filesDiffTokenizationMaxLines') return 10_000;
    if (key === 'filesDiffTokenizationMaxLineLength') return 10_000;
    return null;
});
vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
    useSetting: (key: string) => settingSpy(key),
});
});

vi.mock('@/sync/store/hooks', () => ({
    useLocalSetting: () => 1,
}));

const createHighlighterSpy = vi.fn(async (..._args: any[]) => ({
    loadLanguage: async () => {},
    codeToTokens: () => ({
        fg: '#000',
        tokens: [
            [{ content: 'const', color: '#f00' }, { content: ' x = 1;', color: '#000' }],
        ],
    }),
}));

vi.mock('shiki', () => ({
    bundledLanguages: { ts: {}, js: {}, python: {} },
    createHighlighter: (...args: any[]) => createHighlighterSpy(...args),
}));

async function flushReactAsyncWork(): Promise<void> {
    await flushHookEffects({ cycles: 10, turns: 25 });
}

describe('CodeBlockView (web)', () => {
    it('uses Shiki tokens when advanced highlighting is enabled', async () => {
        featureSpy.mockClear();
        settingSpy.mockClear();
        createHighlighterSpy.mockClear();

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

    it('does not invoke Shiki when highlighting is off', async () => {
        settingSpy.mockImplementation((key: string) => {
            if (key === 'filesDiffSyntaxHighlightingMode') return 'off';
            if (key === 'filesDiffTokenizationMaxBytes') return 1_000_000;
            if (key === 'filesDiffTokenizationMaxLines') return 10_000;
            if (key === 'filesDiffTokenizationMaxLineLength') return 10_000;
            return null;
        });
        createHighlighterSpy.mockClear();

        const { CodeBlockView } = await import('./CodeBlockView.web');

        let tree!: ReactTestRenderer;
        tree = (await renderScreen(<CodeBlockView
                    code={'const x = 1;'}
                    language={'typescript'}
                    showCopyButton={false}
                    wrap={true}
                />)).tree;
        await flushReactAsyncWork();

        expect(createHighlighterSpy).toHaveBeenCalledTimes(0);
        expect(JSON.stringify(tree.toJSON())).toContain('const x = 1;');
    });
});
