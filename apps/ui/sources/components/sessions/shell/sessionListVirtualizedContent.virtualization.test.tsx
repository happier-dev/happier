import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { buildSessionListIndexNodeId } from '@/sync/domains/sessionList/sessionListIndex';
import { installSessionShellCommonModuleMocks } from './sessionShellTestHelpers';

// Genuine third-party render boundary; none of these list tests renders Markdown.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({
    splitStreamingRevealTextParts: (text: string) => [{ text, reveal: false }],
}));

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
        ...(index === 0 ? {
            id: buildSessionListIndexNodeId({ type: 'header', title: 'Today', headerKind: 'date', groupKey: 'today' }),
            kind: 'header' as const,
            headerKind: 'date' as const,
        } : {
            id: buildSessionListIndexNodeId({ type: 'session', sessionId: String(index), serverId: 'home' }),
            kind: 'session' as const,
        }),
        rowViewModel: null,
    }));
}

// Keep the large shell import outside the test's observable assertion budget.
await import('./sessionListVirtualizedContent');

function buildVirtualizedContentProps(props: Partial<React.ComponentProps<any>> = {}) {
    return {
        nodes: buildNodes(2),
        rowHeight: 48,
        safeAreaBottom: 0,
        renderItem: ({ item }: any) => React.createElement('Row', { testID: `row:${item.id}` }),
        rowExtraData: null,
        onStopScrollEventPropagationOnWeb: vi.fn(),
        ...props,
    };
}

async function renderVirtualizedContent(props: Partial<React.ComponentProps<any>> = {}) {
    const { SessionListVirtualizedContent } = await import('./sessionListVirtualizedContent');
    return renderScreen(React.createElement(
        SessionListVirtualizedContent as any,
        buildVirtualizedContentProps(props),
    ));
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

    it('gives mixed Run cells a row height class rather than recycling a header cell', async () => {
        virtualizationState.platformOS = 'ios';
        const run = { id: buildSessionListIndexNodeId({ type: 'workflow_run', runId: 'run', serverId: 'home' }), kind: 'workflow_run' as const };
        await renderVirtualizedContent({ nodes: [run] });
        expect(virtualizationState.legendListProps.getItemType(run, 0)).toBe('workflow_run:default:body');
        expect(virtualizationState.legendListProps.getItemType({ ...run, isGroupTail: true }, 0)).toBe('workflow_run:default:tail');
    });

    it('pools canonical opaque header IDs by their semantic header kind', async () => {
        virtualizationState.platformOS = 'ios';
        const active = {
            id: buildSessionListIndexNodeId({ type: 'header', title: 'Active', headerKind: 'active', groupKey: 'server:home|active' }),
            kind: 'header' as const,
            headerKind: 'active' as const,
        };
        const project = {
            id: buildSessionListIndexNodeId({ type: 'header', title: 'Project', headerKind: 'project', groupKey: 'server:home|project:/tmp/inactive' }),
            kind: 'header' as const,
            headerKind: 'project' as const,
        };
        await renderVirtualizedContent({ nodes: [active, project] });

        expect(virtualizationState.legendListProps.getItemType(active, 0)).toBe('header:active');
        expect(virtualizationState.legendListProps.getItemType(project, 1)).toBe('header:project');
    });

    it('classifies qualified headers by their domain kind even when their keys contain delimiters', async () => {
        virtualizationState.platformOS = 'ios';
        const nodes = (['active', 'project', 'inactive'] as const).map((headerKind) => ({
            id: buildSessionListIndexNodeId({ type: 'header', headerKind, title: headerKind, groupKey: 'https://home.test:8443/project' }),
            kind: 'header' as const,
            headerKind,
        }));
        await renderVirtualizedContent({ nodes });
        expect(nodes.map((node, index) => virtualizationState.legendListProps.getItemType(node, index)))
            .toEqual(['header:active', 'header:project', 'header:inactive']);
    });

    it('keeps web lists of every size on the canonical Legend-backed VirtualizedList', async () => {
        // React Native Web's FlatList caches each cell's offset from its own resize notifications, and a
        // browser reports a size change only. When the header grew or rows above hydrated, the cached offsets
        // of unchanged cells went stale and the My work list rendered nothing across a scroll range.
        // Legend derives positions from measured sizes, so every web list uses it, small or large.
        for (const count of [3, 120, 121, 300]) {
            virtualizationState.flatListProps = null;
            virtualizationState.legendListProps = null;
            await renderVirtualizedContent({ nodes: buildNodes(count) });

            expect(virtualizationState.flatListProps).toBeNull();
            expect(virtualizationState.legendListProps).toBeTruthy();
            expect(virtualizationState.legendListProps.disableVirtualization).toBeUndefined();
            expect(virtualizationState.legendListProps.scrollEventThrottle).toBe(32);
            expect(typeof virtualizationState.legendListProps.onWheel).toBe('function');
            expect(typeof virtualizationState.legendListProps.onTouchMove).toBe('function');
        }
    });

    it('preserves the mounted web list when pagination adds rows', async () => {
        const { SessionListVirtualizedContent } = await import('./sessionListVirtualizedContent');
        const screen = await renderVirtualizedContent({ nodes: buildNodes(120) });
        const firstList = screen.root.findByType('LegendList');

        await screen.update(React.createElement(
            SessionListVirtualizedContent as any,
            buildVirtualizedContentProps({ nodes: buildNodes(121) }),
        ));

        expect(screen.root.findByType('LegendList')).toBe(firstList);
    });

    it('keeps the list viewability callback stable while dispatching to the latest handler', async () => {
        const firstHandler = vi.fn();
        const latestHandler = vi.fn();
        const screen = await renderVirtualizedContent({
            onViewableItemsChanged: firstHandler,
        });
        const initialCallback = virtualizationState.legendListProps.onViewableItemsChanged;
        const { SessionListVirtualizedContent } = await import('./sessionListVirtualizedContent');

        await screen.update(React.createElement(
            SessionListVirtualizedContent as any,
            buildVirtualizedContentProps({ onViewableItemsChanged: latestHandler }),
        ));

        const currentCallback = virtualizationState.legendListProps.onViewableItemsChanged;
        expect(currentCallback).toBe(initialCallback);

        const info = { viewableItems: [] };
        currentCallback(info);
        expect(firstHandler).not.toHaveBeenCalled();
        expect(latestHandler).toHaveBeenCalledWith(info);
    });

    it('hands the same list the same viewability handler and config across row changes', async () => {
        const { SessionListVirtualizedContent } = await import('./sessionListVirtualizedContent');
        const screen = await renderVirtualizedContent({
            nodes: buildNodes(4),
            onViewableItemsChanged: vi.fn(),
            viewabilityConfig: { itemVisiblePercentThreshold: 1 },
        });
        const firstList = screen.root.findByType('LegendList');
        const firstHandler = virtualizationState.legendListProps.onViewableItemsChanged;
        const firstConfig = virtualizationState.legendListProps.viewabilityConfig;

        for (const count of [6, 3, 8]) {
            await screen.update(React.createElement(
                SessionListVirtualizedContent as any,
                buildVirtualizedContentProps({
                    nodes: buildNodes(count),
                    onViewableItemsChanged: vi.fn(),
                    viewabilityConfig: { itemVisiblePercentThreshold: 1 },
                }),
            ));
            expect(screen.root.findByType('LegendList')).toBe(firstList);
            expect(virtualizationState.legendListProps.onViewableItemsChanged).toBe(firstHandler);
            expect(virtualizationState.legendListProps.viewabilityConfig).toBe(firstConfig);
        }
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
