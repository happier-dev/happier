import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installCodeBlockCommonModuleMocks } from './codeBlockTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const syntaxSpy = vi.fn((..._args: any[]) => ({
    mode: 'simple',
    language: 'typescript',
    maxBytes: 1_000,
    maxLines: 1_000,
    maxLineLength: 1_000,
}));

vi.mock('@/components/ui/code/highlighting/useCodeSyntaxHighlighting', () => ({
    useCodeSyntaxHighlighting: (...args: any[]) => syntaxSpy(...args),
}));

const simpleSpy = vi.fn();
vi.mock('@/components/ui/media/SimpleSyntaxHighlighter', () => ({
    SimpleSyntaxHighlighter: (props: any) => {
        simpleSpy(props);
        return React.createElement('SimpleSyntaxHighlighter', props);
    },
}));

vi.mock('@/components/ui/code/blocks/CodeBlockViewFrame', () => ({
    CodeBlockViewFrame: ({ children, ...props }: any) => React.createElement('CodeBlockViewFrame', props, children),
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: ({ children, ...props }: any) => React.createElement('Text', props, children),
}));

vi.mock('@/constants/Typography', () => ({
    Typography: {
        mono: () => ({ fontFamily: 'mono' }),
    },
}));

installCodeBlockCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: (props: any) => React.createElement('View', props, props.children),
            Text: (props: any) => React.createElement('Text', props, props.children),
            Pressable: (props: any) => React.createElement('Pressable', props, props.children),
        });
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
            theme: { colors: { text: '#111' } },
        });
    },
});

describe('CodeBlockView (native)', () => {
    it('renders SimpleSyntaxHighlighter when within budget and enabled', async () => {
        syntaxSpy.mockImplementation(() => ({
            mode: 'simple',
            language: 'typescript',
            maxBytes: 100,
            maxLines: 100,
            maxLineLength: 100,
        }));
        simpleSpy.mockClear();

        const { CodeBlockView } = await import('./CodeBlockView');

        const screen = await renderScreen(React.createElement(CodeBlockView, { code: 'const x = 1;', language: 'typescript' }));

        expect(simpleSpy).toHaveBeenCalledTimes(1);
        expect(screen.findAllByType('SimpleSyntaxHighlighter' as any)).toHaveLength(1);
    });

    it('falls back to plain Text when code exceeds the byte budget', async () => {
        syntaxSpy.mockImplementation(() => ({
            mode: 'simple',
            language: 'typescript',
            maxBytes: 5,
            maxLines: 100,
            maxLineLength: 100,
        }));
        simpleSpy.mockClear();

        const { CodeBlockView } = await import('./CodeBlockView');

        const screen = await renderScreen(React.createElement(CodeBlockView, { code: 'const x = 1;', language: 'typescript' }));

        expect(simpleSpy).toHaveBeenCalledTimes(0);
        const textNodes = screen.findAllByType('Text' as any);
        expect(textNodes.some((n) => n.props.children === 'const x = 1;')).toBe(true);
    });

    it('forwards scrollTestID to CodeBlockViewFrame (stable E2E locator)', async () => {
        const { CodeBlockView } = await import('./CodeBlockView');

        const screen = await renderScreen(
            React.createElement(CodeBlockView, {
                code: 'const x = 1;',
                language: 'typescript',
                scrollTestID: 'markdown-code-block-scroll',
            }),
        );

        const frames = screen.findAllByType('CodeBlockViewFrame' as any);
        expect(frames).toHaveLength(1);
        expect(frames[0]!.props.scrollTestID).toBe('markdown-code-block-scroll');
    });
});
