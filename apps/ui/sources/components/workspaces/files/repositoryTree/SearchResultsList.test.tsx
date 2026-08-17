import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { renderScreen } from '@/dev/testkit';
import { installFilesContentCommonModuleMocks } from '@/components/workspaces/scm/review/filesContentTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installFilesContentCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock(
            {
                Platform: {
                    OS: 'web',
                },
                TurboModuleRegistry: {
                    get: () => ({}),
                },
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
            },
        );
    },
});

// `@legendapp/list` is a third-party boundary. It is stubbed here exactly as the
// sibling SearchResultsList suites stub it: the list keeps its real auxiliary
// contract (header, rows via `renderItem`, `ListEmptyComponent` when empty) so
// the assertions below still exercise the component's own rendering. Without
// this the real web build mounts and its passive effect calls
// `requestAnimationFrame`, which the node test environment does not provide.
vi.mock('@legendapp/list/react-native', async () => {
    const ReactModule = await import('react');
    return {
        LegendList: ReactModule.forwardRef((props: any, _ref) => {
            const renderAuxiliary = (component: any) => {
                if (!component) return null;
                if (ReactModule.isValidElement(component)) return component;
                return ReactModule.createElement(component);
            };
            const data: any[] = Array.isArray(props.data) ? props.data : [];
            const items = data.map((item: any, index: number) => ReactModule.createElement(
                'LegendListItem',
                { key: props.keyExtractor?.(item, index) ?? String(index) },
                props.renderItem?.({ item, index }),
            ));
            return ReactModule.createElement(
                'LegendList',
                props,
                renderAuxiliary(props.ListHeaderComponent),
                ...items,
                data.length === 0 ? renderAuxiliary(props.ListEmptyComponent) : null,
            );
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

vi.mock('@/constants/Typography', () => ({
    Typography: {
        default: () => ({}),
    },
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: 'Item',
}));

const searchResultsTheme = {
    colors: {
        border: { default: '#ddd' },
        surface: { inset: '#eee' },
        text: {
            link: '#09f',
            primary: '#111',
            secondary: '#999',
        },
    },
};

describe('SearchResultsList', () => {
    it('does not render string children under View when searchQuery is empty', async () => {
        const { SearchResultsList } = await import('./SearchResultsList');

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<SearchResultsList
                    theme={searchResultsTheme}
                    isSearching={false}
                    searchQuery=""
                    searchResults={[]}
                    onFilePress={vi.fn()}
                />)).tree;

        const rootView = tree!.findByType('View' as any);
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
        tree = (await renderScreen(<SearchResultsList
                    theme={searchResultsTheme}
                    isSearching={false}
                    searchQuery="AG"
                    searchResults={[file]}
                    onFilePress={onFilePress}
                    onFilePressPinned={onFilePressPinned}
                />)).tree;

        const item = tree!.findByType('Item' as any);
        expect(typeof item.props.onDoublePress).toBe('function');

        act(() => {
            item.props.onDoublePress();
        });

        expect(onFilePressPinned).toHaveBeenCalledTimes(1);
        expect(onFilePressPinned).toHaveBeenCalledWith(file);
        expect(onFilePress).toHaveBeenCalledTimes(0);
    });

    it('renders a single inline repo path label with the directory truncating from the head', async () => {
        const { SearchResultsList } = await import('./SearchResultsList');

        const file = {
            fileType: 'file',
            fileName: '/a.ts',
            filePath: 'src/',
            fullPath: 'src/a.ts',
        } as any;

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<SearchResultsList
                    theme={searchResultsTheme}
                    isSearching={false}
                    searchQuery="a"
                    searchResults={[file]}
                    onFilePress={vi.fn()}
                />)).tree;

        const item = tree!.findByType('Item' as any);
        expect(React.isValidElement(item.props.title)).toBe(true);
        expect(item.props.rightElement).toBeNull();
        const title = item.props.title;
        expect(title.props.filePath).toBe('src/');
        expect(title.props.fileName).toBe('/a.ts');
        expect(title.props.nameMaxWidth).toBe(220);
    });
});
