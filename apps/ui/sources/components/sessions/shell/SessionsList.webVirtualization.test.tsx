import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import type { SessionListIndexItem } from '@/sync/domains/session/listing/sessionListIndex';
import type { SessionListViewItem } from '@/sync/domains/session/listing/sessionListViewData';
import type { SessionFolderWorkspaceRefV1 } from '@/sync/domains/session/folders';
import { useTreeDropRegistry } from '@/components/ui/treeDragDrop';
import type { TreeContentRow, TreeViewportMetrics } from '@/components/ui/treeDragDrop';
import { installSessionShellCommonModuleMocks } from './sessionShellTestHelpers';
import { buildSessionListDragSnapshot } from './drag/sessionListDragSnapshot';
import { resolveSessionListDragPointer } from './drag/resolveSessionListDragPointer';
import { treeRowId } from './drop-resolution/treeRowId';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Lane E — Phase 5 web list virtualization
 * (`.project/plans/session-list-drag-geometry-performance-unification.md`,
 * sections 3.6, 13.6).
 *
 * Three properties:
 * (a) large web lists use the app's FlashListCompat path and do NOT mount
 *     every row, so the mounted region stays bounded;
 * (b) dragging after a scroll still resolves the correct target;
 * (c) autoscroll drag to a previously offscreen target, INCLUDING a variable-
 *     height folder header, still resolves correctly.
 *
 * (a) renders `SessionsList` on web behind a `FlashListCompat` mock that
 * windows its `data` the way the real browser list must. (b)/(c) drive the real drag model
 * (`buildSessionListDragSnapshot` + the live `useTreeDropRegistry` +
 * `resolveSessionListDragPointer`): the target row/header is registered only
 * AFTER a scroll — i.e. it mounts late, the way a virtualized row does — and
 * still resolves, because content-coordinate geometry is never rebased on
 * scroll.
 */

// ---------------------------------------------------------------------------
// (a) Windowing web list mocks + SessionsList render
// ---------------------------------------------------------------------------

// Captured props of the web FlatList for the most recent render.
let capturedWebFlatListProps: any | null = null;
let capturedWebFlashListProps: any | null = null;
// Approximate viewport height in rows the windowing mock simulates.
const WINDOWING_VIEWPORT_ROW_COUNT = 8;

const routerPushSpy = vi.fn();
const fetchMoreSessionsMock = vi.hoisted(() => vi.fn(async () => undefined));
const markSessionListScrollActivityMock = vi.hoisted(() => vi.fn());
const preloadEnrichedMarkdownRuntimeSpy = vi.hoisted(() => vi.fn(() => Promise.resolve()));
let pinnedSessionKeysV1: string[] = [];
let sessionTagsV1: Record<string, string[]> = {};
let workspaceLabelsV1: Record<string, string> = {};
// Module-level stable setters: a fresh `vi.fn()` per render would change the
// identity of every memoized row callback every render and thrash the list.
const setPinnedSessionKeysV1 = vi.fn();
const setSessionTagsV1 = vi.fn();
const setWorkspaceLabelsV1 = vi.fn();
const noopSettingSetter = vi.fn();
// Stable identities for storage hooks read inside memo/effect dependency arrays.
const STABLE_EMPTY_MACHINES: any[] = [];
const STABLE_EMPTY_MACHINE_DISPLAY: Record<string, any> = {};
const STABLE_PROFILE = {
    id: 'profile-1',
    timestamp: 0,
    firstName: null,
    lastName: null,
    username: null,
    avatar: null,
    linkedProviders: [],
    connectedServices: [],
    connectedServicesV2: [],
    connectedServiceCredentialRevisionsV1: [],
};

const groupKey = 'server:server_a:day:2026-02-17';

const getSessionStatusMock = vi.hoisted(() => vi.fn((session: any, _nowMs: number, options: any) => {
    const workingTextMode = options && typeof options === 'object'
        ? options.workingTextMode
        : undefined;
    const isWorking = session?.thinking === true
        || session?.active === true
        || session?.latestTurnStatus === 'in_progress';
    if (isWorking) {
        return {
            state: 'thinking',
            isConnected: true,
            statusText: workingTextMode === 'static' ? 'status.working' : 'animated-working',
            shouldShowStatus: true,
            statusColor: '#000',
            statusDotColor: '#000',
            isPulsing: true,
        };
    }
    return {
        state: 'disconnected',
        isConnected: false,
        statusText: 'Disconnected',
        shouldShowStatus: true,
        statusColor: '#000',
        statusDotColor: '#000',
    };
}));

function makeSession(id: string, overrides: Record<string, unknown> = {}) {
    return {
        id,
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: false,
        activeAt: 0,
        metadata: null,
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: 0,
        presence: 'offline',
        ...overrides,
    } as any;
}

const LARGE_SESSION_COUNT = 130;

function buildLargeVisibleSessionListViewData(): SessionListViewItem[] {
    const items: SessionListViewItem[] = [
        {
            type: 'header',
            title: 'Today',
            headerKind: 'date',
            groupKey,
            serverId: 'server_a',
            serverName: 'Server A',
        } as SessionListViewItem,
    ];
    for (let index = 0; index < LARGE_SESSION_COUNT; index += 1) {
        items.push({
            type: 'session',
            session: makeSession(`sess_${index}`),
            groupKey,
            groupKind: 'date',
            serverId: 'server_a',
            serverName: 'Server A',
        } as SessionListViewItem);
    }
    return items;
}

let mockVisibleSessionListViewData: SessionListViewItem[] = buildLargeVisibleSessionListViewData();

/**
 * List test doubles that keep mounted rows bounded. The FlatList variant
 * preserves the React Native Web VirtualizedList approximation used by the
 * small-list drag tests; the FlashList variant models the large-list browser
 * path that production now uses after RNW FlatList mounted every real row.
 */
function createWindowingList(params: Readonly<{
    componentName: string;
    itemWrapperName: string;
    captureProps: (props: any) => void;
    defaultWindowedCount?: number;
}>) {
    return function WindowingList(props: any) {
        params.captureProps(props);
        const data: any[] = Array.isArray(props.data) ? props.data : [];

        const windowSize = typeof props.windowSize === 'number' ? props.windowSize : 21;
        const initialNumToRender = typeof props.initialNumToRender === 'number'
            ? props.initialNumToRender
            : 10;

        // VirtualizedList mounts `windowSize` viewport-heights of cells. FlashList
        // owns its window internally, so the test double uses a small fixed first
        // window unless the caller explicitly supplies RN-style batch props.
        const windowedCount = Math.min(
            data.length,
            typeof params.defaultWindowedCount === 'number'
                ? params.defaultWindowedCount
                : Math.max(initialNumToRender, windowSize * WINDOWING_VIEWPORT_ROW_COUNT),
        );
        const mounted = data.slice(0, windowedCount);

        const renderAux = (component: any) => {
            if (!component) return null;
            if (React.isValidElement(component)) return component;
            return React.createElement(component);
        };

        const rows = mounted.map((item: any, index: number) => {
            const key = typeof props.keyExtractor === 'function'
                ? props.keyExtractor(item, index)
                : item?.id ?? String(index);
            const child = typeof props.renderItem === 'function'
                ? props.renderItem({ item, index })
                : null;
            return React.createElement(params.itemWrapperName, { key }, child);
        });

        return React.createElement(
            params.componentName,
            props,
            renderAux(props.ListHeaderComponent),
            ...rows,
            renderAux(props.ListFooterComponent),
        );
    };
}

const windowingFlatList = createWindowingList({
    componentName: 'FlatList',
    itemWrapperName: 'WindowingFlatListItem',
    captureProps: (props) => {
        capturedWebFlatListProps = props;
    },
});
const windowingFlashList = createWindowingList({
    componentName: 'FlashListCompat',
    itemWrapperName: 'WindowingFlashListItem',
    defaultWindowedCount: 12,
    captureProps: (props) => {
        capturedWebFlashListProps = props;
    },
});

// The engine behind the seam is selectable, so this suite captures at the SEAM rather than at one
// engine. It asserts that large web lists use the virtualized surface (and do not mount every row)
// rather than RN-Web FlatList — which is true whichever engine renders them.
vi.mock('@/components/ui/lists/flashListCompat/SessionListVirtualizedList', () => ({
    SessionListVirtualizedList: (props: any) => windowingFlashList(props),
}));

installSessionShellCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: { OS: 'web', select: (value: any) => value.web ?? value.default },
            TurboModuleRegistry: { get: () => ({}) },
            FlatList: (props: any) => windowingFlatList(props),
        });
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({
            pathname: '',
            router: {
                push: routerPushSpy,
                replace: vi.fn(),
                back: vi.fn(),
                setParams: vi.fn(),
            },
        }).module;
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
    modal: async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module,
    storage: async (importOriginal) => {
        const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleMock({
            importOriginal,
            overrides: {
                useSetting: (key: string) => {
                    if (key === 'compactSessionView') return false;
                    if (key === 'compactSessionViewMinimal') return false;
                    if (key === 'sessionTagsEnabled') return true;
                    return null;
                },
                useHasUnreadMessages: () => false,
                useSession: () => null,
                useProfile: () => STABLE_PROFILE,
                useAllMachines: () => STABLE_EMPTY_MACHINES,
                useMachineDisplayById: () => STABLE_EMPTY_MACHINE_DISPLAY,
                // Stable module-level setters: a per-call `vi.fn()` would change
                // every memoized row callback's identity each render.
                useSettingMutable: (key: string) => {
                    if (key === 'pinnedSessionKeysV1') return [pinnedSessionKeysV1, setPinnedSessionKeysV1];
                    if (key === 'sessionTagsV1') return [sessionTagsV1, setSessionTagsV1];
                    if (key === 'workspaceLabelsV1') return [workspaceLabelsV1, setWorkspaceLabelsV1];
                    return [null, noopSettingSetter];
                },
            },
        });
    },
});

vi.mock('@/components/ui/lists/flashListCompat/FlashListCompat', () => ({
    FlashList: (props: any) => windowingFlashList(props),
}));

vi.mock('react-native-reanimated', () => ({
    default: { View: (props: any) => React.createElement('Animated.View', props) },
    Easing: {
        bezier: () => () => 0,
        linear: () => 0,
    },
    useSharedValue: (init: any) => ({ value: init }),
    useAnimatedStyle: (fn: () => any) => fn(),
    useAnimatedReaction: () => undefined,
    withSpring: (value: any) => value,
    withTiming: (value: any) => value,
}));

vi.mock('react-native-gesture-handler', async () => {
    const { createGestureHandlerMock } = await import('@/dev/testkit/mocks/gestureHandler');
    return createGestureHandlerMock();
});

vi.mock('react-native-worklets', () => ({
    scheduleOnRN: (fn: (...args: any[]) => void, ...args: any[]) => fn(...args),
}));

vi.mock('react-native-safe-area-context', async (importOriginal) => ({
    ...await importOriginal<typeof import('react-native-safe-area-context')>(),
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('@/components/account/RecoveryKeyReminderBanner', () => ({
    RecoveryKeyReminderBanner: 'RecoveryKeyReminderBanner',
}));

vi.mock('@/components/ui/feedback/UpdateBanner', () => ({
    UpdateBanner: 'UpdateBanner',
}));

vi.mock('@/utils/sessions/sessionUtils', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/utils/sessions/sessionUtils')>();
    return {
        ...actual,
        getSessionName: () => 'Session',
        getSessionSubtitle: () => 'Subtitle',
        formatPathRelativeToHome: (path: string) => path,
        getSessionStatus: getSessionStatusMock,
        getSessionAvatarId: () => 'avatar',
        useSessionStatus: () => ({
            isConnected: true,
            statusText: 'Connected',
            statusColor: '#000',
            statusDotColor: '#0f0',
            isPulsing: false,
        }),
    };
});

vi.mock('@/components/ui/avatar/Avatar', () => ({
    Avatar: 'Avatar',
}));

vi.mock('@/components/ui/status/StatusDot', () => ({
    StatusDot: 'StatusDot',
}));

vi.mock('@/utils/platform/responsive', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/utils/platform/responsive')>();
    return {
        ...actual,
        useIsTablet: () => false,
        getDeviceType: () => 'phone',
    };
});

vi.mock('@/hooks/ui/useHappyAction', () => ({
    useHappyAction: (_fn: unknown) => [false, vi.fn()],
}));

vi.mock('@/sync/sync', () => ({
    sync: {
        fetchMoreSessions: fetchMoreSessionsMock,
        markSessionListScrollActivity: markSessionListScrollActivityMock,
    },
}));

vi.mock('@/components/markdown/enriched/preloadEnrichedMarkdownRuntime', () => ({
    preloadEnrichedMarkdownRuntime: preloadEnrichedMarkdownRuntimeSpy,
}));

vi.mock('@/sync/ops', async (importOriginal) => {
    const { createSyncOpsModuleMock } = await import('@/dev/testkit/mocks/syncOps');
    return createSyncOpsModuleMock({
        importOriginal,
        overrides: {
            sessionStopWithServerScope: vi.fn(async () => ({ success: true })),
            sessionArchiveWithServerScope: vi.fn(async () => ({ success: true })),
        },
    });
});

vi.mock('@/sync/ops/sessionMachineTarget', () => ({
    readMachineTargetForSession: () => null,
    readDisplayMachineTargetForSession: () => null,
}));

vi.mock('@/hooks/session/useNavigateToSession', () => ({
    useNavigateToSession: () => vi.fn(),
}));

vi.mock('@/hooks/server/useEffectiveServerSelection', () => {
    // Stable identities: `useFeatureDecision` feeds `selection.serverIds`
    // straight into `useServerFeaturesMainSelectionSnapshot`, whose effect
    // depends on that array. A fresh array per render re-fires that effect
    // every render and spins the list in an infinite re-render loop.
    const serverIds = ['server_a'];
    const effectiveSelection = { serverIds };
    const resolvedSelection = {
        enabled: true,
        presentation: 'grouped' as const,
        activeServerId: 'server_a',
        allowedServerIds: serverIds,
    };
    return {
        useEffectiveServerSelection: () => effectiveSelection,
        useResolvedActiveServerSelection: () => resolvedSelection,
    };
});

vi.mock('@/sync/domains/server/selection/serverSelectionResolution', () => ({
    resolveActiveServerSelectionFromRawSettings: () => ({
        enabled: true,
        presentation: 'grouped',
        activeServerId: 'server_a',
        allowedServerIds: ['server_a'],
    }),
    getEffectiveServerSelectionFromRawSettings: () => ({
        enabled: true,
        presentation: 'grouped',
        activeServerId: 'server_a',
        allowedServerIds: ['server_a'],
    }),
}));

vi.mock('@/hooks/session/useVisibleSessionListViewData', () => ({
    useVisibleSessionListViewData: () => mockVisibleSessionListViewData,
}));

vi.mock('@/utils/system/requestReview', () => ({
    requestReview: vi.fn(),
}));

vi.mock('./SessionItem', () => ({
    SessionItem: (props: any) => React.createElement('SessionItem', {
        ...props,
        testID: `session-list-session:${String(props.session?.id ?? 'unknown')}`,
    }),
}));

async function renderSessionsList() {
    const { SessionsList } = await import('./SessionsList');
    return renderScreen(<SessionsList />);
}

// ---------------------------------------------------------------------------
// (b)/(c) drag-model fixtures: a long single-workspace tree
// ---------------------------------------------------------------------------

const workspaceA: SessionFolderWorkspaceRefV1 = {
    t: 'workspaceScope',
    serverId: 'server-a',
    machineId: 'machine-a',
    rootPath: '/repo/a',
};

function projectHeaderItem(): Extract<SessionListIndexItem, { type: 'header' }> {
    return {
        type: 'header',
        title: 'project-a',
        headerKind: 'project',
        groupKey: 'project-a',
        workspaceKey: 'project-a',
        workspace: workspaceA,
        serverId: 'server-a',
    };
}

function folderHeaderItem(id: string): Extract<SessionListIndexItem, { type: 'header' }> {
    return {
        type: 'header',
        title: id,
        headerKind: 'folder',
        folderId: id,
        folderDepth: 0,
        groupKey: `project-a:folder:${id}`,
        workspace: workspaceA,
        serverId: 'server-a',
    };
}

function rootSessionItem(id: string): Extract<SessionListIndexItem, { type: 'session' }> {
    return {
        type: 'session',
        sessionId: id,
        serverId: 'server-a',
        storageKind: 'persisted',
        groupKey: 'project-a',
        groupKind: 'project',
        folderId: null,
        folderDepth: 0,
        workspace: workspaceA,
    };
}

function folderChildSessionItem(id: string, folderId: string): Extract<SessionListIndexItem, { type: 'session' }> {
    return {
        type: 'session',
        sessionId: id,
        serverId: 'server-a',
        storageKind: 'persisted',
        groupKey: `project-a:folder:${folderId}`,
        groupKind: 'folder',
        folderId,
        folderDepth: 1,
        workspace: workspaceA,
    };
}

/**
 * A long tree: a project header, many root sessions, then a folder near the
 * bottom with a child. With virtualization, the bottom folder header + the
 * dragged source are NOT mounted together — the drag must still resolve.
 */
function buildLongDragIndex(): SessionListIndexItem[] {
    const items: SessionListIndexItem[] = [projectHeaderItem()];
    for (let index = 0; index < 24; index += 1) {
        items.push(rootSessionItem(`root_${index}`));
    }
    items.push(folderHeaderItem('folder-bottom'));
    items.push(folderChildSessionItem('inside_bottom', 'folder-bottom'));
    return items;
}

function buildLongDragViewItems(index: ReadonlyArray<SessionListIndexItem>): SessionListViewItem[] {
    return index.map((item) => {
        if (item.type === 'header' && item.headerKind === 'project') {
            return {
                type: 'header',
                title: item.title,
                headerKind: 'project',
                groupKey: item.groupKey,
                serverId: 'server-a',
            } as SessionListViewItem;
        }
        if (item.type === 'header') {
            return {
                type: 'header',
                title: item.title,
                headerKind: 'folder',
                groupKey: item.groupKey,
                serverId: 'server-a',
            } as SessionListViewItem;
        }
        return {
            type: 'session',
            session: makeSession(item.sessionId),
            groupKey: item.groupKey,
            groupKind: item.groupKind,
            serverId: 'server-a',
        } as SessionListViewItem;
    });
}

const SESSION_ROW_HEIGHT = 84;
const FOLDER_HEADER_HEIGHT = 56; // headers are taller / variable-height

/**
 * Builds a `TreeContentRow` in scroll-content coordinates for a row at the
 * given index. Session rows are fixed-height; the folder header is taller —
 * a deliberately variable height so (c) exercises a non-uniform-height target.
 */
function contentRowAtIndex(params: Readonly<{
    rowId: string;
    index: number;
    height: number;
    parentId: string | null;
    containerId: string;
    depth: number;
    kind: 'leaf' | 'container';
}>): TreeContentRow {
    return {
        id: params.rowId,
        parentId: params.parentId,
        containerId: params.containerId,
        depth: params.depth,
        kind: params.kind,
        bounds: {
            x: 0,
            y: params.index * SESSION_ROW_HEIGHT,
            width: 320,
            height: params.height,
        },
    };
}

describe('SessionsList web virtualization', () => {
    beforeEach(() => {
        capturedWebFlatListProps = null;
        capturedWebFlashListProps = null;
        pinnedSessionKeysV1 = [];
        sessionTagsV1 = {};
        workspaceLabelsV1 = {};
        routerPushSpy.mockReset();
        setPinnedSessionKeysV1.mockClear();
        setSessionTagsV1.mockClear();
        setWorkspaceLabelsV1.mockClear();
        noopSettingSetter.mockClear();
        fetchMoreSessionsMock.mockClear();
        markSessionListScrollActivityMock.mockClear();
        preloadEnrichedMarkdownRuntimeSpy.mockClear();
        getSessionStatusMock.mockClear();
        mockVisibleSessionListViewData = buildLargeVisibleSessionListViewData();
    });

    afterEach(() => {
        standardCleanup();
    });

    // ----- (a) bounded mount ------------------------------------------------

    it('preloads the transcript markdown runtime before a session is opened from the web list', async () => {
        await renderSessionsList();

        expect(preloadEnrichedMarkdownRuntimeSpy).toHaveBeenCalledOnce();
    });

    it('does not mount every row of a large web session list', async () => {
        const screen = await renderSessionsList();

        const mountedSessionRows = screen.root.findAll((node) =>
            typeof node.props?.testID === 'string'
            && node.props.testID.startsWith('session-list-session:'));

        // The full list has 130 session rows; the FlashList-backed web path
        // mounts only a bounded slice around the viewport, never the whole list.
        expect(capturedWebFlashListProps).toBeTruthy();
        expect(capturedWebFlatListProps).toBeNull();
        expect(LARGE_SESSION_COUNT).toBe(130);
        expect(mountedSessionRows.length).toBeGreaterThan(0);
        expect(mountedSessionRows.length).toBeLessThan(LARGE_SESSION_COUNT);
    });

    it('uses FlashListCompat for large web session lists instead of React Native Web FlatList', async () => {
        await renderSessionsList();

        expect(capturedWebFlatListProps).toBeNull();
        expect(capturedWebFlashListProps).toBeTruthy();
        const props = capturedWebFlashListProps!;
        expect(props.getItemType?.(mockVisibleSessionListViewData[0], 0)).toBe('header:date');
        // Recycling pools are keyed on height class (body vs tail) + density
        // so recycled cells never reuse a stale height from a different
        // position, without remounting on first↔middle position flips.
        expect(props.getItemType?.(mockVisibleSessionListViewData[1], 1)).toBe('session:default:body');
        expect(props.getItemType?.(mockVisibleSessionListViewData[2], 2)).toBe('session:default:body');
        expect(props.scrollEventThrottle).toBe(32);
        expect(typeof props.overrideProps?.onWheel).toBe('function');
        expect(typeof props.overrideProps?.onTouchMove).toBe('function');
    });

    it('does not pass a full-list getItemLayout to the mixed-height web list', async () => {
        // Session rows are fixed-height but folder/project/collapsible and
        // search/primary headers are variable-height; a single-stride
        // getItemLayout would report wrong offsets for every header.
        await renderSessionsList();

        expect(capturedWebFlashListProps).toBeTruthy();
        expect(capturedWebFlashListProps!.getItemLayout).toBeUndefined();
    });

    it('does not enable removeClippedSubviews on the web list', async () => {
        // removeClippedSubviews on RN Web detaches clipped cells and drops row
        // measurements during fast scroll, which would undermine the content-
        // coordinate geometry the drag depends on.
        await renderSessionsList();

        expect(capturedWebFlashListProps).toBeTruthy();
        expect(Boolean(capturedWebFlashListProps!.removeClippedSubviews)).toBe(false);
    });

    it('keeps web load-more on the list end-reached path instead of scroll proximity', async () => {
        await renderSessionsList();

        expect(capturedWebFlashListProps).toBeTruthy();
        act(() => {
            capturedWebFlashListProps!.onScroll?.({
                nativeEvent: {
                    contentOffset: { y: 720 },
                    contentSize: { height: 1000 },
                    layoutMeasurement: { height: 240 },
                },
            });
        });

        expect(markSessionListScrollActivityMock).toHaveBeenCalledTimes(1);
        expect(fetchMoreSessionsMock).not.toHaveBeenCalled();
    });

    it('keeps long-web-list working row attention animations live without subscribing every attention row', async () => {
        const items: SessionListViewItem[] = [
            {
                type: 'header',
                title: 'Today',
                headerKind: 'date',
                groupKey,
                serverId: 'server_a',
                serverName: 'Server A',
            } as SessionListViewItem,
        ];
        for (let index = 0; index < 130; index += 1) {
            const isWorkingRow = index === 2;
            const isAttentionRow = index === 3;
            const isActiveOnlyRow = index === 4;
            items.push({
                type: 'session',
                session: makeSession(
                    isWorkingRow
                        ? 'long_working'
                        : isAttentionRow
                            ? 'long_attention'
                            : isActiveOnlyRow
                                ? 'long_active_only'
                                : `long_${index}`,
                    {
                        active: isWorkingRow || isActiveOnlyRow,
                        thinking: isWorkingRow,
                        latestTurnStatus: isWorkingRow ? 'in_progress' : undefined,
                    },
                ),
                groupKey,
                groupKind: 'date',
                serverId: 'server_a',
                serverName: 'Server A',
                attentionPromotionReason: isAttentionRow ? 'ready' : undefined,
                workingPlacementReason: isWorkingRow ? 'working' : undefined,
            } as SessionListViewItem);
        }
        mockVisibleSessionListViewData = items;

        const screen = await renderSessionsList();
        const firstSessionItem = capturedWebFlashListProps!.data.find((item: any) => item?.session?.id === 'long_0');
        await act(async () => {
            capturedWebFlashListProps!.onViewableItemsChanged?.({
                viewableItems: [{ isViewable: true, item: firstSessionItem }],
            });
        });

        const omittedMountedWorkingRow = screen.root.findByProps({ testID: 'session-list-session:long_working' });
        const omittedMountedAttentionRow = screen.root.findByProps({ testID: 'session-list-session:long_attention' });
        const omittedMountedActiveOnlyRow = screen.root.findByProps({ testID: 'session-list-session:long_active_only' });
        expect(omittedMountedWorkingRow.props.rowAttentionAnimationEnabled).toBe(true);
        expect(omittedMountedAttentionRow.props.rowAttentionAnimationEnabled).toBe(false);
        expect(omittedMountedActiveOnlyRow.props.rowAttentionAnimationEnabled).toBe(false);
    });

    it('keeps mounted web working rows subscribed when viewability omits them', async () => {
        const { syncPerformanceTelemetry } = await import('@/sync/runtime/syncPerformanceTelemetry');
        syncPerformanceTelemetry.configure({
            enabled: true,
            slowThresholdMs: 1_000_000,
            flushIntervalMs: 60_000,
        });
        syncPerformanceTelemetry.reset();

        try {
            const items: SessionListViewItem[] = [
                {
                    type: 'header',
                    title: 'Today',
                    headerKind: 'date',
                    groupKey,
                    serverId: 'server_a',
                    serverName: 'Server A',
                } as SessionListViewItem,
            ];
            for (let index = 0; index < 130; index += 1) {
                const isWorkingRow = index === 2;
                const isAttentionRow = index === 3;
                items.push({
                    type: 'session',
                    session: makeSession(
                        isWorkingRow
                            ? 'long_working'
                            : isAttentionRow
                                ? 'long_attention'
                                : `long_${index}`,
                        {
                            active: isWorkingRow,
                            thinking: isWorkingRow,
                            latestTurnStatus: isWorkingRow ? 'in_progress' : undefined,
                        },
                    ),
                    groupKey,
                    groupKind: 'date',
                    serverId: 'server_a',
                    serverName: 'Server A',
                    attentionPromotionReason: isAttentionRow ? 'ready' : undefined,
                    workingPlacementReason: isWorkingRow ? 'working' : undefined,
                } as SessionListViewItem);
            }
            mockVisibleSessionListViewData = items;

            const screen = await renderSessionsList();
            const firstSessionItem = capturedWebFlashListProps!.data.find((item: any) => item?.session?.id === 'long_0');
            syncPerformanceTelemetry.reset();
            await act(async () => {
                capturedWebFlashListProps!.onViewableItemsChanged?.({
                    viewableItems: [{ isViewable: true, item: firstSessionItem }],
                });
            });

            expect(screen.root.findByProps({ testID: 'session-list-session:long_working' }).props.rowAttentionAnimationEnabled).toBe(true);
            expect(screen.root.findByProps({ testID: 'session-list-session:long_attention' }).props.rowAttentionAnimationEnabled).toBe(false);

            const subscriptionEvent = syncPerformanceTelemetry.snapshot().events
                .filter((event) => event.name === 'ui.sessionsList.rowStoreSubscriptions')
                .at(-1);
            expect(subscriptionEvent?.fields).toEqual(expect.objectContaining({
                priorityAttentionRows: 1,
                prioritySubscribedRows: 1,
                priorityWorkingPlacementRows: 1,
                subscribedRows: 2,
                visibleRows: 1,
            }));
            const viewabilityEvent = syncPerformanceTelemetry.snapshot().events
                .filter((event) => event.name === 'ui.sessionsList.viewableRows.changed')
                .at(-1);
            expect(viewabilityEvent?.fields).toEqual(expect.objectContaining({
                changed: 1,
                nextVisibleRows: 1,
                previousKnown: 0,
                previousVisibleRows: 0,
            }));
        } finally {
            syncPerformanceTelemetry.configure({ enabled: false });
            syncPerformanceTelemetry.reset();
        }
    });

    it('keeps all small-web-list row attention animations live when viewability omits a mounted row', async () => {
        mockVisibleSessionListViewData = [
            {
                type: 'header',
                title: 'Today',
                headerKind: 'date',
                groupKey,
                serverId: 'server_a',
                serverName: 'Server A',
            } as SessionListViewItem,
            {
                type: 'session',
                session: makeSession('small_a', { active: true, thinking: true, latestTurnStatus: 'in_progress' }),
                groupKey,
                groupKind: 'date',
                serverId: 'server_a',
                serverName: 'Server A',
            } as SessionListViewItem,
            {
                type: 'session',
                session: makeSession('small_b', { active: true, thinking: true, latestTurnStatus: 'in_progress' }),
                groupKey,
                groupKind: 'date',
                serverId: 'server_a',
                serverName: 'Server A',
            } as SessionListViewItem,
        ];

        const screen = await renderSessionsList();
        const firstSessionItem = capturedWebFlatListProps!.data.find((item: any) => item?.session?.id === 'small_a');
        await act(async () => {
            capturedWebFlatListProps!.onViewableItemsChanged?.({
                viewableItems: [{ isViewable: true, item: firstSessionItem }],
            });
        });

        const omittedMountedRow = screen.root.findByProps({ testID: 'session-list-session:small_b' });
        expect(omittedMountedRow.props.rowAttentionAnimationEnabled).toBe(true);
    });

    it('keeps working session-list row status text static even when animated detail status text is enabled', async () => {
        const workingSession = makeSession('working', {
            active: true,
            activeAt: 2_000,
            thinking: true,
            thinkingAt: 2_000,
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: 2_000,
            presence: 'online',
        });
        mockVisibleSessionListViewData = [
            {
                type: 'header',
                title: 'Today',
                headerKind: 'date',
                groupKey,
                serverId: 'server_a',
                serverName: 'Server A',
            } as SessionListViewItem,
            {
                type: 'session',
                session: workingSession,
                groupKey,
                groupKind: 'date',
                serverId: 'server_a',
                serverName: 'Server A',
            } as SessionListViewItem,
        ];

        const screen = await renderSessionsList();
        const row = screen.root.findByProps({ testID: 'session-list-session:working' });

        expect(row.props.rowModel.status.statusText).toBe('status.working');
        expect(getSessionStatusMock).toHaveBeenCalledWith(
            expect.objectContaining({ id: 'working' }),
            expect.any(Number),
            expect.objectContaining({ workingTextMode: 'static' }),
        );
    });

    // ----- (b) drag after scroll -------------------------------------------

    it('resolves the correct target when dragging after the list has scrolled', async () => {
        const index = buildLongDragIndex();
        const viewItems = buildLongDragViewItems(index);

        // Drag starts on root_2 (near the top, mounted at drag start).
        const snapshot = buildSessionListDragSnapshot({
            items: index,
            viewItems,
            sessionDragKey: 'server-a:root_2',
            folderSortMode: 'mixed',
            foldersFeatureEnabled: true,
        });

        const registryHook = await renderHook(() => useTreeDropRegistry());
        const registry = registryHook.getCurrent();

        // The drop target root_18 was NOT mounted at drag start. It mounts only
        // after the user scrolls it into view; its content geometry is then
        // registered in content (scroll-stable) coordinates.
        const root18Index = 1 + 18; // header at index 0, root sessions follow
        registry.registerRow(contentRowAtIndex({
            rowId: treeRowId.session('server-a', 'root_18'),
            index: root18Index,
            height: SESSION_ROW_HEIGHT,
            parentId: null,
            containerId: treeRowId.workspaceRoot('project-a'),
            depth: 0,
            kind: 'leaf',
        }));

        // The list has scrolled down by 12 rows. The registry is NOT rebased —
        // content coordinates stay put; only the live viewport metric moves.
        const scrollOffsetY = 12 * SESSION_ROW_HEIGHT;
        const viewport: TreeViewportMetrics = {
            viewportWindowY: 0,
            viewportWindowX: 0,
            scrollOffsetY,
            viewportHeight: WINDOWING_VIEWPORT_ROW_COUNT * SESSION_ROW_HEIGHT,
        };

        // The pointer hovers near the bottom of root_18's on-screen rect. Its
        // window-Y, converted with the live scroll offset, lands inside the
        // row's content rect.
        const root18ContentTop = root18Index * SESSION_ROW_HEIGHT;
        const pointerWindowY = root18ContentTop + SESSION_ROW_HEIGHT - 8 - scrollOffsetY;

        const resolved = resolveSessionListDragPointer({
            snapshot,
            registry,
            pointer: { x: 160, y: pointerWindowY },
            viewport,
        });

        const instruction = resolved.result.instruction;
        expect(['reorder-before', 'reorder-after']).toContain(instruction.kind);
        if (instruction.kind === 'reorder-before' || instruction.kind === 'reorder-after') {
            expect(instruction.targetId).toBe(treeRowId.session('server-a', 'root_18'));
        }

        await registryHook.unmount();
    });

    // ----- (c) autoscroll to an offscreen variable-height folder header -----

    it('resolves an offscreen variable-height folder header reached by autoscroll', async () => {
        const index = buildLongDragIndex();
        const viewItems = buildLongDragViewItems(index);

        // Drag starts on root_1 — far above the bottom folder.
        const snapshot = buildSessionListDragSnapshot({
            items: index,
            viewItems,
            sessionDragKey: 'server-a:root_1',
            folderSortMode: 'mixed',
            foldersFeatureEnabled: true,
        });

        const registryHook = await renderHook(() => useTreeDropRegistry());
        const registry = registryHook.getCurrent();

        // The bottom folder header mounts only after autoscroll brings it into
        // view. Headers are variable-height: register it with a taller rect
        // than a session row, in content coordinates.
        const folderHeaderIndex = 1 + 24; // after the project header + 24 sessions
        registry.registerRow(contentRowAtIndex({
            rowId: treeRowId.folder('folder-bottom'),
            index: folderHeaderIndex,
            height: FOLDER_HEADER_HEIGHT,
            parentId: null,
            containerId: treeRowId.workspaceRoot('project-a'),
            depth: 0,
            kind: 'container',
        }));

        // Autoscroll has driven the list near the bottom. Registry is not
        // rebased; only the live scroll offset reflects the new position.
        const scrollOffsetY = 20 * SESSION_ROW_HEIGHT;
        const viewport: TreeViewportMetrics = {
            viewportWindowY: 0,
            viewportWindowX: 0,
            scrollOffsetY,
            viewportHeight: WINDOWING_VIEWPORT_ROW_COUNT * SESSION_ROW_HEIGHT,
        };

        // Pointer hovers the vertical centre of the folder header — its taller
        // rect; nesting a session into a folder is a centre-of-row outline.
        const folderHeaderContentTop = folderHeaderIndex * SESSION_ROW_HEIGHT;
        const pointerWindowY = folderHeaderContentTop + FOLDER_HEADER_HEIGHT / 2 - scrollOffsetY;

        const resolved = resolveSessionListDragPointer({
            snapshot,
            registry,
            pointer: { x: 160, y: pointerWindowY },
            viewport,
        });

        // The variable-height folder header is the resolved target even though
        // it was offscreen at drag start and mounted late during autoscroll.
        const instruction = resolved.result.instruction;
        expect(['nest-into', 'reorder-before', 'reorder-after']).toContain(instruction.kind);
        if (instruction.kind === 'nest-into') {
            expect(instruction.targetId).toBe(treeRowId.folder('folder-bottom'));
        } else if (instruction.kind === 'reorder-before' || instruction.kind === 'reorder-after') {
            expect(instruction.targetId).toBe(treeRowId.folder('folder-bottom'));
        }

        await registryHook.unmount();
    });

    it('keeps a folder-header content rect stable across scroll so a late mount still resolves', async () => {
        // Regression guard for the wrong-blue-line root cause (plan section
        // 1.4): a row registered once must resolve correctly at any later
        // scroll offset, because content bounds are never rebased on scroll.
        const index = buildLongDragIndex();
        const viewItems = buildLongDragViewItems(index);
        const snapshot = buildSessionListDragSnapshot({
            items: index,
            viewItems,
            sessionDragKey: 'server-a:root_0',
            folderSortMode: 'mixed',
            foldersFeatureEnabled: true,
        });

        const registryHook = await renderHook(() => useTreeDropRegistry());
        const registry = registryHook.getCurrent();

        const folderHeaderIndex = 1 + 24;
        const folderHeaderContentTop = folderHeaderIndex * SESSION_ROW_HEIGHT;
        registry.registerRow(contentRowAtIndex({
            rowId: treeRowId.folder('folder-bottom'),
            index: folderHeaderIndex,
            height: FOLDER_HEADER_HEIGHT,
            parentId: null,
            containerId: treeRowId.workspaceRoot('project-a'),
            depth: 0,
            kind: 'container',
        }));

        // Resolve at two different scroll offsets with a pointer aimed at the
        // same physical row centre — both must hit the folder header.
        for (const scrollRows of [8, 21]) {
            const scrollOffsetY = scrollRows * SESSION_ROW_HEIGHT;
            const viewport: TreeViewportMetrics = {
                viewportWindowY: 0,
                viewportWindowX: 0,
                scrollOffsetY,
                viewportHeight: WINDOWING_VIEWPORT_ROW_COUNT * SESSION_ROW_HEIGHT,
            };
            const pointerWindowY = folderHeaderContentTop + FOLDER_HEADER_HEIGHT / 2 - scrollOffsetY;
            const resolved = resolveSessionListDragPointer({
                snapshot,
                registry,
                pointer: { x: 160, y: pointerWindowY },
                viewport,
            });
            const instruction = resolved.result.instruction;
            expect(instruction.kind).not.toBe('idle');
            if (instruction.kind === 'nest-into'
                || instruction.kind === 'reorder-before'
                || instruction.kind === 'reorder-after') {
                expect(instruction.targetId).toBe(treeRowId.folder('folder-bottom'));
            }
        }

        await registryHook.unmount();
    });
});
