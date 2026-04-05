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

vi.mock('react-native-unistyles', () => ({
    StyleSheet: {
        create: (factory: any) => factory({
            colors: {
                text: '#111',
                textSecondary: '#666',
            },
        }),
    },
}));

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

describe('FileMentionSuggestion', () => {
    it('right-aligns the directory segment against the file name and truncates it from the head', async () => {
        const { FileMentionSuggestion } = await import('./AgentInputSuggestionView');

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(
            <FileMentionSuggestion
                fileName="jsonlForwardReader.ts"
                filePath="apps/cli/src/api/directSessions/filePaging"
            />
        )).tree;

        const pathText = tree!.findAllByType('Text' as any).find((node) => node.props.children === 'apps/cli/src/api/directSessions/filePaging/')!;
        expect(pathText.props.ellipsizeMode).toBe('head');
        expect(pathText.props.style.textAlign).toBe('right');
    });
});
