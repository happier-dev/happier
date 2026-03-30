import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { installFormsCommonModuleMocks } from './formsTestHelpers';
import { collectUnexpectedRawTextNodes, renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const mockEnv = vi.hoisted(() => ({
    iconsRenderAsText: false,
}));

type RenderedScreen = Awaited<ReturnType<typeof renderScreen>>;
type RenderedAccessoryTree = {
    toJSON(): unknown;
    unmount(): void;
};

installFormsCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'web',
                select: (spec: { web?: unknown; ios?: unknown; default?: unknown }) =>
                    (spec && 'web' in spec ? spec.web : spec?.default),
            },
            AppState: {
                addEventListener: () => ({ remove: () => {} }),
            },
            View: 'View',
            Text: 'Text',
            Pressable: 'Pressable',
        });
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
            theme: {
                dark: false,
                colors: {
                    surface: '#fff',
                    divider: '#ddd',
                    shadow: { color: '#000', opacity: 0.2 },
                    textSecondary: '#666',
                    textLink: '#00f',
                    button: { primary: { background: '#00f' } },
                },
            },
            rt: { themeName: 'light' },
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: (props: any) =>
        mockEnv.iconsRenderAsText ? React.createElement(React.Fragment, null, '.') : React.createElement('Ionicons', props, null),
}));

vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}) },
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement(
        'Item',
        props,
        [
            props.leftElement == null ? null : React.createElement('Text', { key: 'left' }, props.leftElement),
            props.rightElement == null ? null : React.createElement(React.Fragment, { key: 'right' }, props.rightElement),
            props.subtitle == null ? null : React.createElement('Text', { key: 'subtitle' }, props.subtitle),
        ],
    ),
}));

vi.mock('@/components/ui/status/StatusDot', () => ({
    StatusDot: () => null,
}));

vi.mock('@/components/ui/forms/SearchHeader', () => ({
    SearchHeader: () => null,
}));

describe('SearchableListSelector (disabled items)', () => {
    it('marks disabled rows and prevents selection when pressed', async () => {
        const { SearchableListSelector } = await import('./SearchableListSelector');
        const onSelect = vi.fn();

        const items = [
            { id: 'a', title: 'A' },
            { id: 'b', title: 'B' },
        ] as const;

        const config: any = {
            getItemId: (item: any) => item.id,
            getItemTitle: (item: any) => item.title,
            getItemIcon: () => null,
            formatForDisplay: (item: any) => item.title,
            parseFromDisplay: () => null,
            filterItem: () => true,
            searchPlaceholder: 'Search…',
            recentSectionTitle: 'Recent',
            favoritesSectionTitle: 'Favorites',
            allSectionTitle: 'All',
            noItemsMessage: 'Empty',
            showFavorites: false,
            showRecent: false,
            showSearch: false,
            allowCustomInput: false,
            isItemDisabled: (item: any) => item.id === 'b',
        };

        const screen = await renderScreen(<SearchableListSelector
                    config={config}
                    items={[...items] as any}
                    selectedItem={null}
                    onSelect={onSelect}
                    testIdPrefix="selector"
                />);

        const rowA = screen.findByTestId('selector:a');
        const rowB = screen.findByTestId('selector:b');
        expect(rowA).toBeTruthy();
        expect(rowB).toBeTruthy();

        expect(rowA!.props.disabled).toBeFalsy();
        expect(rowB!.props.disabled).toBe(true);

        screen.pressByTestId('selector:b');
        expect(onSelect).not.toHaveBeenCalled();

        screen.pressByTestId('selector:a');
        expect(onSelect).toHaveBeenCalledTimes(1);
        expect(onSelect).toHaveBeenCalledWith(items[0]);
    });

    it('applies test ids for items when configured', async () => {
        const { SearchableListSelector } = await import('./SearchableListSelector');
        const onSelect = vi.fn();

        const items = [
            { id: 'a', title: 'A' },
            { id: 'b', title: 'B' },
        ] as const;

        const config: any = {
            getItemId: (item: any) => item.id,
            getItemTitle: (item: any) => item.title,
            getItemIcon: () => null,
            formatForDisplay: (item: any) => item.title,
            parseFromDisplay: () => null,
            filterItem: () => true,
            searchPlaceholder: 'Search…',
            recentSectionTitle: 'Recent',
            favoritesSectionTitle: 'Favorites',
            allSectionTitle: 'All',
            noItemsMessage: 'Empty',
            showFavorites: false,
            showRecent: false,
            showSearch: false,
            allowCustomInput: false,
        };

        const screen = await renderScreen(<SearchableListSelector
                    config={config}
                    items={[...items] as any}
                    selectedItem={null}
                    onSelect={onSelect}
                    testIdPrefix="selector"
                />);

        expect(screen.findByTestId('selector:a')?.props.testID).toBe('selector:a');
        expect(screen.findByTestId('selector:b')?.props.testID).toBe('selector:b');
    });

    it('does not emit raw text nodes inside row accessories when icons render as text on web', async () => {
        const { SearchableListSelector } = await import('./SearchableListSelector');
        const items = [{ id: 'a', title: 'A' }] as const;

        const config: any = {
            getItemId: (item: any) => item.id,
            getItemTitle: (item: any) => item.title,
            getItemIcon: () => null,
            getItemStatus: () => ({ text: 'Online', color: '#0a0', dotColor: '#0a0' }),
            formatForDisplay: (item: any) => item.title,
            parseFromDisplay: () => null,
            filterItem: () => true,
            searchPlaceholder: 'Search…',
            recentSectionTitle: 'Recent',
            favoritesSectionTitle: 'Favorites',
            allSectionTitle: 'All',
            noItemsMessage: 'Empty',
            showFavorites: true,
            showRecent: false,
            showSearch: false,
            allowCustomInput: false,
        };

        mockEnv.iconsRenderAsText = true;

        const renderState: {
            tree: RenderedScreen['tree'] | null;
            accessoryTree: RenderedAccessoryTree | null;
        } = {
            tree: null,
            accessoryTree: null,
        };
        try {
            renderState.tree = (await renderScreen(<SearchableListSelector
                        config={config}
                        items={[...items] as any}
                        favoriteItems={[...items] as any}
                        selectedItem={items[0] as any}
                        onSelect={() => {}}
                        onToggleFavorite={() => {}}
                        testIdPrefix="selector"
                    />)).tree;

            const renderedTree = renderState.tree;
            if (!renderedTree) throw new Error('Expected rendered selector tree');
            const rowA = renderedTree.findByTestId('selector:a');
            expect(rowA?.props.rightElement).toBeTruthy();

            renderState.accessoryTree = (await renderScreen(rowA!.props.rightElement)).tree;
            const renderedAccessoryTree = renderState.accessoryTree;
            if (!renderedAccessoryTree) throw new Error('Expected accessory tree');
            expect(
                collectUnexpectedRawTextNodes(
                    renderedAccessoryTree.toJSON() as Parameters<typeof collectUnexpectedRawTextNodes>[0],
                ),
            ).toEqual([]);
        } finally {
            mockEnv.iconsRenderAsText = false;
            act(() => {
                renderState.accessoryTree?.unmount();
                renderState.tree?.unmount();
            });
        }
    });
});
