import React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installMediaCommonModuleMocks } from './mediaTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installMediaCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: ({ children, ...props }: any) => React.createElement('View', props, children),
        });
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
            theme: { colors: { text: '#111' } },
        });
    },
});

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
        tree = (await renderScreen(<SimpleSyntaxHighlighter code={'const x = 1'} language={'typescript'} selectable={true} />)).tree;

        const view = tree.findByType('View');
        expect(view.props.style).toEqual(expect.objectContaining({ flexShrink: 0 }));

        const texts = tree.findAllByType('Text');
        const outerText = texts[0];
        const outerStyle = Array.isArray(outerText.props.style) ? Object.assign({}, ...outerText.props.style) : outerText.props.style;
        expect(outerStyle).toEqual(expect.objectContaining({ flexShrink: 0 }));
        expect(outerStyle).toEqual(expect.objectContaining({ whiteSpace: 'pre' }));
        expect(outerStyle).toEqual(expect.objectContaining({ display: 'inline-block' }));
    });

    it('wraps long lines when the wrap variant is requested (spec §2 / F-W13-1)', async () => {
        const { SimpleSyntaxHighlighter } = await import('./SimpleSyntaxHighlighter');

        const tree = (await renderScreen(
            <SimpleSyntaxHighlighter code={'curl -fsSL https://happier.dev/install | bash'} language={'bash'} selectable={true} wrap />,
        )).tree;

        const view = tree.findByType('View');
        expect(view.props.style).not.toEqual(expect.objectContaining({ flexShrink: 0 }));

        const texts = tree.findAllByType('Text');
        const outerText = texts[0];
        const outerStyle = Array.isArray(outerText.props.style) ? Object.assign({}, ...outerText.props.style) : outerText.props.style;
        expect(outerStyle).toEqual(expect.objectContaining({ whiteSpace: 'pre-wrap' }));
        expect(outerStyle).toEqual(expect.objectContaining({ wordBreak: 'break-word' }));
        expect(outerStyle).not.toEqual(expect.objectContaining({ flexShrink: 0 }));
    });
});
