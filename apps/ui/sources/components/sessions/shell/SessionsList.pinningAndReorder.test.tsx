import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    findTestInstanceByTypeContainingText,
    invokeTestInstanceHandler,
    pressTestInstance,
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';
import { createCapturingFlatListMock } from '@/dev/testkit/mocks/flashList';
import { installSessionShellCommonModuleMocks } from './sessionShellTestHelpers';
import { buildSessionListIndexFromViewData, type SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { SessionListReachabilityRenderable } from '@/sync/domains/state/storage';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let capturedRootFlatListProps: any | null = null;
const routerPushSpy = vi.fn();
let hideInactiveSessions = false;

let pinnedSessionKeysV1: string[] = [];
const setPinnedSessionKeysV1 = vi.fn();

let sessionListGroupOrderV1: Record<string, string[]> = {};
const setSessionListGroupOrderV1 = vi.fn();

let sessionTagsV1: Record<string, string[]> = {};
const setSessionTagsV1 = vi.fn();
let workspaceRefsV1: any[] = [];
const setWorkspaceRefsV1 = vi.fn();
const readMachineTargetForSessionMock = vi.hoisted(() => vi.fn());
const mockMachinesState = vi.hoisted(() => ({ current: [] as any[] }));
const flatListMock = createCapturingFlatListMock({ renderItems: true });

const groupKey = 'server:server_a:day:2026-02-17';

const sessionA = {
    id: 'sess_a',
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
} as any;

const sessionB = {
    ...sessionA,
    id: 'sess_b',
} as any;

const sessionLive1 = {
    ...sessionA,
    id: 'sess_live_1',
    active: true,
    presence: 'online',
} as any;

const projectGroupKey = 'server:server_a:active:project:proj_a';

function findSessionFromVisibleViewData(sessionId: string): any | null {
    for (const item of mockVisibleSessionListViewData) {
        if (!item || item.type !== 'session') continue;
        const session = (item as any).session;
        if (session?.id === sessionId) return session;
    }
    return null;
}

function findSessionListRenderable(sessionId: string): SessionListRenderableSession | null {
    return (findSessionFromVisibleViewData(sessionId)
        ?? (sessionId === 'sess_a' ? sessionA : null)
        ?? (sessionId === 'sess_b' ? sessionB : null)
        ?? (sessionId === 'sess_live_1' ? sessionLive1 : null)) as SessionListRenderableSession | null;
}

installSessionShellCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: { OS: 'web', select: (value: any) => value.web ?? value.default },
            TurboModuleRegistry: { get: () => ({}) },
            FlatList: (props: any) => {
                const element = flatListMock.module.FlatList(props);
                capturedRootFlatListProps = flatListMock.state.props;
                return element;
            },
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
                    if (key === 'hideInactiveSessions') return hideInactiveSessions;
                    if (key === 'workspacePathDisplayModeV1') return 'path';
                    return null;
                },
                useHasUnreadMessages: () => false,
                useSession: () => null,
                useProfile: () => ({
                    id: 'profile-1',
                    timestamp: 0,
                    firstName: null,
                    lastName: null,
                    username: null,
                    avatar: null,
                    linkedProviders: [],
                    connectedServices: [],
                    connectedServicesV2: [],
                }),
                useAllMachines: () => mockMachinesState.current,
                useMachineDisplayById: () => Object.fromEntries(
                    mockMachinesState.current.map((machine) => [machine.id, machine]),
                ),
                useSettingMutable: (key: string) => {
                    if (key === 'pinnedSessionKeysV1') return [pinnedSessionKeysV1, setPinnedSessionKeysV1];
                    if (key === 'sessionListGroupOrderV1') return [sessionListGroupOrderV1, setSessionListGroupOrderV1];
                    if (key === 'sessionTagsV1') return [sessionTagsV1, setSessionTagsV1];
                    if (key === 'workspaceRefsV1') return [workspaceRefsV1, setWorkspaceRefsV1];
                    return [null, vi.fn()];
                },
                useSessionListRenderableWithServerScope: (_serverId: any, sessionId: string) => {
                    return findSessionListRenderable(sessionId);
                },
                useSessionListRowStateByServerId: () => ({
                    server_a: {
                        sess_a: sessionA,
                        sess_b: sessionB,
                        sess_live_1: sessionLive1,
                        ...(Object.fromEntries(
                            mockVisibleSessionListViewData
                                .filter((item: any) => item?.type === 'session')
                                .map((item: any) => [item.session.id, item.session]),
                        )),
                    },
                }) as any,
                useSessionListReachabilityRenderablesForItems: (
                    items: readonly SessionListIndexItem[] | null | undefined,
                ): ReadonlyMap<string, SessionListReachabilityRenderable> => {
                    const renderables = new Map<string, SessionListReachabilityRenderable>();
                    for (const item of items ?? []) {
                        if (item?.type !== 'session') continue;
                        const serverId = String(item.serverId ?? '').trim();
                        const sessionId = String(item.sessionId ?? '').trim();
                        if (!serverId || !sessionId) continue;
                        const session = findSessionListRenderable(sessionId);
                        if (!session) continue;
                        renderables.set(`${serverId}\u0000${sessionId}`, {
                            id: sessionId,
                            metadata: session.metadata ?? null,
                        });
                    }
                    return renderables;
                },
                useSessionListRowRenderablesForItems: (
                    items: readonly SessionListIndexItem[] | null | undefined,
                ): ReadonlyMap<string, SessionListRenderableSession> => {
                    const renderables = new Map<string, SessionListRenderableSession>();
                    for (const item of items ?? []) {
                        if (item?.type !== 'session') continue;
                        const serverId = String(item.serverId ?? '').trim();
                        const sessionId = String(item.sessionId ?? '').trim();
                        if (!serverId || !sessionId) continue;
                        const session = findSessionListRenderable(sessionId);
                        if (!session) continue;
                        renderables.set(`${serverId}:${sessionId}`, session);
                    }
                    return renderables;
                },
            },
        });
    },
});

vi.mock('react-native-gesture-handler', async () => {
    const { createGestureHandlerMock } = await import('@/dev/testkit/mocks/gestureHandler');
    return createGestureHandlerMock();
});

vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    return createReanimatedModuleMock();
});

vi.mock('react-native-worklets', () => ({
    scheduleOnRN: (fn: (...args: any[]) => void, ...args: any[]) => fn(...args),
}));

vi.mock('react-native-safe-area-context', async (importOriginal) => {
    const actual = await importOriginal<typeof import('react-native-safe-area-context')>();
    const React = await import('react');
    return {
        ...actual,
        SafeAreaInsetsContext: actual.SafeAreaInsetsContext ?? React.createContext({ top: 0, bottom: 0, left: 0, right: 0 }),
        useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    };
});

vi.mock('@/components/account/RecoveryKeyReminderBanner', () => ({
    RecoveryKeyReminderBanner: 'RecoveryKeyReminderBanner',
}));

vi.mock('@/components/ui/feedback/UpdateBanner', () => ({
    UpdateBanner: 'UpdateBanner',
}));

vi.mock('@/utils/sessions/sessionUtils', () => ({
    getSessionName: () => 'Session',
    getSessionSubtitle: () => 'Subtitle',
    formatPathRelativeToHome: (path: string) => path,
    getSessionAvatarId: () => 'avatar',
    getSessionStatus: () => ({
        isConnected: true,
        statusText: 'Connected',
        statusColor: '#000',
        statusDotColor: '#0f0',
        isPulsing: false,
    }),
    useSessionStatus: () => ({
        isConnected: true,
        statusText: 'Connected',
        statusColor: '#000',
        statusDotColor: '#0f0',
        isPulsing: false,
    }),
}));

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
    readMachineTargetForSession: (sessionId: string) => readMachineTargetForSessionMock(sessionId),
    readDisplayMachineTargetForSession: (input: { sessionId?: string | null; metadata?: { machineId?: string | null; path?: string | null } | null }) => {
        const sessionId = typeof input.sessionId === 'string' ? input.sessionId : '';
        const mockedTarget = sessionId ? readMachineTargetForSessionMock(sessionId) : null;
        if (mockedTarget) return mockedTarget;
        const metadata = input.metadata ?? null;
        return metadata?.machineId && metadata?.path
            ? { machineId: metadata.machineId, basePath: metadata.path }
            : null;
    },
}));

vi.mock('@/hooks/session/useNavigateToSession', () => ({
    useNavigateToSession: () => vi.fn(),
}));

let mockAllowedServerIds: string[] = ['server_a'];
vi.mock('@/hooks/server/useEffectiveServerSelection', () => ({
    useEffectiveServerSelection: () => ({
        serverIds: mockAllowedServerIds,
    }),
    useResolvedActiveServerSelection: () => ({
        enabled: true,
        presentation: 'grouped',
        activeServerId: 'server_a',
        allowedServerIds: mockAllowedServerIds,
    }),
}));

let mockVisibleSessionListViewData: any[] = [
    {
        type: 'header',
        title: 'Today',
        headerKind: 'date',
        groupKey,
        serverId: 'server_a',
        serverName: 'Server A',
    },
    {
        type: 'session',
        session: sessionA,
        groupKey,
        groupKind: 'date',
        serverId: 'server_a',
        serverName: 'Server A',
    },
    {
        type: 'session',
        session: sessionB,
        groupKey,
        groupKind: 'date',
        serverId: 'server_a',
        serverName: 'Server A',
    },
];

vi.mock('@/hooks/session/useVisibleSessionListPaneState', () => ({
    useVisibleSessionListPaneState: () => ({
        summary: {
            sessionsReady: true,
            sessionCount: mockVisibleSessionListViewData.filter((item) => item.type === 'session').length,
        },
        visibleSessionListIndex: buildSessionListIndexFromViewData(mockVisibleSessionListViewData),
        showLoading: false,
        showEmptyState: false,
    }),
}));

vi.mock('@/utils/system/requestReview', () => ({
    requestReview: vi.fn(),
}));

vi.mock('@/sync/domains/server/selection/serverSelectionResolution', () => ({
    resolveActiveServerSelectionFromRawSettings: () =>
        ({
            enabled: true,
            presentation: 'grouped',
            activeServerId: 'server_a',
            allowedServerIds: ['server_a'],
        }) as any,
    getEffectiveServerSelectionFromRawSettings: () =>
        ({
            enabled: true,
            presentation: 'grouped',
            activeServerId: 'server_a',
            allowedServerIds: ['server_a'],
        }) as any,
}));

vi.mock('./SessionItem', () => ({
    SessionItem: (props: any) => React.createElement('SessionItem', {
        ...props,
        testID: `session-list-session:${String(props.session?.id ?? 'unknown')}`,
    }),
}));

function resetVisibleSessionListViewData(): void {
    mockVisibleSessionListViewData = [
        {
            type: 'header',
            title: 'Today',
            headerKind: 'date',
            groupKey,
            serverId: 'server_a',
            serverName: 'Server A',
        },
        {
            type: 'session',
            session: sessionA,
            groupKey,
            groupKind: 'date',
            serverId: 'server_a',
            serverName: 'Server A',
        },
        {
            type: 'session',
            session: sessionB,
            groupKey,
            groupKind: 'date',
            serverId: 'server_a',
            serverName: 'Server A',
        },
    ];
}

async function renderSessionsList() {
    const { SessionsList } = await import('./SessionsList');
    return renderScreen(<SessionsList />);
}

function findSessionItem(
    screen: Awaited<ReturnType<typeof renderSessionsList>>,
    sessionId: string,
) {
    return screen.findByTestId(`session-list-session:${sessionId}`);
}

function expectPresent<T>(value: T | null | undefined, label: string): T {
    expect(value, label).toBeTruthy();
    if (value == null) {
        throw new Error(label);
    }
    return value;
}

describe('SessionsList pinning + per-group ordering', () => {
    beforeEach(() => {
        pinnedSessionKeysV1 = [];
        sessionListGroupOrderV1 = {};
        sessionTagsV1 = {};
        workspaceRefsV1 = [];
        setPinnedSessionKeysV1.mockClear();
        setSessionListGroupOrderV1.mockClear();
        setSessionTagsV1.mockClear();
        setWorkspaceRefsV1.mockClear();
        routerPushSpy.mockReset();
        mockAllowedServerIds = ['server_a'];
        capturedRootFlatListProps = null;
        hideInactiveSessions = false;
        readMachineTargetForSessionMock.mockReset();
        mockMachinesState.current = [];
        resetVisibleSessionListViewData();
    });

    afterEach(() => {
        standardCleanup();
    });

    it('renders the archived sessions footer on web and routes to archived sessions', async () => {
        const screen = await renderSessionsList();

        const footerPressable = expectPresent(
            findTestInstanceByTypeContainingText(screen.root, 'Pressable', 'sessionInfo.archivedSessions'),
            'expected archived sessions footer button',
        );

        await act(async () => {
            pressTestInstance(footerPressable, 'expected archived sessions footer button');
        });

        expect(routerPushSpy).toHaveBeenCalledWith('/session/archived');
    });

    it('renames the footer to inactive and archived sessions when hide inactive sessions is enabled', async () => {
        hideInactiveSessions = true;
        const screen = await renderSessionsList();

        const footerPressable = expectPresent(
            findTestInstanceByTypeContainingText(screen.root, 'Pressable', 'sessionInfo.inactiveAndArchivedSessions'),
            'expected inactive and archived sessions footer button',
        );

        await act(async () => {
            pressTestInstance(footerPressable, 'expected inactive and archived sessions footer button');
        });

        expect(routerPushSpy).toHaveBeenCalledWith('/session/archived');
    });

    it('stops wheel event propagation on web so session list scrolling is not blocked by document scroll-lock listeners', async () => {
        const screen = await renderSessionsList();

        expect(screen.root).toBeTruthy();
        expect(capturedRootFlatListProps).toBeTruthy();
        expect(typeof capturedRootFlatListProps?.onWheel).toBe('function');

        const stopPropagation = vi.fn();
        capturedRootFlatListProps?.onWheel?.({ stopPropagation });
        expect(stopPropagation).toHaveBeenCalledTimes(1);
    });

    it('uses coarser web scroll events for session-list scrolling', async () => {
        await renderSessionsList();

        expect(capturedRootFlatListProps?.scrollEventThrottle).toBe(32);
    });

    it('disables web FlatList virtualization for first-page-sized lists', async () => {
        await renderSessionsList();

        expect(capturedRootFlatListProps?.disableVirtualization).toBe(true);
    });

    it('disables web FlatList virtualization for medium lists', async () => {
        const header = expectPresent(
            mockVisibleSessionListViewData.find((item) => item.type === 'header'),
            'expected header item',
        );
        mockVisibleSessionListViewData = [
            header,
            ...Array.from({ length: 100 }, (_, index) => ({
                type: 'session',
                session: {
                    ...sessionA,
                    id: `sess_medium_${index}`,
                    updatedAt: sessionA.updatedAt + index,
                },
                groupKey,
                groupKind: 'date',
                serverId: 'server_a',
                serverName: 'Server A',
            })),
        ];

        await renderSessionsList();

        expect(capturedRootFlatListProps?.disableVirtualization).toBe(true);
    });

    it('keeps web FlatList virtualization enabled for large lists', async () => {
        const header = expectPresent(
            mockVisibleSessionListViewData.find((item) => item.type === 'header'),
            'expected header item',
        );
        mockVisibleSessionListViewData = [
            header,
            ...Array.from({ length: 130 }, (_, index) => ({
                type: 'session',
                session: {
                    ...sessionA,
                    id: `sess_large_${index}`,
                    updatedAt: sessionA.updatedAt + index,
                },
                groupKey,
                groupKind: 'date',
                serverId: 'server_a',
                serverName: 'Server A',
            })),
        ];

        await renderSessionsList();

        expect(capturedRootFlatListProps?.disableVirtualization).toBe(false);
    });

    it('passes session tags from settings into session items when enabled', async () => {
        sessionTagsV1 = { 'server_a:sess_a': ['important'] };
        const screen = await renderSessionsList();

        const row = expectPresent(
            findSessionItem(screen, 'sess_a'),
            'expected sess_a session row',
        );
        expect(row.props.tags).toEqual(['important']);
        expect(row.props.allKnownTags).toContain('important');
        expect(row.props.tagsEnabled).toBe(true);
    });

    it('reuses the same known-tag array when rerendered with identical tag contents', async () => {
        const { SessionsList: SessionsListComponent } = await import('./SessionsList');
        sessionTagsV1 = {
            'server_a:sess_a': ['important', 'review'],
            'server_a:sess_b': ['review', 'blocked'],
        };
        const screen = await renderSessionsList();

        const firstRow = expectPresent(
            findSessionItem(screen, 'sess_a'),
            'expected sess_a session row',
        );
        const firstKnownTags = firstRow.props.allKnownTags;

        sessionTagsV1 = {
            'server_a:sess_a': ['important', 'review'],
            'server_a:sess_b': ['review', 'blocked'],
        };

        await screen.update(<SessionsListComponent />);

        const updatedRow = expectPresent(
            findSessionItem(screen, 'sess_a'),
            'expected updated sess_a session row',
        );
        expect(updatedRow.props.allKnownTags).toBe(firstKnownTags);
        expect(updatedRow.props.allKnownTags).toEqual(['blocked', 'important', 'review']);
    });

    it('writes updated session tags back to settings as a value (not an updater function)', async () => {
        sessionTagsV1 = { 'server_a:sess_a': ['important'] };
        const screen = await renderSessionsList();

        const row = expectPresent(
            findSessionItem(screen, 'sess_a'),
            'expected sess_a session row',
        );

        invokeTestInstanceHandler(row, 'onSetTags', ['urgent'], 'expected sess_a session row');

        expect(setSessionTagsV1).toHaveBeenCalledTimes(1);
        expect(setSessionTagsV1.mock.calls[0]?.[0]).toEqual({
            'server_a:sess_a': ['urgent'],
        });
    });

    it('does not write session tags when the requested tags already match the current value', async () => {
        sessionTagsV1 = { 'server_a:sess_a': ['important'] };
        setSessionTagsV1.mockClear();
        const screen = await renderSessionsList();

        const row = expectPresent(
            findSessionItem(screen, 'sess_a'),
            'expected sess_a session row',
        );

        invokeTestInstanceHandler(row, 'onSetTags', ['important'], 'expected sess_a session row');

        expect(setSessionTagsV1).not.toHaveBeenCalled();
    });

    it('shows pinned server badges only when multiple servers are selected', async () => {
        pinnedSessionKeysV1 = ['server_a:sess_a'];
        sessionTagsV1 = {};
        const screen = await renderSessionsList();

        const pinnedRow = expectPresent(
            findSessionItem(screen, 'sess_a'),
            'expected pinned sess_a row',
        );
        expect(pinnedRow.props.pinned).toBe(true);
        expect(pinnedRow.props.showServerBadge).toBe(false);

        mockAllowedServerIds = ['server_a', 'server_b'];
        const updatedScreen = await renderSessionsList();

        const pinnedRow2 = expectPresent(
            findSessionItem(updatedScreen, 'sess_a'),
            'expected updated pinned sess_a row',
        );
        expect(pinnedRow2.props.showServerBadge).toBe(true);
    });

    it('wires pin toggling via pinnedSessionKeysV1', async () => {
        setPinnedSessionKeysV1.mockClear();

        const screen = await renderSessionsList();

        const row = expectPresent(
            findSessionItem(screen, 'sess_a'),
            'expected sess_a session row',
        );

        await act(async () => {
            invokeTestInstanceHandler(row, 'onTogglePinned', undefined, 'expected sess_a session row');
        });

        expect(setPinnedSessionKeysV1).toHaveBeenCalledTimes(1);
        expect(setPinnedSessionKeysV1).toHaveBeenCalledWith(['server_a:sess_a']);
    });

    it('does not render project headers and forces path/machine subtitles into rows', async () => {
        const sess1 = {
            ...sessionA,
            id: 'sess_p1',
            active: true,
            presence: 'online',
            metadata: { machineId: 'm1', host: 'Mac 1', path: '/home/u/repoA', homeDir: '/home/u' },
        } as any;

        const sess2 = {
            ...sessionA,
            id: 'sess_p2',
            active: true,
            presence: 'online',
            metadata: { machineId: 'm2', host: 'Mac 2', path: '/home/u/repoA', homeDir: '/home/u' },
        } as any;

        mockVisibleSessionListViewData = [
            { type: 'header', title: 'Active', headerKind: 'active', serverId: 'server_a', serverName: 'Server A' },
            {
                type: 'header',
                title: '~/repoA',
                headerKind: 'project',
                groupKey: projectGroupKey,
                serverId: 'server_a',
                serverName: 'Server A',
            },
            { type: 'session', session: sess1, groupKey: projectGroupKey, groupKind: 'project', variant: 'no-path', serverId: 'server_a', serverName: 'Server A' },
            { type: 'session', session: sess2, groupKey: projectGroupKey, groupKind: 'project', variant: 'no-path', serverId: 'server_a', serverName: 'Server A' },
        ];

        const screen = await renderSessionsList();

        expect(screen.findAll((node) => node.props?.accessibilityLabel === '~/repoA')).toHaveLength(1);

        const row1 = expectPresent(
            findSessionItem(screen, 'sess_p1'),
            'expected sess_p1 session row',
        );
        expect(row1.props.variant).toBe('no-path');
        expect(row1.props.subtitleOverride ?? null).toBe(null);
    });

    it('derives row subtitles from reachable machine targets when session metadata is stale after handoff', async () => {
        mockMachinesState.current = [
            { id: 'machine-live-1', metadata: { displayName: 'Rebound workstation' } },
            { id: 'machine-live-2', metadata: { host: 'rebound-2.local' } },
        ];

        const sess1 = {
            ...sessionA,
            id: 'sess_live_1',
            active: true,
            presence: 'online',
            metadata: { machineId: 'machine-stale-1', host: 'Old workstation', path: '/home/u/stale-a', homeDir: '/home/u' },
        } as any;

        const sess2 = {
            ...sessionA,
            id: 'sess_live_2',
            active: true,
            presence: 'online',
            metadata: { machineId: 'machine-stale-2', host: 'Old workstation 2', path: '/home/u/stale-b', homeDir: '/home/u' },
        } as any;

        readMachineTargetForSessionMock.mockImplementation((sessionId: string) => {
            if (sessionId === 'sess_live_1') {
                return { machineId: 'machine-live-1', basePath: '/home/u/live-a' };
            }
            if (sessionId === 'sess_live_2') {
                return { machineId: 'machine-live-2', basePath: '/home/u/live-b' };
            }
            return null;
        });

        mockVisibleSessionListViewData = [
            {
                type: 'header',
                title: 'Today',
                headerKind: 'date',
                groupKey,
                serverId: 'server_a',
                serverName: 'Server A',
            },
            { type: 'session', session: sess1, groupKey, groupKind: 'date', serverId: 'server_a', serverName: 'Server A' },
            { type: 'session', session: sess2, groupKey, groupKind: 'date', serverId: 'server_a', serverName: 'Server A' },
        ];

        const screen = await renderSessionsList();

        const row1 = expectPresent(
            findSessionItem(screen, 'sess_live_1'),
            'expected sess_live_1 session row',
        );
        const row2 = expectPresent(
            findSessionItem(screen, 'sess_live_2'),
            'expected sess_live_2 session row',
        );

        expect(row1.props.subtitleOverride).toBe('Rebound workstation · /home/u/live-a');
        expect(row2.props.subtitleOverride).toBe('rebound-2.local · /home/u/live-b');
    });

    it('uses renamed workspace labels for inactive date-grouped row subtitles', async () => {
        workspaceRefsV1 = [
            {
                id: 'workspace-ref-live-1',
                serverId: 'server_a',
                machineId: 'machine-live-1',
                rootPath: '/home/u/live-a',
                label: 'Renamed Workspace',
                createdAtMs: 1,
                lastOpenedAtMs: null,
            },
        ];

        const sess = {
            ...sessionA,
            id: 'sess_renamed_workspace',
            active: false,
            presence: 'offline',
            metadata: { machineId: 'machine-stale', host: 'Old workstation', path: '/home/u/stale-a', homeDir: '/home/u' },
        } as any;

        readMachineTargetForSessionMock.mockImplementation((sessionId: string) => {
            if (sessionId === 'sess_renamed_workspace') {
                return { machineId: 'machine-live-1', basePath: '/home/u/live-a' };
            }
            return null;
        });

        mockVisibleSessionListViewData = [
            {
                type: 'header',
                title: 'Today',
                headerKind: 'date',
                groupKey,
                serverId: 'server_a',
                serverName: 'Server A',
            },
            { type: 'session', session: sess, groupKey, groupKind: 'date', serverId: 'server_a', serverName: 'Server A' },
        ];

        const screen = await renderSessionsList();
        const row = expectPresent(
            findSessionItem(screen, 'sess_renamed_workspace'),
            'expected renamed workspace session row',
        );

        expect(row.props.subtitleOverride).toBe('Renamed Workspace');
        expect(row.props.subtitleEllipsizeMode).toBe('tail');
    });
});
