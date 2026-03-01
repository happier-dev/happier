import React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
    View: ({ children, ...props }: any) => React.createElement('View', props, children),
    Text: ({ children, ...props }: any) => React.createElement('Text', props, children),
    Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
    ScrollView: ({ children, ...props }: any) => React.createElement('ScrollView', props, children),
    Platform: {
        OS: 'web',
        select: (options: any) => options?.web ?? options?.default ?? options?.ios ?? options?.android,
    },
    AppState: { addEventListener: () => ({ remove: () => {} }) },
}));

vi.mock('expo-clipboard', () => ({
    setStringAsync: vi.fn(async () => {}),
}));

vi.mock('@/modal', () => ({
    Modal: { alert: vi.fn() },
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({ theme: { dark: false, colors: { text: '#111', divider: '#ddd', surfaceHigh: '#fff', textSecondary: '#666' } } }),
    StyleSheet: { create: (v: any) => (typeof v === 'function' ? v() : v) },
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
vi.mock('@/sync/domains/state/storage', () => ({
    useSetting: (key: string) => settingSpy(key),
}));

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

async function flushMicrotasks(): Promise<void> {
    for (let i = 0; i < 25; i++) {
        // eslint-disable-next-line no-await-in-loop
        await Promise.resolve();
    }
}

async function flushReactAsyncWork(): Promise<void> {
    for (let i = 0; i < 10; i++) {
        // eslint-disable-next-line no-await-in-loop
        await renderer.act(async () => {
            await flushMicrotasks();
        });
    }
}

describe('CodeBlockView (web)', () => {
    it('uses Shiki tokens when advanced highlighting is enabled', async () => {
        featureSpy.mockClear();
        settingSpy.mockClear();
        createHighlighterSpy.mockClear();

        const { CodeBlockView } = await import('./CodeBlockView.web');

        let tree!: renderer.ReactTestRenderer;
        renderer.act(() => {
            tree = renderer.create(
                <CodeBlockView
                    code={'const x = 1;'}
                    language={'typescript'}
                    showCopyButton={false}
                    wrap={true}
                />,
            );
        });
        let hasRed = false;
        for (let i = 0; i < 10; i++) {
            // eslint-disable-next-line no-await-in-loop
            await flushReactAsyncWork();
            const redNodes = tree.root.findAll((n) => {
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

        expect(createHighlighterSpy.mock.calls[0]?.[0]?.themes?.[0]?.name).toBe('happier-light');
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

        let tree!: renderer.ReactTestRenderer;
        renderer.act(() => {
            tree = renderer.create(
                <CodeBlockView
                    code={'const x = 1;'}
                    language={'typescript'}
                    showCopyButton={false}
                    wrap={true}
                />,
            );
        });
        await flushReactAsyncWork();

        expect(createHighlighterSpy).toHaveBeenCalledTimes(0);
        expect(JSON.stringify(tree.toJSON())).toContain('const x = 1;');
    });
});
