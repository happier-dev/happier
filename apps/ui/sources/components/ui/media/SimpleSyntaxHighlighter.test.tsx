import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
    View: ({ children, ...props }: any) => React.createElement('View', props, children),
    Platform: { OS: 'web' },
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({ theme: { colors: { text: '#111' } } }),
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: ({ children, ...props }: any) => React.createElement('Text', props, children),
}));

vi.mock('@/components/ui/code/tokenization/simpleSyntaxTokenizer', () => ({
    tokenizeSimpleSyntaxText: () => [
        { type: 'keyword', text: 'const' },
        { type: 'default', text: ' x = 1' },
    ],
}));

describe('SimpleSyntaxHighlighter', () => {
    it('does not shrink/wrap inside horizontal scroll containers', async () => {
        const { SimpleSyntaxHighlighter } = await import('./SimpleSyntaxHighlighter');

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <SimpleSyntaxHighlighter code={'const x = 1'} language={'typescript'} selectable={true} />,
            );
        });

        const view = tree.root.findByType('View');
        expect(view.props.style).toEqual(expect.objectContaining({ flexShrink: 0 }));

        const texts = tree.root.findAllByType('Text');
        const outerText = texts[0];
        const outerStyle = Array.isArray(outerText.props.style) ? Object.assign({}, ...outerText.props.style) : outerText.props.style;
        expect(outerStyle).toEqual(expect.objectContaining({ flexShrink: 0 }));
    });
});
