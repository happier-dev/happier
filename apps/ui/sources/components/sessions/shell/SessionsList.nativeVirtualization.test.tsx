import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { findGestureByKind, renderScreen, standardCleanup } from '@/dev/testkit';
import { SESSION_LIST_ROW_HEIGHT_DEFAULT } from './sessionListRowHeights';
import { installSessionShellCommonModuleMocks } from './sessionShellTestHelpers';
import { buildSessionListIndexFromViewData } from '@/sync/domains/sessionList/sessionListIndex';
import type { LocalSettings } from '@/sync/domains/settings/localSettings';
import { clearSessionListHeaderFilterRetentionForTests } from './search/useSessionListHeaderFilterRetention';
import { buildSessionOrganizationProjectionFromLegacyTestSettings } from './sessionOrganizationProjectionTestFixture';
import { createUseSettingMock, createUseSettingMutableMockFromReader } from '@/dev/testkit/mocks/storage';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let pinnedSessionKeysV1: string[] = [];
let sessionMruOrderV1: string[] = [];
const setSessionMruOrderV1 = vi.fn();
const readMachineTargetForSessionMock = vi.hoisted(() => vi.fn());
const navigateToSessionSpy = vi.hoisted(() => vi.fn());
const fetchMoreSessionsMock = vi.hoisted(() => vi.fn(async () => undefined));
const refreshSessionsMock = vi.hoisted(() => vi.fn<() => Promise<undefined>>(async () => undefined));
const markSessionListScrollActivityMock = vi.hoisted(() => vi.fn());
const preloadEnrichedMarkdownRuntimeSpy = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const setSessionPinOp = vi.hoisted(() => vi.fn(async () => undefined));
const setSessionTagAssignmentsOp = vi.hoisted(() => vi.fn(async () => undefined));
const keyboardShortcutHandlersRef = vi.hoisted(() => ({
    current: null as Record<string, (() => void)> | null,
}));
let mockPathname = '';
let platformOs: 'ios' | 'android' = 'ios';

let sessionTagsV1: Record<string, string[]> = {};
let sessionListOrderingModeV1: 'custom' | 'created' | 'updated' = 'custom';
const setSessionListOrderingModeV1 = vi.fn();
let workspacePathDisplayModeV1: 'name' | 'path' | null = null;
let workspaceRefsV1: any[] = [];
const setWorkspaceRefsV1 = vi.fn();
let collapsedGroupKeysV1: Record<string, boolean> = {};
const setCollapsedGroupKeysV1 = vi.fn();
const virtualizedListState = vi.hoisted(() => ({
    current: null as null | {
        props: any | null;
        refHandle: unknown;
    },
}));
let allMachines = [
    {
        id: 'machine-target',
        seq: 1,
        createdAt: 1,
        updatedAt: 10,
        active: true,
        activeAt: 10,
        metadata: {
            displayName: 'Rebound workstation',
            host: 'target.local',
            platform: 'darwin',
            happyCliVersion: '0.0.0',
            happyHomeDir: '/Users/test/.happier',
            homeDir: '/Users/test',
        },
        metadataVersion: 1,
        accessTokenEncrypted: null,
        accessTokenNonce: null,
        daemonState: null,
        daemonStateVersion: 1,
    },
    {
        id: 'machine-other',
        seq: 1,
        createdAt: 1,
        updatedAt: 5,
        active: true,
        activeAt: 5,
        metadata: {
            displayName: 'Other workstation',
            host: 'other.local',
            platform: 'darwin',
            happyCliVersion: '0.0.0',
            happyHomeDir: '/Users/test/.happier',
            homeDir: '/Users/test',
        },
        metadataVersion: 1,
        accessTokenEncrypted: null,
        accessTokenNonce: null,
        daemonState: null,
        daemonStateVersion: 1,
    },
];
let storageState: any = {
    sessions: {
        sess_a: {
            active: true,
            updatedAt: 10,
            metadata: {
                machineId: 'machine-stale',
                path: '/Users/test/stale-repo',
                homeDir: '/Users/test',
                host: 'stale.local',
            },
        },
        sess_b: {
            active: true,
            updatedAt: 5,
            metadata: {
                machineId: 'machine-other',
                path: '/Users/test/other-repo',
                homeDir: '/Users/test',
                host: 'other.local',
            },
        },
    },
    machines: {
        'machine-target': {
            id: 'machine-target',
            active: true,
            activeAt: 10,
            metadata: { displayName: 'Rebound workstation', host: 'target.local' },
        },
        'machine-other': {
            id: 'machine-other',
            active: true,
            activeAt: 5,
            metadata: { displayName: 'Other workstation', host: 'other.local' },
        },
    },
    getProjectForSession: (sessionId: string) =>
        sessionId === 'sess_a'
            ? {
                key: {
                    machineId: 'machine-target',
                    path: '/Volumes/target/repo',
                },
            }
            : null,
};

const groupKey = 'server:server_a:day:2026-02-17';

const sessionA = {
    id: 'sess_a',
    seq: 1,
    createdAt: 1,
    updatedAt: 1,
    active: false,
    activeAt: 0,
    metadata: {
        machineId: 'machine-stale',
        path: '/Users/test/stale-repo',
        homeDir: '/Users/test',
        host: 'stale.local',
    },
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
    metadata: {
        machineId: 'machine-other',
        path: '/Users/test/other-repo',
        homeDir: '/Users/test',
        host: 'other.local',
    },
} as any;

vi.mock('react-native-gesture-handler', async () => {
    const { createGestureHandlerMock } = await import('@/dev/testkit/mocks/gestureHandler');
    return createGestureHandlerMock();
});

vi.mock('react-native-safe-area-context', async (importOriginal) => {
    const actual = await importOriginal<typeof import('react-native-safe-area-context')>();
    const React = await import('react');
    return {
        ...actual,
        SafeAreaInsetsContext: actual.SafeAreaInsetsContext ?? React.createContext({ top: 0, bottom: 0, left: 0, right: 0 }),
        useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    };
});

vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    return createReanimatedModuleMock();
});

vi.mock('react-native-worklets', () => ({
    scheduleOnRN: (fn: (...args: any[]) => void, ...args: any[]) => fn(...args),
}));

vi.mock('@/constants/Typography', () => ({
    Typography: {
        default: () => ({}),
    },
}));

vi.mock('@legendapp/list/react-native', async () => {
    const legendListModule = (await import('@/dev/testkit/mocks/legendList')) as typeof import('@/dev/testkit/mocks/legendList');
    const mock = legendListModule.createCapturingLegendListMock({
        renderItems: true,
    });
    virtualizedListState.current = mock.state;
    return { LegendList: mock.module.LegendList };
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
    Octicons: 'Octicons',
}));

vi.mock('@/components/account/RecoveryKeyReminderBanner', () => ({
    RecoveryKeyReminderBanner: 'RecoveryKeyReminderBanner',
}));

vi.mock('@/components/ui/feedback/UpdateBanner', () => ({
    UpdateBanner: 'UpdateBanner',
}));

vi.mock('@/components/ui/layout/layout', () => ({
    layout: { maxWidth: 1280 },
    useLayoutMaxWidthStyle: () => ({ maxWidth: 1280 }),
    useLayoutMaxWidth: () => 1280,
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: any) => React.createElement('DropdownMenu', props),
}));

vi.mock('@/sync/domains/session/listing/sessionListOrderingStateV1', () => ({
    SESSION_LIST_GROUP_ORDER_MAX_KEYS_PER_GROUP: 50,
}));

vi.mock('@/sync/domains/session/listing/deriveSessionListActivity', () => ({
    resolveSessionListSecondaryLineMode: ({ groupKind }: { groupKind?: string | null }) =>
        groupKind === 'date' ? 'path' : 'status',
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

vi.mock('@/utils/platform/responsive', () => ({
    useIsTablet: () => false,
    getDeviceType: () => 'phone',
}));

installSessionShellCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                get OS() {
                    return platformOs;
                },
                select: (value: any) => value[platformOs] ?? value.default,
            },
            TurboModuleRegistry: { get: () => ({}) },
        });
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
            theme: {
                colors: {
                    groupped: { background: '#f7f7f7', sectionTitle: '#333' },
                    textSecondary: '#666',
                    divider: '#ddd',
                    accent: { blue: '#07f' },
                    surface: '#fff',
                    modal: { border: '#ddd' },
                    shadow: { color: '#000' },
                },
            },
        });
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({
            get pathname() {
                return mockPathname;
            },
        }).module;
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key: string) => key });
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock().module;
    },
    storage: async (importOriginal) => {
        const { createStorageModuleMock, createStorageStoreMock } = await import('@/dev/testkit/mocks/storage');
        const { buildMachineDisplayRenderableFromMachine } = await import('@/sync/domains/machines/machineDisplayRenderable');
        const resolveRowRenderableForTest = (serverId: unknown, sessionId: unknown) => {
            const normalizedServerId = typeof serverId === 'string' ? serverId.trim() : '';
            const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
            if (!normalizedSessionId) return null;
            const scopedRow = normalizedServerId
                ? storageState.sessionListRowStateByServerId?.[normalizedServerId]?.[normalizedSessionId]
                : null;
            return scopedRow ?? storageState.sessionListRenderables?.[normalizedSessionId] ?? null;
        };
        const buildRowRenderableMapForItems = (items: readonly any[] | null | undefined) => {
            const next = new Map<string, any>();
            for (const item of items ?? []) {
                if (!item || item.type !== 'session') continue;
                const serverId = typeof item.serverId === 'string' ? item.serverId.trim() : '';
                const sessionId = typeof item.sessionId === 'string' ? item.sessionId.trim() : '';
                if (!serverId || !sessionId) continue;
                const row = resolveRowRenderableForTest(serverId, sessionId);
                if (row) next.set(`${serverId}\u0000${sessionId}`, row);
            }
            return next;
        };
        const buildReachabilityRenderableMapForItems = (items: readonly any[] | null | undefined) => {
            const next = new Map<string, any>();
            for (const item of items ?? []) {
                if (!item || item.type !== 'session') continue;
                const serverId = typeof item.serverId === 'string' ? item.serverId.trim() : '';
                const sessionId = typeof item.sessionId === 'string' ? item.sessionId.trim() : '';
                if (!serverId || !sessionId) continue;
                const row = resolveRowRenderableForTest(serverId, sessionId);
                if (row) next.set(`${serverId}\u0000${sessionId}`, {
                    id: row.id,
                    metadata: row.metadata,
                });
            }
            return next;
        };
        return createStorageModuleMock({
            importOriginal,
            overrides: {
                useSetting: createUseSettingMock({ fallback: (key) => {
                    if (key === 'compactSessionView') return false;
                    if (key === 'compactSessionViewMinimal') return false;
                    if (key === 'sessionTagsEnabled') return true;
                    if (key === 'sessionListOrderingModeV1') return sessionListOrderingModeV1;
                    if (key === 'workspacePathDisplayModeV1') return workspacePathDisplayModeV1;
                    return null;
                } }),
                useHasUnreadMessages: () => false,
                useMachineDisplayById: () => Object.fromEntries(
                    allMachines.map((machine) => [machine.id, buildMachineDisplayRenderableFromMachine(machine as any)]),
                ),
                useSettingMutable: createUseSettingMutableMockFromReader((key) => {
                    if (key === 'sessionListOrderingModeV1') return [sessionListOrderingModeV1, setSessionListOrderingModeV1];
                    if (key === 'workspaceRefsV1') return [workspaceRefsV1, setWorkspaceRefsV1];
                    return [null, vi.fn()];
                }),
                useLocalSettingMutable: <K extends keyof LocalSettings>(key: K): [LocalSettings[K], (value: LocalSettings[K]) => void] => {
                    const value = key === 'sessionMruOrderV1'
                        ? [sessionMruOrderV1, setSessionMruOrderV1]
                        : key === 'collapsedGroupKeysV1'
                            ? [collapsedGroupKeysV1, setCollapsedGroupKeysV1]
                            : [null, vi.fn()];
                    return value as unknown as [LocalSettings[K], (value: LocalSettings[K]) => void];
                },
                useSessionOrganizationProjection: () => buildSessionOrganizationProjectionFromLegacyTestSettings({
                    serverId: 'server_a',
                    pinnedSessionKeysV1,
                    sessionTagsV1,
                }),
                useSessionListRenderableWithServerScope: (_serverId: any, sessionId: string) => {
                    if (sessionId === 'sess_a') return sessionA as any;
                    if (sessionId === 'sess_b') return sessionB as any;
                    return null;
                },
                useSessionListReachabilityRenderablesForItems: buildReachabilityRenderableMapForItems,
                useSessionListRowRenderablesForItems: buildRowRenderableMapForItems,
                useSessionListRowStateByServerId: () => ({
                    server_a: {
                        sess_a: sessionA,
                        sess_b: sessionB,
                    },
                }) as any,
                storage: createStorageStoreMock(storageState),
            },
        });
    },
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

vi.mock('@/sync/sync', () => ({
    sync: {
        fetchMoreSessions: fetchMoreSessionsMock,
        refreshSessions: refreshSessionsMock,
        markSessionListScrollActivity: markSessionListScrollActivityMock,
    },
}));

vi.mock('@/components/markdown/enriched/preloadEnrichedMarkdownRuntime', () => ({
    preloadEnrichedMarkdownRuntime: preloadEnrichedMarkdownRuntimeSpy,
}));

vi.mock('@/sync/ops/sessionOrganization', () => ({
    resolveSessionOrganizationMutationScope: async (serverId: string) => ({
        ok: true,
        scope: {
            credentials: { token: 'test-token' },
            serverId,
            serverIdAliases: [],
            serverUrl: 'https://server-a.example.test',
        },
    }),
    writeSessionOrganizationFolderAssignment: vi.fn(async () => undefined),
    writeSessionOrganizationFolders: vi.fn(async () => undefined),
    writeSessionOrganizationGroupOrder: vi.fn(async () => undefined),
    writeSessionOrganizationPin: setSessionPinOp,
    writeSessionOrganizationPinForSessionKey: setSessionPinOp,
    writeSessionOrganizationTagLabels: setSessionTagAssignmentsOp,
    writeSessionOrganizationTagLabelsForSessionKey: setSessionTagAssignmentsOp,
    writeSessionOrganizationWorkspaceLabels: vi.fn(async () => undefined),
    writeSessionOrganizationWorkspaceOrder: vi.fn(async () => undefined),
}));

vi.mock('@/sync/domains/server/serverProfiles', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/domains/server/serverProfiles')>();
    const serverProfile = { id: 'server_a', serverUrl: 'https://server-a.example.test' };
    return {
        ...actual,
        listServerProfiles: () => [serverProfile],
        getServerProfileById: (serverId: string) => (serverId === serverProfile.id ? serverProfile : null),
    };
});

vi.mock('@/auth/storage/tokenStorage', () => ({
    TokenStorage: {
        getCredentialsForServerUrl: vi.fn(async () => ({ token: 'test-token' })),
    },
}));

vi.mock('@/sync/ops/sessionMachineTarget', () => ({
    readMachineTargetForSession: (sessionId: string) => readMachineTargetForSessionMock(sessionId),
    readDisplayMachineTargetForSession: (input: { sessionId?: string | null; metadata?: { machineId?: string | null; path?: string | null } | null }) => {
        const sessionId = typeof input.sessionId === 'string' ? input.sessionId : '';
        const mockedTarget = sessionId ? readMachineTargetForSessionMock(sessionId) : null;
        if (mockedTarget) return mockedTarget;
        const project = sessionId ? storageState.getProjectForSession?.(sessionId) : null;
        const metadata = (sessionId ? storageState.sessions?.[sessionId]?.metadata : null) ?? input.metadata ?? null;
        const machineId = project?.key?.machineId ?? metadata?.machineId ?? null;
        const basePath = project?.key?.path ?? metadata?.path ?? null;
        return machineId && basePath ? { machineId, basePath } : null;
    },
}));

vi.mock('@/hooks/session/useNavigateToSession', () => ({
    useNavigateToSession: () => navigateToSessionSpy,
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (featureId: string) => featureId === 'sessions.folders',
}));

vi.mock('@/keyboard/KeyboardShortcutProvider', () => ({
    useKeyboardShortcutHandlers: (handlers: Record<string, () => void>) => {
        keyboardShortcutHandlersRef.current = {
            ...(keyboardShortcutHandlersRef.current ?? {}),
            ...handlers,
        };
        return true;
    },
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
    await vi.resetModules();
    const { SessionsList } = await import('./SessionsList');
    return renderScreen(<SessionsList />);
}

async function renderSessionsListWithSurfaceOwnership(surfaceOwnership: Readonly<{
    interactive?: boolean;
    dataActive?: boolean;
    visible?: boolean;
}>) {
    await vi.resetModules();
    const { SessionsList } = await import('./SessionsList');
    return renderScreen(<SessionsList surfaceOwnership={surfaceOwnership} />);
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

function findFirstDropdownMenuItems(screen: Awaited<ReturnType<typeof renderSessionsList>>): any[] {
    const menus = screen.findAll((node) => String(node.type) === 'DropdownMenu');
    for (const menu of menus) {
        const items = (menu.props as any)?.items;
        if (!Array.isArray(items)) continue;
        if (items.some((i: any) => i?.id === 'rename')) {
            return items;
        }
    }
    return [];
}

function findDropdownByItemTitle(
    screen: Awaited<ReturnType<typeof renderSessionsList>>,
    title: string,
) {
    return screen.root.findAll((node) =>
        String(node.type) === 'DropdownMenu'
        && Array.isArray((node.props as any)?.items)
        && (node.props as any).items.some((item: any) => item.title === title)
    )[0] ?? null;
}

function findRecordedGestureDetectors(
    screen: Awaited<ReturnType<typeof renderSessionsList>>,
) {
    return screen.root.findAll((node) =>
        String(node.type) === 'GestureDetector' && Boolean(findGestureByKind(node.props.gesture, 'pan'))
    );
}

describe('SessionsList (native virtualization)', () => {
    beforeEach(async () => {
        virtualizedListState.current = null;
        sessionListOrderingModeV1 = 'custom';
        mockPathname = '';
        pinnedSessionKeysV1 = [];
        sessionMruOrderV1 = [];
        sessionTagsV1 = {};
        workspaceRefsV1 = [];
        collapsedGroupKeysV1 = {};
        setSessionMruOrderV1.mockClear();
        setSessionListOrderingModeV1.mockClear();
        setWorkspaceRefsV1.mockClear();
        setCollapsedGroupKeysV1.mockClear();
        setSessionPinOp.mockClear();
        setSessionTagAssignmentsOp.mockClear();
        navigateToSessionSpy.mockClear();
        fetchMoreSessionsMock.mockClear();
        refreshSessionsMock.mockReset();
        refreshSessionsMock.mockResolvedValue(undefined);
        markSessionListScrollActivityMock.mockClear();
        preloadEnrichedMarkdownRuntimeSpy.mockClear();
        keyboardShortcutHandlersRef.current = null;
        clearSessionListHeaderFilterRetentionForTests();
        const { resetSessionListPaneRetentionForTests } = await import('./sessionListPaneRetention');
        resetSessionListPaneRetentionForTests();
        mockAllowedServerIds = ['server_a'];
        platformOs = 'ios';
        workspacePathDisplayModeV1 = null;
        readMachineTargetForSessionMock.mockReset();
        readMachineTargetForSessionMock.mockImplementation(() => null);
        resetVisibleSessionListViewData();
        storageState.sessionListRenderables = {
            sess_a: sessionA,
            sess_b: sessionB,
        };
        storageState.sessionListRowStateByServerId = {
            server_a: {
                sess_a: sessionA,
                sess_b: sessionB,
            },
        };
    });

    afterEach(() => {
        standardCleanup();
    });

    it('preloads the transcript markdown runtime before a session is opened from the list', async () => {
        await renderSessionsList();
        expect(preloadEnrichedMarkdownRuntimeSpy).toHaveBeenCalledOnce();
    });

    it('renders session items with correct adjacency props on native', async () => {
        const screen = await renderSessionsList();
        const first = expectPresent(findSessionItem(screen, 'sess_a'), 'expected sess_a session row');
        const second = expectPresent(findSessionItem(screen, 'sess_b'), 'expected sess_b session row');
        expect(screen.findAllByTestId('session-list-session:sess_a')).toHaveLength(1);
        expect(screen.findAllByTestId('session-list-session:sess_b')).toHaveLength(1);
        expect(first.props.isFirst).toBe(true);
        expect(first.props.isLast).toBe(false);
        expect(second.props.isFirst).toBe(false);
        expect(second.props.isLast).toBe(true);
    });

    it('expands the header search input and collapses it on blur when empty', async () => {
        mockVisibleSessionListViewData = [
            {
                type: 'header',
                title: 'Active',
                headerKind: 'active',
                groupKey: 'active',
                serverId: 'server_a',
                serverName: 'Server A',
            },
            {
                type: 'session',
                session: sessionA,
                groupKey: 'active',
                groupKind: 'active',
                serverId: 'server_a',
                serverName: 'Server A',
            },
        ];

        const screen = await renderSessionsList();
        expect(screen.findAllByTestId('session-list-search-input')).toHaveLength(0);

        await act(async () => {
            expectPresent(
                screen.findByTestId('session-list-search-trigger'),
                'expected collapsed search trigger',
            ).props.onPress?.({ stopPropagation: vi.fn() });
        });

        const input = expectPresent(
            screen.findByTestId('session-list-search-input'),
            'expected expanded search input',
        );
        expect(input.props.autoFocus).toBe(true);

        await act(async () => {
            input.props.onBlur?.();
        });

        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 60));
        });

        expect(screen.findAllByTestId('session-list-search-input')).toHaveLength(0);
    });

    it.each([
        { headerKind: 'attention' as const, groupKind: 'attention' as const, title: 'Needs Attention' },
        { headerKind: 'working' as const, groupKind: 'working' as const, title: 'Working' },
    ])('shows the header controls on the $headerKind placement group when it is the first visible section', async ({ headerKind, groupKind, title }) => {
        mockVisibleSessionListViewData = [
            {
                type: 'header',
                title,
                headerKind,
                groupKey: headerKind,
                serverId: 'server_a',
                serverName: 'Server A',
            },
            {
                type: 'session',
                session: sessionA,
                groupKey: headerKind,
                groupKind,
                serverId: 'server_a',
                serverName: 'Server A',
            },
        ];

        const screen = await renderSessionsList();

        expect(screen.findAllByTestId('session-list-search-trigger')).toHaveLength(1);
        expect(screen.findAll((node) =>
            String(node.type) === 'DropdownMenu'
            && Array.isArray((node.props as any)?.items)
            && (node.props as any).items.some((item: any) => item?.id === 'activeGroupingProject')
        )).toHaveLength(1);
    });

    it('keeps the header search input open with text and filters visible sessions', async () => {
        mockVisibleSessionListViewData = [
            {
                type: 'header',
                title: 'Active',
                headerKind: 'active',
                groupKey: 'active',
                serverId: 'server_a',
                serverName: 'Server A',
            },
            {
                type: 'session',
                session: sessionA,
                groupKey: 'active',
                groupKind: 'active',
                serverId: 'server_a',
                serverName: 'Server A',
            },
            {
                type: 'session',
                session: sessionB,
                groupKey: 'active',
                groupKind: 'active',
                serverId: 'server_a',
                serverName: 'Server A',
            },
        ];

        const screen = await renderSessionsList();
        await act(async () => {
            expectPresent(
                screen.findByTestId('session-list-search-trigger'),
                'expected collapsed search trigger',
            ).props.onPress?.({ stopPropagation: vi.fn() });
        });

        const input = expectPresent(
            screen.findByTestId('session-list-search-input'),
            'expected expanded search input',
        );
        await act(async () => {
            input.props.onChangeText?.('sess_b');
            input.props.onBlur?.();
        });

        expect(screen.findAllByTestId('session-list-search-input').length).toBeGreaterThan(0);
        expect(screen.findAllByTestId('session-list-session:sess_a')).toHaveLength(0);
        expect(screen.findAllByTestId('session-list-session:sess_b')).toHaveLength(1);
    });

    it('retains active header search filters across a route-level remount', async () => {
        mockVisibleSessionListViewData = [
            {
                type: 'header',
                title: 'Active',
                headerKind: 'active',
                groupKey: 'active',
                serverId: 'server_a',
                serverName: 'Server A',
            },
            {
                type: 'session',
                session: sessionA,
                groupKey: 'active',
                groupKind: 'active',
                serverId: 'server_a',
                serverName: 'Server A',
            },
            {
                type: 'session',
                session: sessionB,
                groupKey: 'active',
                groupKind: 'active',
                serverId: 'server_a',
                serverName: 'Server A',
            },
        ];

        const screen = await renderSessionsList();
        await act(async () => {
            expectPresent(
                screen.findByTestId('session-list-search-trigger'),
                'expected collapsed search trigger',
            ).props.onPress?.({ stopPropagation: vi.fn() });
        });
        await act(async () => {
            expectPresent(
                screen.findByTestId('session-list-search-input'),
                'expected expanded search input',
            ).props.onChangeText?.('sess_b');
        });

        expect(screen.findAllByTestId('session-list-session:sess_a')).toHaveLength(0);
        expect(screen.findAllByTestId('session-list-session:sess_b')).toHaveLength(1);

        standardCleanup();
        const { SessionsList } = await import('./SessionsList');
        const remounted = await renderScreen(<SessionsList />);

        const retainedInput = expectPresent(
            remounted.findByTestId('session-list-search-input'),
            'expected retained search input after remount',
        );
        expect(retainedInput.props.value).toBe('sess_b');
        expect(remounted.findAllByTestId('session-list-session:sess_a')).toHaveLength(0);
        expect(remounted.findAllByTestId('session-list-session:sess_b')).toHaveLength(1);
    });

    it('keeps the header search control anchored to the section that opened it', async () => {
        mockVisibleSessionListViewData = [
            {
                type: 'header',
                title: 'Pinned',
                headerKind: 'pinned',
                groupKey: 'pinned',
                serverId: 'server_a',
                serverName: 'Server A',
            },
            {
                type: 'session',
                session: sessionA,
                groupKey: 'pinned',
                groupKind: 'pinned',
                serverId: 'server_a',
                serverName: 'Server A',
            },
            {
                type: 'header',
                title: 'Active',
                headerKind: 'active',
                groupKey: 'active',
                serverId: 'server_a',
                serverName: 'Server A',
            },
            {
                type: 'session',
                session: sessionB,
                groupKey: 'active',
                groupKind: 'active',
                serverId: 'server_a',
                serverName: 'Server A',
            },
        ];

        const screen = await renderSessionsList();
        const searchTriggers = screen.findAllByTestId('session-list-search-trigger');
        expect(searchTriggers).toHaveLength(2);

        await act(async () => {
            expectPresent(
                searchTriggers[1],
                'expected active header search trigger',
            ).props.onPress?.({ stopPropagation: vi.fn() });
        });

        const input = expectPresent(
            screen.findByTestId('session-list-search-input'),
            'expected expanded top header search input',
        );
        await act(async () => {
            input.props.onChangeText?.('sess_b');
        });

        expect(screen.findAllByTestId('session-list-search-input').length).toBeGreaterThan(0);
        expect(screen.findAllByTestId('session-list-session:sess_a')).toHaveLength(0);
        expect(screen.findAllByTestId('session-list-session:sess_b')).toHaveLength(1);
    });

    it('keeps focused search open when clearing the last character after no results', async () => {
        mockVisibleSessionListViewData = [
            {
                type: 'header',
                title: 'Pinned',
                headerKind: 'pinned',
                groupKey: 'pinned',
                serverId: 'server_a',
                serverName: 'Server A',
            },
            {
                type: 'session',
                session: sessionA,
                groupKey: 'pinned',
                groupKind: 'pinned',
                serverId: 'server_a',
                serverName: 'Server A',
            },
            {
                type: 'header',
                title: 'Active',
                headerKind: 'active',
                groupKey: 'active',
                serverId: 'server_a',
                serverName: 'Server A',
            },
            {
                type: 'session',
                session: sessionB,
                groupKey: 'active',
                groupKind: 'active',
                serverId: 'server_a',
                serverName: 'Server A',
            },
        ];

        const screen = await renderSessionsList();
        const searchTriggers = screen.findAllByTestId('session-list-search-trigger');
        expect(searchTriggers).toHaveLength(2);

        await act(async () => {
            expectPresent(
                searchTriggers[1],
                'expected active header search trigger',
            ).props.onPress?.({ stopPropagation: vi.fn() });
        });

        await act(async () => {
            expectPresent(
                screen.findByTestId('session-list-search-input'),
                'expected expanded active header search input',
            ).props.onChangeText?.('z');
        });

        expect(screen.findAllByTestId('session-list-session:sess_a')).toHaveLength(0);
        expect(screen.findAllByTestId('session-list-session:sess_b')).toHaveLength(0);

        await act(async () => {
            const inputBeforeClear = expectPresent(
                screen.findByTestId('session-list-search-input'),
                'expected search input to remain available before clearing',
            );
            inputBeforeClear.props.onChangeText?.('');
            inputBeforeClear.props.onBlur?.();
        });

        const inputAfterClear = expectPresent(
            screen.findByTestId('session-list-search-input'),
            'expected focused search input to stay mounted after clearing',
        );
        expect(inputAfterClear.props.value).toBe('');
        expect(screen.findAllByTestId('session-list-session:sess_a')).toHaveLength(1);
        expect(screen.findAllByTestId('session-list-session:sess_b')).toHaveLength(1);
    });

    it('shows the header tag filter when known tags exist and filters by any selected tag', async () => {
        sessionTagsV1 = { 'server_a:sess_a': ['important'], 'server_a:sess_b': ['later'] };
        mockVisibleSessionListViewData = [
            {
                type: 'header',
                title: 'Active',
                headerKind: 'active',
                groupKey: 'active',
                serverId: 'server_a',
                serverName: 'Server A',
            },
            {
                type: 'session',
                session: sessionA,
                groupKey: 'active',
                groupKind: 'active',
                serverId: 'server_a',
                serverName: 'Server A',
            },
            {
                type: 'session',
                session: sessionB,
                groupKey: 'active',
                groupKind: 'active',
                serverId: 'server_a',
                serverName: 'Server A',
            },
        ];

        const screen = await renderSessionsList();
        const tagMenu = expectPresent(
            findDropdownByItemTitle(screen, 'important'),
            'expected tag filter dropdown',
        );
        const importantItem = expectPresent(
            tagMenu.props.items.find((item: any) => item.title === 'important'),
            'expected important tag filter item',
        );

        await act(async () => {
            tagMenu.props.onSelect?.(importantItem.id);
        });

        expect(screen.findAllByTestId('session-list-session:sess_a')).toHaveLength(1);
        expect(screen.findAllByTestId('session-list-session:sess_b')).toHaveLength(0);
    });

    it('wraps iOS rows in a full-row drag gesture without exposing a hidden reorder handle', async () => {
        const screen = await renderSessionsList();

        const first = expectPresent(findSessionItem(screen, 'sess_a'), 'expected sess_a session row');
        expect(first.props.reorderHandleGesture).toBeUndefined();
        expect(first.props.nativeInlineDragEnabled).toBe(true);

        const nativeRowGestureDetectors = findRecordedGestureDetectors(screen);
        expect(nativeRowGestureDetectors).toHaveLength(2);
        expect(findGestureByKind(nativeRowGestureDetectors[0]?.props.gesture, 'pan')).toBeTruthy();
        const nativeRowWrapper = expectPresent(
            nativeRowGestureDetectors[0]?.children[0],
            'expected native row gesture wrapper',
        );
        expect(typeof nativeRowWrapper).not.toBe('string');
        if (typeof nativeRowWrapper === 'string') {
            throw new Error('expected native row gesture wrapper element');
        }
        expect(String(nativeRowWrapper.type)).toContain('Animated.View');
        expect(nativeRowWrapper.props.collapsable).toBe(false);
    });

    it('uses a plain row bounds wrapper on Android where full-row inline drag is disabled', async () => {
        platformOs = 'android';

        const screen = await renderSessionsList();
        const first = expectPresent(findSessionItem(screen, 'sess_a'), 'expected sess_a session row');
        let rowWrapper: typeof first.parent | null = first.parent;
        while (rowWrapper && rowWrapper.props?.collapsable !== false) {
            rowWrapper = rowWrapper.parent;
        }
        rowWrapper = expectPresent(rowWrapper, 'expected session row bounds wrapper');

        expect(first.props.reorderHandleGesture).toBeUndefined();
        expect(first.props.nativeInlineDragEnabled).toBeUndefined();
        expect(findRecordedGestureDetectors(screen)).toHaveLength(0);
        expect(String(rowWrapper.type)).toBe('View');
        expect(rowWrapper.props.collapsable).toBe(false);
    });

    it('opens the iOS native context menu immediately when the row long-press gesture activates', async () => {
        const screen = await renderSessionsList();
        const initialListProps = virtualizedListState.current?.props;
        expect(initialListProps).toBeTruthy();
        const initialRenderItem = initialListProps?.renderItem;
        const initialExtraData = initialListProps?.extraData;
        const firstGesture = expectPresent(
            findRecordedGestureDetectors(screen)[0]?.props.gesture,
            'expected recorded native row gesture',
        );
        const longPress = findGestureByKind(firstGesture, 'longPress');

        expect(longPress?.__handlers.onStart).toBeTruthy();

        await act(async () => {
            longPress?.__handlers.onStart?.({});
        });

        const open = expectPresent(findSessionItem(screen, 'sess_a'), 'expected sess_a session row');
        expect(open.props.nativeContextMenuOpen).toBe(true);
        const openListProps = virtualizedListState.current?.props;
        expect(openListProps?.renderItem).toBe(initialRenderItem);
        expect(openListProps?.extraData).not.toBe(initialExtraData);

        await act(async () => {
            open.props.onNativeContextMenuOpenChange(false);
        });

        const closed = expectPresent(findSessionItem(screen, 'sess_a'), 'expected sess_a session row after close');
        expect(closed.props.nativeContextMenuOpen).toBe(false);
    });

    it('suppresses iOS native context menu activation while the native list is being scrolled', async () => {
        const screen = await renderSessionsList();
        const listProps = virtualizedListState.current?.props;
        const firstGesture = expectPresent(
            findRecordedGestureDetectors(screen)[0]?.props.gesture,
            'expected recorded native row gesture',
        );
        const longPress = findGestureByKind(firstGesture, 'longPress');

        expect(typeof listProps?.onScrollBeginDrag).toBe('function');
        expect(typeof listProps?.onScrollEndDrag).toBe('function');

        await act(async () => {
            listProps?.onScrollBeginDrag?.();
            longPress?.__handlers.onBegin?.({});
            longPress?.__handlers.onStart?.({});
        });

        const suppressed = expectPresent(
            findSessionItem(screen, 'sess_a'),
            'expected sess_a session row after suppressed long press',
        );
        expect(suppressed.props.nativeContextMenuOpen).toBe(false);

        await act(async () => {
            listProps?.onScrollEndDrag?.();
            longPress?.__handlers.onBegin?.({});
            longPress?.__handlers.onStart?.({});
        });

        const opened = expectPresent(
            findSessionItem(screen, 'sess_a'),
            'expected sess_a session row after fresh long press',
        );
        expect(opened.props.nativeContextMenuOpen).toBe(true);
    });

    it('closes an open iOS native context menu when native list scrolling starts', async () => {
        const screen = await renderSessionsList();
        const listProps = virtualizedListState.current?.props;
        const first = expectPresent(findSessionItem(screen, 'sess_a'), 'expected sess_a session row');

        await act(async () => {
            first.props.onNativeContextMenuOpenChange(true);
        });

        const opened = expectPresent(findSessionItem(screen, 'sess_a'), 'expected sess_a session row after open');
        expect(opened.props.nativeContextMenuOpen).toBe(true);

        await act(async () => {
            listProps?.onScrollBeginDrag?.();
        });

        const closed = expectPresent(findSessionItem(screen, 'sess_a'), 'expected sess_a session row after scroll start');
        expect(closed.props.nativeContextMenuOpen).toBe(false);
    });

    it('ignores stale iOS native context menu close requests from another row', async () => {
        const screen = await renderSessionsList();
        const first = expectPresent(findSessionItem(screen, 'sess_a'), 'expected sess_a session row');

        await act(async () => {
            first.props.onNativeContextMenuOpenChange(true);
        });

        const opened = expectPresent(findSessionItem(screen, 'sess_a'), 'expected sess_a session row after open');
        expect(opened.props.nativeContextMenuOpen).toBe(true);

        const second = expectPresent(findSessionItem(screen, 'sess_b'), 'expected sess_b session row');
        await act(async () => {
            second.props.onNativeContextMenuOpenChange(false);
        });

        const stillOpen = expectPresent(findSessionItem(screen, 'sess_a'), 'expected sess_a session row after stale close');
        expect(stillOpen.props.nativeContextMenuOpen).toBe(true);
    });

    it('disables native inline drag affordances when ordering mode is not custom', async () => {
        sessionListOrderingModeV1 = 'updated';

        const screen = await renderSessionsList();

        const first = expectPresent(findSessionItem(screen, 'sess_a'), 'expected sess_a session row');
        expect(first.props.reorderHandleGesture).toBeUndefined();
        expect(first.props.nativeInlineDragEnabled).toBe(false);
        expect(findRecordedGestureDetectors(screen)).toHaveLength(0);
    });

    it('keeps Android session rows on the shared drag handle without native inline context menus', async () => {
        platformOs = 'android';

        const screen = await renderSessionsList();

        const first = expectPresent(findSessionItem(screen, 'sess_a'), 'expected sess_a session row');
        expect(first.props.reorderHandleGesture).toBeUndefined();
        expect(first.props.nativeInlineDragEnabled).toBeUndefined();
        expect(first.props.nativeContextMenuOpen).toBeUndefined();
        expect(first.props.onNativeContextMenuOpenChange).toBeUndefined();
        expect(findRecordedGestureDetectors(screen)).toHaveLength(0);
    });

    it('passes canonical virtualization hints without deprecated size estimates', async () => {
        await renderSessionsList();

        expect(virtualizedListState.current?.props?.estimatedItemSize).toBeUndefined();
        expect(typeof virtualizedListState.current?.props?.getItemType).toBe('function');
    });

    it('disables native maintain-visible-content-position for the session list surface', async () => {
        await renderSessionsListWithSurfaceOwnership({
            visible: true,
            interactive: true,
            dataActive: true,
        });

        expect(virtualizedListState.current?.props?.maintainVisibleContentPosition).toBe(false);
        expect(virtualizedListState.current?.props?.recycleItems).toBe(false);
    });

    it('passes scroll and viewport events to session-list drag autoscroll on native lists', async () => {
        await renderSessionsList();

        const props = virtualizedListState.current?.props;
        expect(typeof props?.onScroll).toBe('function');
        expect(typeof props?.onLayout).toBe('function');
        expect(typeof props?.onContentSizeChange).toBe('function');
        expect(props?.scrollEventThrottle).toBe(16);
    });

    it('restores the retained list offset when the native list becomes visible after a zero-height hide', async () => {
        await renderSessionsList();

        const props = virtualizedListState.current?.props;
        const scrollToOffset = vi.fn();
        (virtualizedListState.current?.refHandle as { scrollToOffset?: unknown } | undefined)!.scrollToOffset = scrollToOffset;

        await act(async () => {
            props?.onLayout?.({ nativeEvent: { layout: { height: 416 } } });
            props?.onScroll?.({
                nativeEvent: {
                    contentOffset: { y: 280 },
                    layoutMeasurement: { height: 416 },
                },
            });
            props?.onLayout?.({ nativeEvent: { layout: { height: 0 } } });
            props?.onScroll?.({
                nativeEvent: {
                    contentOffset: { y: 0 },
                    layoutMeasurement: { height: 0 },
                },
            });
            props?.onLayout?.({ nativeEvent: { layout: { height: 416 } } });
        });

        expect(scrollToOffset).toHaveBeenCalledWith({ offset: 280, animated: false });
    });

    it('keeps native virtualized list prop identities stable across unrelated rerenders', async () => {
        const screen = await renderSessionsList();
        const initialProps = virtualizedListState.current?.props;
        expect(initialProps).toBeTruthy();
        const initialKeyExtractor = initialProps?.keyExtractor;
        const initialRenderItem = initialProps?.renderItem;
        const initialContentContainerStyle = initialProps?.contentContainerStyle;
        const initialFooterComponent = initialProps?.ListFooterComponent;
        const { SessionsList } = await import('./SessionsList');

        await screen.update(<SessionsList />);

        const updatedProps = virtualizedListState.current?.props;
        expect(updatedProps?.keyExtractor).toBe(initialKeyExtractor);
        expect(updatedProps?.renderItem).toBe(initialRenderItem);
        expect(updatedProps?.contentContainerStyle).toBe(initialContentContainerStyle);
        expect(updatedProps?.ListFooterComponent).toBe(initialFooterComponent);
    });

    it('keeps native row extra data stable when an equivalent session-list refresh only replaces data objects', async () => {
        platformOs = 'android';

        const screen = await renderSessionsList();
        const initialProps = virtualizedListState.current?.props;
        expect(initialProps).toBeTruthy();
        const initialExtraData = initialProps?.extraData;
        const { SessionsList } = await import('./SessionsList');

        mockVisibleSessionListViewData = mockVisibleSessionListViewData.map((item) => (
            item.type === 'session'
                ? { ...item, session: { ...item.session } }
                : { ...item }
        ));
        await screen.update(<SessionsList />);

        expect(virtualizedListState.current?.props?.extraData).toBe(initialExtraData);
    });

    it('emits one bounded semantic status-demand batch without invalidating rows on a native viewability change', async () => {
        platformOs = 'ios';
        const header = expectPresent(
            mockVisibleSessionListViewData.find((item) => item.type === 'header'),
            'expected header item',
        );
        const profiledSessions = Array.from({ length: 145 }, (_, index) => ({
            ...sessionA,
            id: `sess_profiled_${index}`,
            updatedAt: sessionA.updatedAt + index,
            metadata: {
                ...sessionA.metadata,
                externalSessionV1: {
                    v: 1,
                    agentId: 'codex',
                    machineId: 'machine-target',
                    remoteSessionId: `remote-${index}`,
                    source: {
                        kind: 'codexHome',
                        home: '/tmp/codex',
                    },
                    linkedAtMs: index + 1,
                },
            },
        }));
        mockVisibleSessionListViewData = [
            header,
            ...profiledSessions.map((session) => ({
                type: 'session',
                session,
                groupKey,
                groupKind: 'date',
                serverId: 'server_a',
                serverName: 'Server A',
            })),
        ];
        storageState.sessionListRenderables = Object.fromEntries(
            profiledSessions.map((session) => [session.id, session]),
        );
        storageState.sessionListRowStateByServerId = {
            server_a: storageState.sessionListRenderables,
        };

        await vi.resetModules();
        const {
            registerExternalSessionStatusDemandTransport,
            resetExternalSessionStatusDemandCoordinatorForTests,
        } = await import('@/sync/runtime/orchestration/externalSessions/externalSessionStatusDemandCoordinator');
        const emitStatusDemand = vi.fn();
        const statusDemandTransport = registerExternalSessionStatusDemandTransport(
            'server_a',
            emitStatusDemand,
        );
        const { SessionsList } = await import('./SessionsList');
        await renderScreen(<SessionsList />);
        const { syncPerformanceTelemetry } = await import('@/sync/runtime/syncPerformanceTelemetry');
        syncPerformanceTelemetry.configure({ enabled: true, slowThresholdMs: 0 });
        syncPerformanceTelemetry.reset();
        try {
            expect(emitStatusDemand).toHaveBeenCalledTimes(1);
            expect(emitStatusDemand.mock.calls[0]?.[1]).toMatchObject({
                entries: expect.arrayContaining([
                    expect.objectContaining({ demand: 'loaded' }),
                ]),
            });
            const initialProps = virtualizedListState.current?.props;
            expect(initialProps).toBeTruthy();
            expect(typeof initialProps?.onViewableItemsChanged).toBe('function');
            const initialExtraData = initialProps?.extraData;
            const initialData = initialProps?.data;
            const initialSessionNodes = Array.isArray(initialData)
                ? initialData.filter((node) => String(node.id).includes('sess_profiled_'))
                : [];

            syncPerformanceTelemetry.reset();
            await act(async () => {
                initialProps?.onViewableItemsChanged({
                    changed: [],
                    viewableItems: initialSessionNodes.slice(75, 88).map((item, index) => ({
                        index: 76 + index,
                        isViewable: true,
                        item,
                        key: item.id,
                    })),
                });
                await Promise.resolve();
            });

            expect(emitStatusDemand).toHaveBeenCalledTimes(2);
            const visibleDemand = emitStatusDemand.mock.calls[1]?.[1] as {
                entries: Array<{ demand: string }>;
            };
            expect(visibleDemand.entries).toHaveLength(13);
            expect(visibleDemand.entries.every((entry) => entry.demand === 'visible')).toBe(true);
            expect(virtualizedListState.current?.props?.extraData).toBe(initialExtraData);
            expect(virtualizedListState.current?.props?.data).toBe(initialData);
            const events = syncPerformanceTelemetry.snapshot().events;
            expect(events.find((event) => event.name === 'ui.sessionsList.viewableRows.changed')?.fields).toEqual(expect.objectContaining({
                changed: 1,
                nextVisibleRows: 13,
                previousKnown: 0,
                previousVisibleRows: 0,
            }));
            expect(events.find((event) => event.name === 'ui.sessionsList.rowStoreSubscriptions')?.fields).toEqual(expect.objectContaining({
                allRenderedRowsSubscribed: 1,
                dataActive: 1,
                priorityRows: 0,
                subscribedRows: 145,
                totalRows: 145,
                visibleRows: 13,
            }));
        } finally {
            statusDemandTransport.dispose();
            resetExternalSessionStatusDemandCoordinatorForTests();
            syncPerformanceTelemetry.configure({ enabled: false });
            syncPerformanceTelemetry.reset();
        }
    });

    it('keeps native virtualized node data stable when an equivalent session-list refresh only replaces data objects', async () => {
        platformOs = 'android';

        const screen = await renderSessionsList();
        const initialProps = virtualizedListState.current?.props;
        expect(initialProps).toBeTruthy();
        const initialData = initialProps?.data;
        const initialFirstNode = Array.isArray(initialData) ? initialData[0] : null;
        const { SessionsList } = await import('./SessionsList');

        mockVisibleSessionListViewData = mockVisibleSessionListViewData.map((item) => (
            item.type === 'session'
                ? { ...item, session: { ...item.session } }
                : { ...item }
        ));
        await screen.update(<SessionsList />);

        const updatedData = virtualizedListState.current?.props?.data;
        expect(updatedData).toBe(initialData);
        expect(Array.isArray(updatedData) ? updatedData[0] : null).toBe(initialFirstNode);
    });

    it('keeps native virtualized node data stable when one row renderable updates', async () => {
        platformOs = 'ios';

        const screen = await renderSessionsList();
        const initialProps = virtualizedListState.current?.props;
        expect(initialProps).toBeTruthy();
        const initialData = initialProps?.data;
        const initialExtraData = initialProps?.extraData;
        const { SessionsList } = await import('./SessionsList');

        storageState.sessionListRowStateByServerId = {
            ...storageState.sessionListRowStateByServerId,
            server_a: {
                ...storageState.sessionListRowStateByServerId.server_a,
                sess_a: {
                    ...sessionA,
                    active: true,
                    activeAt: 100,
                    thinking: true,
                    thinkingAt: 100,
                    presence: 'online',
                },
            },
        };
        await screen.update(<SessionsList />);

        expect(virtualizedListState.current?.props?.data).toBe(initialData);
        expect(virtualizedListState.current?.props?.extraData).toBe(initialExtraData);
    });

    it('keeps row move action props stable when an equivalent session-list refresh only replaces data objects', async () => {
        platformOs = 'android';
        mockVisibleSessionListViewData = mockVisibleSessionListViewData.map((item) => (
            item.type === 'session'
                ? {
                    ...item,
                    workspace: {
                        t: 'workspaceScope',
                        serverId: 'server_a',
                        machineId: 'machine-target',
                        rootPath: '/Volumes/target/repo',
                    },
                }
                : item
        ));

        const screen = await renderSessionsList();
        const first = expectPresent(findSessionItem(screen, 'sess_a'), 'expected sess_a session row');
        expect(typeof first.props.onMoveToFolder).toBe('function');
        expect(typeof first.props.onMoveToWorkspaceRoot).toBe('function');
        expect(typeof first.props.onMoveUp).toBe('function');
        expect(typeof first.props.onMoveDown).toBe('function');
        expect(typeof first.props.onMoveToSessionFolder).toBe('function');
        const initialMoveToFolder = first.props.onMoveToFolder;
        const initialMoveToWorkspaceRoot = first.props.onMoveToWorkspaceRoot;
        const initialMoveUp = first.props.onMoveUp;
        const initialMoveDown = first.props.onMoveDown;
        const initialMoveToSessionFolder = first.props.onMoveToSessionFolder;
        const initialFolderMoveTargets = first.props.folderMoveTargets;
        const { SessionsList } = await import('./SessionsList');

        mockVisibleSessionListViewData = mockVisibleSessionListViewData.map((item) => (
            item.type === 'session'
                ? { ...item, session: { ...item.session } }
                : { ...item }
        ));
        await screen.update(<SessionsList />);

        const updated = expectPresent(findSessionItem(screen, 'sess_a'), 'expected sess_a session row after refresh');
        expect(updated.props.onMoveToFolder).toBe(initialMoveToFolder);
        expect(updated.props.onMoveToWorkspaceRoot).toBe(initialMoveToWorkspaceRoot);
        expect(updated.props.onMoveUp).toBe(initialMoveUp);
        expect(updated.props.onMoveDown).toBe(initialMoveDown);
        expect(updated.props.onMoveToSessionFolder).toBe(initialMoveToSessionFolder);
        expect(updated.props.folderMoveTargets).toBe(initialFolderMoveTargets);
    });

    it('classifies native virtualized-list items by row kind', async () => {
        mockVisibleSessionListViewData = [
            {
                type: 'header',
                title: 'Active',
                headerKind: 'active',
                groupKey: 'server:server_a:active',
                serverId: 'server_a',
                serverName: 'Server A',
            },
            {
                type: 'header',
                title: '/repo',
                headerKind: 'project',
                groupKey: 'server:server_a:active:project:abc',
                serverId: 'server_a',
                serverName: 'Server A',
            },
            {
                type: 'session',
                session: sessionA,
                groupKey: 'server:server_a:active:project:abc',
                groupKind: 'project',
                serverId: 'server_a',
                serverName: 'Server A',
            },
        ];

        await renderSessionsList();

        const getItemType = virtualizedListState.current?.props?.getItemType;
        const data = virtualizedListState.current?.props?.data as any[] | null | undefined;
        expect(getItemType?.(data?.[0], 0)).toBe('header:active');
        expect(getItemType?.(data?.[1], 1)).toBe('header:project');
        expect(getItemType?.(data?.[2], 2)).toBe('session:default:body');
    });

    it('passes path secondary-line mode for date-grouped rows', async () => {
        const screen = await renderSessionsList();
        expect(findSessionItem(screen, 'sess_a')?.props.secondaryLineMode).toBe('path');
        expect(findSessionItem(screen, 'sess_b')?.props.secondaryLineMode).toBe('path');
    });

    it('passes status secondary-line mode for project-grouped rows', async () => {
        mockVisibleSessionListViewData = [
            {
                type: 'header',
                title: 'Active',
                headerKind: 'active',
                serverId: 'server_a',
                serverName: 'Server A',
            },
            {
                type: 'header',
                title: '/repo',
                headerKind: 'project',
                groupKey: 'server:server_a:active:project:abc',
                workspaceKey: 'wl_abc',
                serverId: 'server_a',
                serverName: 'Server A',
            },
            {
                type: 'session',
                session: sessionA,
                groupKey: 'server:server_a:active:project:abc',
                groupKind: 'project',
                variant: 'no-path',
                serverId: 'server_a',
                serverName: 'Server A',
            },
        ];

        const screen = await renderSessionsList();
        expect(screen.findAllByTestId('session-list-session:sess_a')).toHaveLength(1);
        expect(findSessionItem(screen, 'sess_a')?.props.secondaryLineMode).toBe('status');

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
    });

    it('shows an Open project action for project headers with a resolvable WorkspaceRef', async () => {
        workspaceRefsV1 = [
            {
                id: 'wr_1',
                serverId: 'server_a',
                machineId: 'machine_1',
                rootPath: '/repo',
                label: 'Repo',
                createdAtMs: 1,
                lastOpenedAtMs: null,
            },
        ];
        mockVisibleSessionListViewData = [
            {
                type: 'header',
                title: 'Repo',
                headerKind: 'project',
                groupKey: 'project:machine_1:/repo',
                workspaceScopeHint: { serverId: 'server_a', machineId: 'machine_1', rootPath: '/repo' },
                serverId: 'server_a',
                serverName: 'Server A',
            },
        ];

        const screen = await renderSessionsList();
        const items = findFirstDropdownMenuItems(screen);
        expect(items.some((item) => item?.id === 'openProject')).toBe(true);
    });

    it('does not expose project rename actions without a workspace scope hint', async () => {
        mockVisibleSessionListViewData = [
            {
                type: 'header',
                title: '/repo',
                headerKind: 'project',
                groupKey: 'server:server_a:active:project:abc',
                workspaceKey: 'wl_abc',
                serverId: 'server_a',
                serverName: 'Server A',
            },
        ];

        const screen = await renderSessionsList();
        expect(findFirstDropdownMenuItems(screen)).toEqual([]);
    });

    it('wires pin toggling through session organization', async () => {
        const screen = await renderSessionsList();
        const first = expectPresent(findSessionItem(screen, 'sess_a'), 'expected first session item');
        expect(typeof first.props.onTogglePinned).toBe('function');

        await act(async () => {
            first.props.onTogglePinned();
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(setSessionPinOp).toHaveBeenCalledTimes(1);
        expect(setSessionPinOp).toHaveBeenCalledWith(expect.objectContaining({
            scope: expect.objectContaining({
                serverId: 'server_a',
                serverUrl: 'https://server-a.example.test',
            }),
            sessionKey: 'server_a:sess_a',
            pinned: true,
        }));
    });

    it('records active session changes into the server-scoped MRU order', async () => {
        mockPathname = '/session/sess_b';
        sessionMruOrderV1 = ['server_a:stale', 'server_a:sess_a'];

        await renderSessionsList();

        expect(setSessionMruOrderV1).toHaveBeenCalledWith(['server_a:sess_b', 'server_a:sess_a']);
    });

    it('does not record active session changes into the MRU order when the surface is not data-active', async () => {
        mockPathname = '/session/sess_b';
        sessionMruOrderV1 = ['server_a:stale', 'server_a:sess_a'];

        await renderSessionsListWithSurfaceOwnership({
            visible: false,
            interactive: false,
            dataActive: false,
        });

        expect(setSessionMruOrderV1).not.toHaveBeenCalled();
    });

    it('registers visible session shortcut handlers through the keyboard provider', async () => {
        mockPathname = '/session/sess_a';

        await renderSessionsList();

        expect(keyboardShortcutHandlersRef.current?.['session.visible.next']).toBeTypeOf('function');

        act(() => {
            keyboardShortcutHandlersRef.current?.['session.visible.next']?.();
        });

        expect(navigateToSessionSpy).toHaveBeenCalledWith('sess_b', { serverId: 'server_a' });
    });

    it('registers MRU session shortcut handlers through the keyboard provider', async () => {
        mockPathname = '/session/sess_a';
        sessionMruOrderV1 = ['server_a:sess_a', 'server_a:sess_b'];

        await renderSessionsList();

        expect(keyboardShortcutHandlersRef.current?.['session.mru.next']).toBeTypeOf('function');

        act(() => {
            keyboardShortcutHandlersRef.current?.['session.mru.next']?.();
        });

        expect(navigateToSessionSpy).toHaveBeenCalledWith('sess_b', { serverId: 'server_a' });
    });

    it('does not register session-list shortcut handlers when the surface is non-interactive', async () => {
        mockPathname = '/session/sess_a';
        sessionMruOrderV1 = ['server_a:sess_a', 'server_a:sess_b'];

        await renderSessionsListWithSurfaceOwnership({ interactive: false, dataActive: true });

        expect(keyboardShortcutHandlersRef.current).toEqual({});
    });

    it('keeps the last active render data while the surface is visible but inactive', async () => {
        const screen = await renderSessionsListWithSurfaceOwnership({
            visible: true,
            interactive: true,
            dataActive: true,
        });
        const activeData = expectPresent(
            virtualizedListState.current?.props?.data,
            'expected active virtualized-list data',
        );
        mockVisibleSessionListViewData = [
            ...mockVisibleSessionListViewData,
            {
                type: 'session',
                session: {
                    id: 'sess_hidden_refresh',
                    active: true,
                    updatedAt: 20,
                    metadata: {
                        machineId: 'machine-target',
                        path: '/Users/test/hidden-refresh',
                        homeDir: '/Users/test',
                        host: 'target.local',
                    },
                },
                serverId: 'server_a',
                section: 'active',
                groupKind: 'active',
            },
        ];

        const { SessionsList } = await import('./SessionsList');
        await screen.update(
            <SessionsList
                surfaceOwnership={{
                    visible: true,
                    interactive: false,
                    dataActive: false,
                }}
            />,
        );
        const inactiveData = expectPresent(
            virtualizedListState.current?.props?.data,
            'expected inactive visible virtualized-list data',
        );
        expect(inactiveData).toBe(activeData);

        await screen.update(
            <SessionsList
                surfaceOwnership={{
                    visible: true,
                    interactive: true,
                    dataActive: true,
                }}
            />,
        );
        const reactivatedData = expectPresent(
            virtualizedListState.current?.props?.data,
            'expected reactivated virtualized-list data',
        );
        expect(reactivatedData).not.toBe(activeData);
        expect(reactivatedData.some((item: any) => item.id === 'session:server_a:sess_hidden_refresh')).toBe(true);
    });

    it('unmounts native virtualization while the surface is hidden', async () => {
        const screen = await renderSessionsListWithSurfaceOwnership({
            visible: true,
            interactive: true,
            dataActive: true,
        });
        expect(screen.root.findAllByType('LegendList' as any)).toHaveLength(1);

        const { SessionsList } = await import('./SessionsList');
        await screen.update(
            <SessionsList
                surfaceOwnership={{
                    visible: false,
                    interactive: false,
                    dataActive: false,
                }}
            />,
        );

        expect(screen.root.findAllByType('LegendList' as any)).toHaveLength(0);
    });

    it('does not expose load-more work while the surface is not data-active', async () => {
        await renderSessionsListWithSurfaceOwnership({
            visible: false,
            interactive: false,
            dataActive: false,
        });

        expect(virtualizedListState.current?.props?.onEndReached).toBeUndefined();
    });

    it('refreshes sessions from native pull-to-refresh and keeps the indicator active while pending', async () => {
        let resolveRefresh: (() => void) | null = null;
        const refreshPromise = new Promise<undefined>((resolve) => {
            resolveRefresh = () => resolve(undefined);
        });
        refreshSessionsMock.mockReturnValueOnce(refreshPromise);
        await renderSessionsListWithSurfaceOwnership({
            visible: true,
            interactive: true,
            dataActive: true,
        });

        const refreshControl = expectPresent(
            virtualizedListState.current?.props?.refreshControl,
            'expected native refresh control',
        );
        const onRefresh = expectPresent(
            refreshControl.props.onRefresh,
            'expected native refresh handler',
        );

        expect(String(refreshControl.type)).toBe('RefreshControl');
        expect(refreshControl.props.refreshing).toBe(false);

        await act(async () => {
            void onRefresh();
            await Promise.resolve();
        });

        expect(refreshSessionsMock).toHaveBeenCalledTimes(1);
        expect(virtualizedListState.current?.props?.refreshControl?.props?.refreshing).toBe(true);

        await act(async () => {
            resolveRefresh?.();
            await refreshPromise;
        });

        expect(virtualizedListState.current?.props?.refreshControl?.props?.refreshing).toBe(false);
    });

    it('does not expose native pull-to-refresh when the surface is not data-active', async () => {
        await renderSessionsListWithSurfaceOwnership({
            visible: false,
            interactive: false,
            dataActive: false,
        });

        expect(virtualizedListState.current?.props?.refreshControl).toBeUndefined();
    });

    it('deduplicates native pull-to-refresh while a session refresh is already pending', async () => {
        let resolveRefresh: (() => void) | null = null;
        const refreshPromise = new Promise<undefined>((resolve) => {
            resolveRefresh = () => resolve(undefined);
        });
        refreshSessionsMock.mockReturnValueOnce(refreshPromise);
        await renderSessionsListWithSurfaceOwnership({
            visible: true,
            interactive: true,
            dataActive: true,
        });
        const onRefresh = expectPresent(
            virtualizedListState.current?.props?.refreshControl?.props?.onRefresh,
            'expected active native refresh handler',
        );

        await act(async () => {
            void onRefresh();
            void onRefresh();
            await Promise.resolve();
        });

        expect(refreshSessionsMock).toHaveBeenCalledTimes(1);

        await act(async () => {
            resolveRefresh?.();
            await refreshPromise;
        });
    });

    it('ignores stale native pull-to-refresh callbacks after the surface becomes inactive', async () => {
        const screen = await renderSessionsListWithSurfaceOwnership({
            visible: true,
            interactive: true,
            dataActive: true,
        });
        const staleOnRefresh = expectPresent(
            virtualizedListState.current?.props?.refreshControl?.props?.onRefresh,
            'expected active native refresh handler',
        );
        const { SessionsList } = await import('./SessionsList');

        await screen.update(
            <SessionsList
                surfaceOwnership={{
                    visible: false,
                    interactive: false,
                    dataActive: false,
                }}
            />,
        );
        await act(async () => {
            await staleOnRefresh();
        });

        expect(refreshSessionsMock).not.toHaveBeenCalled();
    });

    it('loads more sessions from native scroll proximity when the backend does not emit onEndReached', async () => {
        await renderSessionsListWithSurfaceOwnership({
            visible: true,
            interactive: true,
            dataActive: true,
        });

        await act(async () => {
            virtualizedListState.current?.props?.onScroll?.({
                nativeEvent: {
                    contentOffset: { y: 720 },
                    contentSize: { height: 1000 },
                    layoutMeasurement: { height: 240 },
                },
            });
        });

        expect(markSessionListScrollActivityMock).toHaveBeenCalledTimes(1);
        expect(fetchMoreSessionsMock).toHaveBeenCalledTimes(1);
    });

    it('ignores stale load-more callbacks after the surface becomes inactive', async () => {
        const screen = await renderSessionsListWithSurfaceOwnership({
            visible: true,
            interactive: true,
            dataActive: true,
        });
        const staleOnEndReached = expectPresent(
            virtualizedListState.current?.props?.onEndReached,
            'expected active load-more handler',
        );
        const { SessionsList } = await import('./SessionsList');

        await screen.update(
            <SessionsList
                surfaceOwnership={{
                    visible: false,
                    interactive: false,
                    dataActive: false,
                }}
            />,
        );
        await act(async () => {
            await staleOnEndReached();
        });

        expect(fetchMoreSessionsMock).not.toHaveBeenCalled();
    });

    it('writes session tags through session organization assignments', async () => {
        sessionTagsV1 = { 'server_a:sess_a': ['important'] };

        const screen = await renderSessionsList();
        const first = expectPresent(findSessionItem(screen, 'sess_a'), 'expected first session item');
        expect(typeof first.props.onSetTags).toBe('function');
        await act(async () => {
            first.props.onSetTags(['urgent']);
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(setSessionTagAssignmentsOp).toHaveBeenCalledTimes(1);
        expect(setSessionTagAssignmentsOp).toHaveBeenCalledWith(expect.objectContaining({
            scope: expect.objectContaining({
                serverId: 'server_a',
                serverUrl: 'https://server-a.example.test',
            }),
            sessionKey: 'server_a:sess_a',
            tags: ['urgent'],
        }));
    });

    it('shows pinned server badges only when multiple servers are selected', async () => {
        pinnedSessionKeysV1 = ['server_a:sess_a'];
        sessionTagsV1 = {};
        const screen = await renderSessionsList();
        expect(findSessionItem(screen, 'sess_a')?.props.pinned).toBe(true);
        expect(findSessionItem(screen, 'sess_a')?.props.showServerBadge).toBe(false);

        mockAllowedServerIds = ['server_a', 'server_b'];
        const updatedScreen = await renderSessionsList();
        expect(findSessionItem(updatedScreen, 'sess_a')?.props.showServerBadge).toBe(true);
    });

    it('uses the reachable machine label and base path when row metadata is stale after handoff', async () => {
        workspacePathDisplayModeV1 = 'path';
        readMachineTargetForSessionMock.mockImplementation((sessionId: string) =>
            sessionId === 'sess_a'
                ? { machineId: 'machine-target', basePath: '/Volumes/target/repo' }
                : null,
        );
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

        const screen = await renderSessionsList();
        const item = expectPresent(
            findSessionItem(screen, 'sess_a'),
            'expected first session item',
        );
        expect(item.props.subtitleOverride).toBe('Rebound workstation · /Volumes/target/repo');
    });

    it('does not derive reachability details for rows hidden by a collapsed group', async () => {
        collapsedGroupKeysV1 = { [groupKey]: true };
        readMachineTargetForSessionMock.mockClear();
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
                type: 'header',
                title: 'Tomorrow',
                headerKind: 'date',
                groupKey: 'server:server_a:day:2026-02-18',
                serverId: 'server_a',
                serverName: 'Server A',
            },
            {
                type: 'session',
                session: sessionB,
                groupKey: 'server:server_a:day:2026-02-18',
                groupKind: 'date',
                serverId: 'server_a',
                serverName: 'Server A',
            },
        ];

        const screen = await renderSessionsList();

        expect(screen.findAllByTestId('session-list-session:sess_a')).toHaveLength(0);
        expect(screen.findAllByTestId('session-list-session:sess_b')).toHaveLength(1);
        const queriedSessionIds = readMachineTargetForSessionMock.mock.calls.map(([sessionId]) => sessionId);
        expect(queriedSessionIds).not.toContain('sess_a');
        expect(queriedSessionIds).toContain('sess_b');
    });
});
