import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

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

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({ theme: { colors: { text: '#111' } } }),
}));

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

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(CodeBlockView, { code: 'const x = 1;', language: 'typescript' }));
        });

        expect(simpleSpy).toHaveBeenCalledTimes(1);
        expect(tree.root.findAllByType('SimpleSyntaxHighlighter' as any).length).toBe(1);
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

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(CodeBlockView, { code: 'const x = 1;', language: 'typescript' }));
        });

        expect(simpleSpy).toHaveBeenCalledTimes(0);
        const textNodes = tree.root.findAllByType('Text' as any);
        expect(textNodes.some((n) => n.props.children === 'const x = 1;')).toBe(true);
    });
});
