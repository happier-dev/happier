import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installFilesContentCommonModuleMocks } from '@/components/workspaces/scm/review/filesContentTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const flashListState = vi.hoisted(() => ({
    props: null as Record<string, unknown> | null,
}));

installFilesContentCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'ios',
                select: <T,>(options: { ios?: T; native?: T; default?: T; web?: T; android?: T }) =>
                    options.ios ?? options.native ?? options.default ?? options.web ?? options.android,
            },
            TurboModuleRegistry: {
                get: () => ({}),
            },
        });
    },
});

vi.mock('@/components/ui/lists/flashListCompat/FlashListCompat', async () => {
    const ReactModule = await import('react');
    return {
        FlashList: ReactModule.forwardRef((props: Record<string, unknown>, _ref) => {
            flashListState.props = props;
            return ReactModule.createElement('FlashList');
        }),
    };
});

vi.mock('@expo/vector-icons', () => ({
    Octicons: 'Octicons',
    Ionicons: 'Ionicons',
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
    TextInput: 'TextInput',
}));

vi.mock('@/components/ui/media/FileIcon', () => ({
    FileIcon: 'FileIcon',
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: 'Item',
}));

vi.mock('@/constants/Typography', () => ({
    Typography: {
        default: () => ({}),
    },
}));

describe('SearchResultsList native virtualization', () => {
    it('uses compact FlashList windows on native for large file-search result sets', async () => {
        const { SearchResultsList } = await import('./SearchResultsList');
        const searchResults = Array.from({ length: 40 }, (_, index) => ({
            fileType: 'file',
            fileName: `file-${index}.ts`,
            filePath: 'src/',
            fullPath: `src/file-${index}.ts`,
        }));

        await renderScreen(
            <SearchResultsList
                theme={{
                    colors: {
                        border: { default: '#ddd' },
                        surface: { inset: '#eee' },
                        text: { link: '#09f', primary: '#111', secondary: '#999' },
                    },
                } as any}
                isSearching={false}
                searchQuery="session"
                searchResults={searchResults as any}
                onFilePress={vi.fn()}
            />,
        );

        expect(flashListState.props?.data).toHaveLength(40);
        expect(flashListState.props?.estimatedItemSize).toBeGreaterThan(0);
        expect(flashListState.props?.initialNumToRender).toBe(12);
        expect(flashListState.props?.maxToRenderPerBatch).toBe(12);
    });
});
