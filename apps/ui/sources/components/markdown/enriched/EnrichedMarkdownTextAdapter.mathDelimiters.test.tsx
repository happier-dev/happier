import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({});
});

vi.mock('react-native-enriched-markdown', () => ({
    preloadMarkdownRuntime: () => Promise.resolve(),
    EnrichedMarkdownText: (props: Readonly<{ markdown: string }>) => (
        React.createElement('EnrichedMarkdownText', props)
    ),
}));

describe('EnrichedMarkdownTextAdapter math delimiters', () => {
    it('normalizes Codex-style delimiters at the renderer boundary', async () => {
        const { EnrichedMarkdownTextAdapter } = await import('./EnrichedMarkdownTextAdapter');
        const markdown = [
            'Inline \\(x_i\\).',
            '',
            '\\[',
            'y = \\frac{1}{2}',
            '\\]',
            '',
            'Code: `\\(z\\)`.',
        ].join('\n');

        let tree!: TestRenderer.ReactTestRenderer;
        await act(async () => {
            tree = TestRenderer.create(
                <EnrichedMarkdownTextAdapter
                    markdown={markdown}
                    profile="transcript"
                    selectable
                    streamingAnimated={false}
                />,
            );
            await Promise.resolve();
        });

        expect(tree.root.findByType('EnrichedMarkdownText').props.markdown).toBe([
            'Inline $x_i$.',
            '',
            '$$',
            'y = \\frac{1}{2}',
            '$$',
            '',
            'Code: `\\(z\\)`.',
        ].join('\n'));

        act(() => {
            tree.unmount();
        });
    });

    it('preserves table-cell text alignment for inline and display math', async () => {
        const { EnrichedMarkdownTextAdapter } = await import('./EnrichedMarkdownTextAdapter');

        let tree!: TestRenderer.ReactTestRenderer;
        await act(async () => {
            tree = TestRenderer.create(
                <EnrichedMarkdownTextAdapter
                    markdown="\\(x_i\\)"
                    profile="transcript"
                    selectable
                    textStyle={{ textAlign: 'right' }}
                    streamingAnimated={false}
                    fillContainer={false}
                />,
            );
            await Promise.resolve();
        });

        const renderedProps = tree.root.findByType('EnrichedMarkdownText').props;
        expect(renderedProps.markdownStyle.paragraph.textAlign).toBe('right');
        expect(renderedProps.markdownStyle.math.textAlign).toBe('right');
        expect(renderedProps.containerStyle.width).toBeUndefined();

        act(() => {
            tree.unmount();
        });
    });
});
