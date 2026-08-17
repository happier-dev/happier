import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installSessionShellCommonModuleMocks } from './sessionShellTestHelpers';

const virtualizationState = vi.hoisted(() => ({
    platformOS: 'web',
    flatListProps: null as any,
    legendListProps: null as any,
}));

installSessionShellCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        const { createCapturingFlatListMock } = await import('@/dev/testkit/mocks/virtualizedList');
        const runtime = await createReactNativeWebMock();
        const flatListMock = createCapturingFlatListMock({ renderItems: false });
        const platform = { ...runtime.Platform };
        Object.defineProperty(platform, 'OS', {
            get: () => virtualizationState.platformOS,
        });
        return {
            ...runtime,
            Platform: platform,
            FlatList: (props: any) => {
                const element = flatListMock.module.FlatList(props);
                virtualizationState.flatListProps = flatListMock.state.props;
                return element;
            },
        };
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translate: (key: string) => key,
        });
    },
});

vi.mock('@legendapp/list/react-native', async () => {
    const ReactModule = await import('react');
    return {
        LegendList: ReactModule.forwardRef<any, any>((props, ref) => {
            virtualizationState.legendListProps = props;
            if (typeof ref === 'function') {
                ref({
                    scrollToOffset: () => {},
                    scrollToIndex: () => {},
                });
            } else if (ref && typeof ref === 'object') {
                ref.current = {
                    scrollToOffset: () => {},
                    scrollToIndex: () => {},
                };
            }
            return ReactModule.createElement('LegendList', props);
        }),
    };
});

vi.mock('./sessionListChrome', () => ({
    SessionsListHeader: () => React.createElement('SessionsListHeader'),
    SessionFolderFocusBreadcrumbs: () => React.createElement('SessionFolderFocusBreadcrumbs'),
}));
vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement('Item', props, props.title),
}));
vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: (props: any) => React.createElement('ItemGroup', props, props.children),
}));
vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

function buildNodes(count: number) {
    return Array.from({ length: count }, (_, index) => ({
        id: index === 0 ? 'header:date:today' : `session:${index}`,
        rowViewModel: null,
    }));
}

async function renderVirtualizedContent(props: Partial<React.ComponentProps<any>> = {}) {
    const { SessionListVirtualizedContent } = await import('./sessionListVirtualizedContent');
    return renderScreen(React.createElement(SessionListVirtualizedContent as any, {
        nodes: buildNodes(2),
        rowHeight: 48,
        safeAreaBottom: 0,
        renderItem: ({ item }: any) => React.createElement('Row', { testID: `row:${item.id}` }),
        rowExtraData: null,
        onStopScrollEventPropagationOnWeb: vi.fn(),
        onPressArchivedSessions: vi.fn(),
        folderFocus: null,
        onClearFolderFocus: vi.fn(),
        onSelectFolderBreadcrumb: vi.fn(),
        ...props,
    }));
}

describe('SessionListVirtualizedContent virtualization', () => {
    beforeEach(() => {
        virtualizationState.platformOS = 'web';
        virtualizationState.flatListProps = null;
        virtualizationState.legendListProps = null;
    });

    afterEach(() => {
        standardCleanup();
    });

    it('keeps small web lists on non-virtualized React Native Web FlatList', async () => {
        await renderVirtualizedContent({
            nodes: buildNodes(120),
        });

        expect(virtualizationState.flatListProps).toBeTruthy();
        expect(virtualizationState.legendListProps).toBeNull();
        expect(virtualizationState.flatListProps.disableVirtualization).toBe(true);
        expect(virtualizationState.flatListProps.scrollEventThrottle).toBe(32);
        expect(typeof virtualizationState.flatListProps.onWheel).toBe('function');
        expect(typeof virtualizationState.flatListProps.onTouchMove).toBe('function');
    });

    it('keeps large web session lists on the virtualized FlatList backend', async () => {
        await renderVirtualizedContent({
            nodes: buildNodes(121),
        });

        // A real 300+ row web account reproduced React's nested-update crash
        // inside Legend's container-layout coordinator. Large lists still need
        // virtualization; the bounded web escape hatch is therefore FlatList
        // with virtualization enabled, not the all-rows small-list mode.
        expect(virtualizationState.flatListProps).toBeTruthy();
        expect(virtualizationState.legendListProps).toBeNull();
        expect(virtualizationState.flatListProps.disableVirtualization).toBeUndefined();
        expect(virtualizationState.flatListProps.scrollEventThrottle).toBe(32);
        expect(typeof virtualizationState.flatListProps.onWheel).toBe('function');
        expect(typeof virtualizationState.flatListProps.onTouchMove).toBe('function');
    });

    it('keeps native lists on the canonical Legend-backed VirtualizedList with native refresh and scroll tuning', async () => {
        const refreshControl = React.createElement('RefreshControl');
        virtualizationState.platformOS = 'ios';

        await renderVirtualizedContent({
            nativeRefreshControl: refreshControl,
        });

        expect(virtualizationState.flatListProps).toBeNull();
        expect(virtualizationState.legendListProps).toBeTruthy();
        expect(virtualizationState.legendListProps.scrollEventThrottle).toBe(16);
        expect(virtualizationState.legendListProps.refreshControl).toBe(refreshControl);
        expect(virtualizationState.legendListProps.onWheel).toBeUndefined();
    });
});
