import * as React from 'react';
import type renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installFilesContentCommonModuleMocks } from '@/components/workspaces/scm/review/filesContentTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Instrumented scroll owner. `mounts` counts how many times the virtualized list
 * was created; `offset` models the scroll position that lives on that instance
 * and is therefore lost whenever the instance is replaced.
 */
const scrollOwner = vi.hoisted(() => ({
    mounts: 0,
    unmounts: 0,
    offset: 0,
}));

installFilesContentCommonModuleMocks({
    text: async () => vi.importActual('@/text'),
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'web',
                select: <T,>(options: { ios?: T; native?: T; default?: T; web?: T }) =>
                    options.web ?? options.default ?? options.native ?? options.ios,
            },
            TurboModuleRegistry: { get: () => ({}) },
        });
    },
});

vi.mock('@legendapp/list/react-native', async () => {
    const ReactModule = await import('react');
    return {
        LegendList: ReactModule.forwardRef((props: any, _ref) => {
            ReactModule.useEffect(() => {
                scrollOwner.mounts += 1;
                // A freshly created scroll container always starts at the top.
                scrollOwner.offset = 0;
                return () => {
                    scrollOwner.unmounts += 1;
                };
            }, []);

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

const theme = {
    colors: {
        border: { default: '#ddd' },
        surface: { inset: '#eee' },
        text: { link: '#09f', primary: '#111', secondary: '#999' },
    },
} as any;

function makeFile(name: string) {
    return { fileType: 'file', fileName: name, filePath: 'src/', fullPath: `src/${name}` } as any;
}

function countLists(tree: renderer.ReactTestRenderer): number {
    return tree.root.findAll((node) => String(node.type) === 'LegendList').length;
}

describe('SearchResultsList scroll owner stability', () => {
    beforeEach(() => {
        scrollOwner.mounts = 0;
        scrollOwner.unmounts = 0;
        scrollOwner.offset = 0;
    });

    it('keeps one virtualized list across searching -> results -> no-results cycles', async () => {
        const { SearchResultsList } = await import('./SearchResultsList');

        const props = (overrides: Record<string, unknown>) => ({
            theme,
            isSearching: false,
            searchQuery: 'se',
            searchResults: [] as any[],
            onFilePress: vi.fn(),
            ...overrides,
        });

        const rendered = await renderScreen(
            <SearchResultsList {...props({ isSearching: true }) as any} />,
        );
        const tree = rendered.tree;

        // Searching: the spinner is list content, not a replacement for the list.
        expect(countLists(tree)).toBe(1);
        expect(scrollOwner.mounts).toBe(1);
        expect(rendered.findHostByTestId('files-search-searching')).not.toBeNull();

        await rendered.update(
            <SearchResultsList {...props({ searchResults: [makeFile('a.ts'), makeFile('b.ts')] }) as any} />,
        );
        expect(rendered.getTextContent()).toContain('a.ts');
        expect(rendered.getTextContent()).toContain('b.ts');

        // The user scrolled the results; that position lives on the list instance.
        scrollOwner.offset = 320;

        await rendered.update(<SearchResultsList {...props({ searchQuery: 'zzz' }) as any} />);
        expect(rendered.findHostByTestId('files-search-no-results')).not.toBeNull();

        await rendered.update(
            <SearchResultsList {...props({ searchResults: [makeFile('a.ts')] }) as any} />,
        );

        expect(countLists(tree)).toBe(1);
        expect(scrollOwner.mounts).toBe(1);
        expect(scrollOwner.unmounts).toBe(0);
        expect(scrollOwner.offset).toBe(320);
    });

    it('renders the no-results state as content inside the list', async () => {
        const { SearchResultsList } = await import('./SearchResultsList');

        const tree = (await renderScreen(
            <SearchResultsList
                theme={theme}
                isSearching={false}
                searchQuery=""
                searchResults={[]}
                onFilePress={vi.fn()}
            />,
        )).tree;

        const list = tree.root.find((node) => String(node.type) === 'LegendList');
        expect(list.findAll((node) => (
            typeof node.type === 'string' && node.props.testID === 'files-search-empty'
        ))).not.toHaveLength(0);
    });
});
