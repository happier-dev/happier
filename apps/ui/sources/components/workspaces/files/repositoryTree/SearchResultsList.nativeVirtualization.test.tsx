import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installFilesContentCommonModuleMocks } from '@/components/workspaces/scm/review/filesContentTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const legendListState = vi.hoisted(() => ({
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

vi.mock('@legendapp/list/react-native', async () => {
    const ReactModule = await import('react');
    return {
        LegendList: ReactModule.forwardRef((props: Record<string, unknown>, _ref) => {
            legendListState.props = props;
            return ReactModule.createElement('LegendList');
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

describe('SearchResultsList native virtualization', () => {
    it('keeps native search results in the virtualized list during refinement', async () => {
        const { SearchResultsList } = await import('./SearchResultsList');
        const searchResults = Array.from({ length: 40 }, (_, index) => ({
            fileType: 'file',
            fileName: `file-${index}.ts`,
            filePath: 'src/',
            fullPath: `src/file-${index}.ts`,
        }));

        const element = <SearchResultsList
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
            />;
        const screen = await renderScreen(element);

        expect(legendListState.props?.data).toHaveLength(40);
        expect(legendListState.props?.estimatedItemSize).toBeGreaterThan(0);
        await screen.update(React.cloneElement(element, { isSearching: true, searchQuery: 'session.ts' }));
        expect(legendListState.props?.data).toBe(searchResults);
    });
});
