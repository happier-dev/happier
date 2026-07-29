import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const platformState = vi.hoisted(() => ({
    os: 'web',
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        ActivityIndicator: 'ActivityIndicator',
        FlatList: ({ data, renderItem, keyExtractor, ListHeaderComponent }: any) => {
            const header = ListHeaderComponent
                ? (React.isValidElement(ListHeaderComponent) ? ListHeaderComponent : React.createElement(ListHeaderComponent))
                : null;
            const rows = (data ?? []).map((item: any, index: number) => {
                const key = keyExtractor ? keyExtractor(item, index) : String(item?.path ?? index);
                return React.createElement(React.Fragment, { key }, renderItem({ item, index }));
            });
            return React.createElement('FlatList', null, header, ...rows);
        },
        Platform: {
            get OS() {
                return platformState.os;
            },
            select: (options: any) => options?.[platformState.os] ?? options?.default ?? options?.native,
        },
    });
});

vi.mock('@legendapp/list/react-native', () => ({
    LegendList: ({ data, renderItem, keyExtractor, ListHeaderComponent, estimatedItemSize }: any) => {
        const header = ListHeaderComponent
            ? (React.isValidElement(ListHeaderComponent) ? ListHeaderComponent : React.createElement(ListHeaderComponent))
            : null;
        const rows = (data ?? []).map((item: any, index: number) => {
            const key = keyExtractor ? keyExtractor(item, index) : String(item?.path ?? index);
            return React.createElement(React.Fragment, { key }, renderItem({ item, index }));
        });
        return React.createElement('LegendList', { estimatedItemSize }, header, ...rows);
    },
}));

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
            colors: {
                textSecondary: '#888',
                textLink: '#08f',
            },
        } as any,
    });
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
}));

vi.mock('@/constants/Typography', () => ({
    Typography: {
        default: () => ({}),
    },
}));

describe('FilesystemBrowserList', () => {
    const nodes = [
        { path: 'src/index.ts', name: 'index.ts', type: 'file', depth: 0 },
    ] as any[];

    beforeEach(() => {
        platformState.os = 'web';
    });

    it('keeps rows mounted without an inline root loading header when loading is surfaced elsewhere', async () => {
        const { FilesystemBrowserList } = await import('./FilesystemBrowserList');

        const screen = await renderScreen(
            <FilesystemBrowserList
                nodes={nodes}
                rootLoading={true}
                showInlineLoadingHeader={false}
                rootError={null}
                loadingLabel="Loading"
                inlineRetryLabel="Retry"
                retryRoot={() => {}}
                renderRow={({ node }) => React.createElement('View', { testID: `row-${node.path}` })}
            />,
        );

        expect(screen.findByTestId('row-src/index.ts')).toBeTruthy();
        expect(screen.findAllByType('ActivityIndicator' as any)).toHaveLength(0);
    });

    it('uses LegendList on native file browsers', async () => {
        platformState.os = 'ios';
        const { FilesystemBrowserList } = await import('./FilesystemBrowserList');

        const screen = await renderScreen(
            <FilesystemBrowserList
                nodes={nodes}
                rootLoading={false}
                showInlineLoadingHeader={false}
                rootError={null}
                loadingLabel="Loading"
                inlineRetryLabel="Retry"
                retryRoot={() => {}}
                renderRow={({ node }) => React.createElement('View', { testID: `row-${node.path}` })}
            />,
        );

        const legendLists = screen.findAllByType('LegendList' as any);
        expect(legendLists).toHaveLength(1);
        expect(legendLists[0]?.props?.estimatedItemSize).toBeGreaterThan(0);
        expect(screen.findAllByType('FlatList' as any)).toHaveLength(0);
    });
});
