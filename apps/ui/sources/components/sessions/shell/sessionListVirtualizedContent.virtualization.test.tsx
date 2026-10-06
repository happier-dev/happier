import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { buildSessionListIndexNodeId } from '@/sync/domains/sessionList/sessionListIndex';
import { installSessionShellCommonModuleMocks } from './sessionShellTestHelpers';
import { buildSessionListIndexNodeId } from '@/sync/domains/sessionList/sessionListIndex';

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
        folderFocus: null,
        onClearFolderFocus: vi.fn(),
        onSelectFolderBreadcrumb: vi.fn(),
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

    it('renders the canonical priority prefix before the inactive section on web', async () => {
        const active = {
            id: buildSessionListIndexNodeId({ type: 'header', title: 'Active', headerKind: 'active', groupKey: 'server:home|active' }),
            kind: 'header' as const,
            headerKind: 'active' as const,
        };
        const inactive = {
            id: buildSessionListIndexNodeId({ type: 'header', title: 'Inactive', headerKind: 'inactive', groupKey: 'server:home|inactive' }),
            kind: 'header' as const,
            headerKind: 'inactive' as const,
        };
        const sessions = Array.from({ length: 21 }, (_, index) => ({
            id: buildSessionListIndexNodeId({ type: 'session', sessionId: `s${index}`, serverId: 'home' }),
            kind: 'session' as const,
        }));
        await renderVirtualizedContent({ nodes: [active, ...sessions.slice(0, 20), inactive, ...sessions.slice(20)] });

        expect(virtualizationState.flatListProps.initialNumToRender).toBe(21);
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

    it('fills the web priority prefix before the inactive section with qualified header keys', async () => {
        const header = (headerKind: 'active' | 'inactive') => ({
            id: buildSessionListIndexNodeId({ type: 'header', headerKind, title: headerKind, groupKey: `https://home.test:8443/${headerKind}` }),
            kind: 'header' as const,
            headerKind,
        });
        const priorityRows = buildNodes(17).slice(1);
        await renderVirtualizedContent({
            nodes: [header('active'), ...priorityRows, header('inactive'), ...buildNodes(97).slice(17)],
        });
        expect(virtualizationState.flatListProps.initialNumToRender).toBe(1 + priorityRows.length);
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

    it('preserves the mounted web list when pagination crosses the virtualization threshold', async () => {
        const { SessionListVirtualizedContent } = await import('./sessionListVirtualizedContent');
        const screen = await renderVirtualizedContent({ nodes: buildNodes(120) });
        const firstList = screen.root.findByType('FlatList');

        await screen.update(React.createElement(
            SessionListVirtualizedContent as any,
            buildVirtualizedContentProps({ nodes: buildNodes(121) }),
        ));

        expect(screen.root.findByType('FlatList')).toBe(firstList);
        expect(virtualizationState.flatListProps.disableVirtualization).toBeUndefined();
    });

    it('keeps the FlatList viewability callback stable while dispatching to the latest handler', async () => {
        const firstHandler = vi.fn();
        const latestHandler = vi.fn();
        const screen = await renderVirtualizedContent({
            onViewableItemsChanged: firstHandler,
        });
        const initialCallback = virtualizationState.flatListProps.onViewableItemsChanged;
        const { SessionListVirtualizedContent } = await import('./sessionListVirtualizedContent');

        await screen.update(React.createElement(
            SessionListVirtualizedContent as any,
            buildVirtualizedContentProps({ onViewableItemsChanged: latestHandler }),
        ));

        const currentCallback = virtualizationState.flatListProps.onViewableItemsChanged;
        expect(currentCallback).toBe(initialCallback);

        const info = { viewableItems: [] };
        currentCallback(info);
        expect(firstHandler).not.toHaveBeenCalled();
        expect(latestHandler).toHaveBeenCalledWith(info);
    });

    it('hands the same list the same viewability handler and config across row changes, as FlatList requires', async () => {
        const { SessionListVirtualizedContent } = await import('./sessionListVirtualizedContent');
        const screen = await renderVirtualizedContent({
            nodes: buildNodes(4),
            onViewableItemsChanged: vi.fn(),
            viewabilityConfig: { itemVisiblePercentThreshold: 1 },
        });
        const firstList = screen.root.findByType('FlatList');
        const firstHandler = virtualizationState.flatListProps.onViewableItemsChanged;
        const firstConfig = virtualizationState.flatListProps.viewabilityConfig;

        for (const count of [6, 3, 8]) {
            await screen.update(React.createElement(
                SessionListVirtualizedContent as any,
                buildVirtualizedContentProps({
                    nodes: buildNodes(count),
                    onViewableItemsChanged: vi.fn(),
                    viewabilityConfig: { itemVisiblePercentThreshold: 1 },
                }),
            ));
            expect(screen.root.findByType('FlatList')).toBe(firstList);
            expect(virtualizationState.flatListProps.onViewableItemsChanged).toBe(firstHandler);
            expect(virtualizationState.flatListProps.viewabilityConfig).toBe(firstConfig);
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
