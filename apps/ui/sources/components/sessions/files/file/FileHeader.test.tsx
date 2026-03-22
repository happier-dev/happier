import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { View as RNView } from 'react-native';
import { renderScreen } from '@/dev/testkit';


// Required for React 18+ act() semantics with react-test-renderer.
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                                    Platform: {
                                        select: ({ default: value }: { default: number }) => value,
                                    },
                                    View: 'View',
                                }
    );
});

vi.mock('@/components/ui/media/FileIcon', () => ({
    FileIcon: 'FileIcon',
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
    TextInput: 'TextInput',
}));

vi.mock('@/constants/Typography', () => ({
    Typography: {
        mono: () => ({}),
    },
}));

describe('FileHeader', () => {
    const theme = {
        colors: {
            divider: '#ddd',
            surfaceHigh: '#fff',
            textSecondary: '#444',
        },
    };

    it('falls back to fileName when filePathDir is empty', async () => {
        const { FileHeader } = await import('./FileHeader');

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<FileHeader
                    theme={theme as any}
                    fileName="README.md"
                    filePathDir=""
                />)).tree;

        const texts = tree!.findAllByType('Text' as any);
        expect(texts.some((node) => node.props.children === 'README.md')).toBe(true);
    });

    it('uses filePathDir when it is available', async () => {
        const { FileHeader } = await import('./FileHeader');

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<FileHeader
                    theme={theme as any}
                    fileName="index.ts"
                    filePathDir="src/utils/"
                />)).tree;

        const texts = tree!.findAllByType('Text' as any);
        expect(texts.some((node) => node.props.children === 'src/utils/')).toBe(true);
    });

    it('renders a rightElement when provided', async () => {
        const { FileHeader } = await import('./FileHeader');

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<FileHeader
                    theme={theme as any}
                    fileName="README.md"
                    filePathDir=""
                    rightElement={<RNView testID="right-child" />}
                />)).tree;

        expect(tree!.findByProps({ testID: 'file-header-right' })).toBeDefined();
        expect(tree!.findByProps({ testID: 'right-child' })).toBeDefined();
    });
});
