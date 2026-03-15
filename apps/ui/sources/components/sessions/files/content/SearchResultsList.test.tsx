import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const stub = await import('@/dev/reactNativeStub');
    return {
        ...stub,
        Platform: { ...stub.Platform, OS: 'web' },
        TurboModuleRegistry: { ...stub.TurboModuleRegistry, get: () => ({}) },
        FlatList: ({ data, renderItem, keyExtractor, ListHeaderComponent }: any) => {
            const header = ListHeaderComponent
                ? (React.isValidElement(ListHeaderComponent) ? ListHeaderComponent : React.createElement(ListHeaderComponent))
                : null;
            const items = (data ?? []).map((item: any, index: number) => {
                const key = keyExtractor ? keyExtractor(item, index) : String(item?.fullPath ?? index);
                return React.createElement(React.Fragment, { key }, renderItem({ item, index }));
            });
            return React.createElement('FlatList', null, header, ...items);
        },
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

vi.mock('@/constants/Typography', () => ({
    Typography: {
        default: () => ({}),
    },
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: 'Item',
}));

describe('SearchResultsList', () => {
    it('does not render string children under View when searchQuery is empty', async () => {
        const { SearchResultsList } = await import('./SearchResultsList');

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(
                <SearchResultsList
                    theme={{ colors: { textSecondary: '#999', text: '#111', surfaceHigh: '#eee', divider: '#ddd', textLink: '#09f' } } as any}
                    isSearching={false}
                    searchQuery=""
                    searchResults={[]}
                    onFilePress={vi.fn()}
                />
            );
        });

        const rootView = tree!.root.findByType('View' as any);
        const children = React.Children.toArray(rootView.props.children ?? []);
        const hasPrimitiveChild = children.some((c) => typeof c === 'string' || typeof c === 'number');
        expect(hasPrimitiveChild).toBe(false);
    }, 60_000);

    it('wires onFilePressPinned to Item.onDoublePress for file results', async () => {
        const { SearchResultsList } = await import('./SearchResultsList');
        const onFilePress = vi.fn();
        const onFilePressPinned = vi.fn();

        const file = {
            fileType: 'file',
            fileName: 'AGENTS.md',
            filePath: '',
            fullPath: 'AGENTS.md',
        } as any;

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(
                <SearchResultsList
                    theme={{ colors: { textSecondary: '#999', text: '#111', surfaceHigh: '#eee', divider: '#ddd', textLink: '#09f' } } as any}
                    isSearching={false}
                    searchQuery="AG"
                    searchResults={[file]}
                    onFilePress={onFilePress}
                    onFilePressPinned={onFilePressPinned}
                />
            );
        });

        const item = tree!.root.findByType('Item' as any);
        expect(typeof item.props.onDoublePress).toBe('function');

        act(() => {
            item.props.onDoublePress();
        });

        expect(onFilePressPinned).toHaveBeenCalledTimes(1);
        expect(onFilePressPinned).toHaveBeenCalledWith(file);
        expect(onFilePress).toHaveBeenCalledTimes(0);
    });

    it('renders file path on the left and file name on the right (matches changed-files layout)', async () => {
        const { SearchResultsList } = await import('./SearchResultsList');

        const file = {
            fileType: 'file',
            fileName: '/a.ts',
            filePath: 'src/',
            fullPath: 'src/a.ts',
        } as any;

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(
                <SearchResultsList
                    theme={{ colors: { textSecondary: '#999', text: '#111', surfaceHigh: '#eee', divider: '#ddd', textLink: '#09f' } } as any}
                    isSearching={false}
                    searchQuery="a"
                    searchResults={[file]}
                    onFilePress={vi.fn()}
                />
            );
        });

        const item = tree!.root.findByType('Item' as any);
        expect(item.props.title).toBe('src/');
        expect(item.props.rightElement?.type).toBe('Text');
        expect(String(item.props.rightElement?.props?.children)).toBe('a.ts');
    });
});
