import * as React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        View: 'View',
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
            colors: {
                text: '#111',
                textSecondary: '#666',
            },
        },
    });
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/components/ui/media/FileIcon', () => ({
    FileIcon: 'FileIcon',
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
}));

vi.mock('@/constants/Typography', () => ({
    Typography: {
        default: () => ({}),
    },
}));

function flattenStyle(style: unknown): Record<string, unknown> {
    if (!style) return {};
    if (Array.isArray(style)) {
        return style.reduce((acc, entry) => Object.assign(acc, flattenStyle(entry)), {} as Record<string, unknown>);
    }
    if (typeof style === 'object') {
        return style as Record<string, unknown>;
    }
    return {};
}

describe('FileMentionSuggestion', () => {
    it('right-aligns the directory segment against the file name and uses web start ellipsis', async () => {
        const { FileMentionSuggestion } = await import('./AgentInputSuggestionView');

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(
            <FileMentionSuggestion
                fileName="jsonlForwardReader.ts"
                filePath="apps/cli/src/api/session/external/filePaging"
            />,
        )).tree;

        const textNodes = tree!.findAllByType('Text' as any);
        const pathWrapper = textNodes.find((node) => flattenStyle(node.props.style).writingDirection === 'rtl')!;
        const pathContent = textNodes.find((node) => node.props.children === 'apps/cli/src/api/session/external/filePaging/')!;

        expect(pathWrapper).toBeTruthy();
        expect(pathContent).toBeTruthy();
        expect(pathWrapper.props.ellipsizeMode).toBeUndefined();
        expect(flattenStyle(pathWrapper.props.style).textAlign).toBe('right');
        expect(flattenStyle(pathContent.props.style)).toMatchObject({
            writingDirection: 'ltr',
            unicodeBidi: 'isolate',
        });
    });
});
