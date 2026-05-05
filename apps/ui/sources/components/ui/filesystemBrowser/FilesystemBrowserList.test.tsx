import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

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
    });
});

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
});
