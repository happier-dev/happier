import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { findGestureByKind, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import type { SessionListViewItem } from '@/sync/domains/state/storage';
import { localSettingsDefaults, type LocalSettings } from '@/sync/domains/settings/localSettings';
import { clearTempData, peekTempData, type NewSessionData } from '@/utils/sessions/tempDataStore';
import { installSessionShellCommonModuleMocks } from './sessionShellTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let platformOs: 'ios' | 'android' | 'web' = 'ios';
let mockPathname = '';
let isTabletDevice = false;
let pinnedSessionKeysV1: string[] = [];
const setPinnedSessionKeysV1 = vi.fn();
let sessionMruOrderV1: string[] = [];
const setSessionMruOrderV1 = vi.fn();
const setDefaultLocalSettingValue = vi.fn();
const readMachineTargetForSessionMock = vi.hoisted(() => vi.fn());
const resolveWorkspaceFaviconMock = vi.hoisted(() => vi.fn());
const routerPushSpy = vi.hoisted(() => vi.fn());
const navigateToSessionSpy = vi.hoisted(() => vi.fn());
const fetchMoreSessionsMock = vi.hoisted(() => vi.fn(async () => undefined));
const refreshSessionsMock = vi.hoisted(() => vi.fn<() => Promise<void>>(async () => undefined));
const markSessionListScrollActivityMock = vi.hoisted(() => vi.fn());
const sessionOrganizationOps = vi.hoisted(() => ({
    setSessionPin: vi.fn(async () => undefined),
    setSessionTagLabels: vi.fn(async () => undefined),
}));
const keyboardShortcutHandlersRef = vi.hoisted(() => ({
    current: null as Record<string, (() => void)> | null,
}));

let sessionTagsV1: Record<string, string[]> = {};
const setSessionTagsV1 = vi.fn();
let workspaceLabelsV1: Record<string, string> = {};
const setWorkspaceLabelsV1 = vi.fn();
let collapsedGroupKeysV1: Record<string, boolean> = {};
const setCollapsedGroupKeysV1 = vi.fn();
let sessionFolderViewModeV1: 'off' | 'tree' = 'off';
const setSessionFolderViewModeV1 = vi.fn();
let sessionFoldersV1: any = { v: 1, folders: [] };
const setSessionFoldersV1 = vi.fn();
let sessionListOrderingModeV1: 'custom' | 'created' | 'updated' = 'custom';
const setSessionListOrderingModeV1 = vi.fn();
let sessionFolderAssignmentsBySessionKey: Record<string, string | null> = {};
let rememberLastProjectSessionSelections: boolean | null = null;
let organizationProjectionCache: { signature: string; projection: any } | null = null;
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
let machineDisplayById: Record<string, any> = {
    'machine-target': {
        id: 'machine-target',
        updatedAt: 10,
        active: true,
        activeAt: 10,
        revokedAt: null,
        metadataVersion: 1,
        metadata: {
            displayName: 'Rebound workstation',
            host: 'target.local',
            homeDir: '/Users/test',
        },
    },
    'machine-other': {
        id: 'machine-other',
        updatedAt: 5,
        active: true,
        activeAt: 5,
        revokedAt: null,
        metadataVersion: 1,
        metadata: {
            displayName: 'Other workstation',
            host: 'other.local',
            homeDir: '/Users/test',
        },
    },
};

function stripServerScopedSessionKey(key: string): string {
    const prefix = 'server_a:';
    return key.startsWith(prefix) ? key.slice(prefix.length) : key;
}

function buildOrganizationProjectionFromLegacyState() {
    const signature = JSON.stringify({
        pinnedSessionKeysV1,
        sessionFoldersV1,
        sessionFolderAssignmentsBySessionKey,
        sessionTagsV1,
        workspaceLabelsV1,
    });
    if (organizationProjectionCache?.signature === signature) {
        return organizationProjectionCache.projection;
    }
    const pinsBySessionId: Record<string, { sessionId: string; sortKey: string | null; pinnedAt: number }> = {};
    const pinnedSessionIds = pinnedSessionKeysV1.map((key, index) => {
        const sessionId = stripServerScopedSessionKey(key);
        pinsBySessionId[sessionId] = { sessionId, sortKey: String(index + 1).padStart(8, '0'), pinnedAt: index + 1 };
        return sessionId;
    });
    const foldersById = Object.fromEntries((sessionFoldersV1?.folders ?? []).map((folder: any) => [
        folder.id,
        {
            folderId: folder.id,
            folderKey: folder.id,
            parentFolderId: folder.parentId ?? null,
            parentFolderKey: folder.parentId ?? null,
            sortKey: folder.sortKey ?? null,
            display: { t: 'plain', v: { name: folder.name, workspace: folder.workspace } },
            archivedAt: null,
            createdAt: folder.createdAt ?? 1,
            updatedAt: folder.updatedAt ?? 1,
        },
    ]));
    const projection = {
        schemaVersion: 1,
        version: 1,
        pinnedSessionIds,
        pinsBySessionId,
        foldersById,
        folderAssignmentsBySessionId: Object.fromEntries(Object.entries(sessionFolderAssignmentsBySessionKey).map(([key, folderId]) => [
            stripServerScopedSessionKey(key),
            folderId,
        ])),
        tagsById: {},
        tagAssignmentsBySessionId: Object.fromEntries(Object.entries(sessionTagsV1).map(([key, tags]) => [
            stripServerScopedSessionKey(key),
            tags,
        ])),
        attentionStandingsBySessionId: {},
        orderEntriesByScopeKey: {},
        labelsByLabelKey: Object.fromEntries(Object.entries(workspaceLabelsV1).map(([scopeKey, label], index) => [
            `server_a:workspace:${scopeKey}`,
            {
                labelKind: 'workspace',
                scopeKey,
                display: { t: 'plain', v: { label } },
                archivedAt: null,
                createdAt: index + 1,
                updatedAt: index + 1,
            },
        ])),
    };
    organizationProjectionCache = { signature, projection };
    return projection;
}

function useLocalSettingMutableMock<K extends keyof LocalSettings>(
    key: K,
): [LocalSettings[K], (value: LocalSettings[K]) => void] {
    const localSettings = {
        ...localSettingsDefaults,
        sessionMruOrderV1,
        collapsedGroupKeysV1,
    };
    const setValue = (value: LocalSettings[K]) => {
        if (key === 'sessionMruOrderV1') {
            setSessionMruOrderV1(value);
            return;
        }
        if (key === 'collapsedGroupKeysV1') {
            setCollapsedGroupKeysV1(value as Record<string, boolean>);
            return;
        }
        setDefaultLocalSettingValue(value);
    };
    return [
        localSettings[key],
        setValue,
    ];
}
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

const sessionC = {
    ...sessionA,
    id: 'sess_c',
    metadata: {
        machineId: 'machine-target',
        path: '/Users/test/third-repo',
        homeDir: '/Users/test',
        host: 'target.local',
    },
} as any;

vi.mock('react-native-gesture-handler', async () => {
    const { createGestureHandlerMock } = await import('@/dev/testkit/mocks/gestureHandler');
    return createGestureHandlerMock();
});

vi.mock('react-native-safe-area-context', async (importOriginal) => ({
    ...await importOriginal<typeof import('react-native-safe-area-context')>(),
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('react-native-reanimated', () => ({
    default: { View: (props: any) => React.createElement('Animated.View', props) },
    Easing: {
        bezier: () => () => 0,
        linear: () => 0,
    },
    useSharedValue: (init: any) => ({ value: init }),
    useAnimatedReaction: vi.fn(),
    useAnimatedStyle: (fn: () => any) => fn(),
    withSpring: (value: any) => value,
    withTiming: (value: any) => value,
}));

vi.mock('react-native-worklets', () => ({
    scheduleOnRN: (fn: (...args: any[]) => void, ...args: any[]) => fn(...args),
}));

vi.mock('@/constants/Typography', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/constants/Typography')>()),
    Typography: new Proxy({} as Record<string, () => Record<string, never>>, {
        get: () => () => ({}),
    }),
}));

vi.mock('@/components/ui/icons/Icon', () => ({
    Icon: 'Icon',
    ICON_SIZE: { xs: 14, sm: 16, md: 20, lg: 24, xl: 29 },
}));

vi.mock('@shopify/flash-list', async () => ({
    ...((await import('@/dev/testkit/mocks/flashList')) as typeof import('@/dev/testkit/mocks/flashList')).createCapturingFlashListMock({
        componentName: 'FlashList',
        renderItems: true,
    }).module,
}));

// The engine behind the seam is selectable (Legend on native, FlashList on web), so this suite
// captures at the SEAM rather than at one engine. It asserts the props and adjacency the list
// passes down, which are the same whichever engine renders them — pinning an engine here would make
// these tests fail on an engine swap that changed nothing they care about.
vi.mock('@/components/ui/lists/flashListCompat/SessionListVirtualizedList', async () => ({
    SessionListVirtualizedList: ((await import('@/dev/testkit/mocks/flashList')) as typeof import('@/dev/testkit/mocks/flashList')).createCapturingFlashListMock({
        componentName: 'FlashListCompat',
        renderItems: true,
    }).module.FlashList,
}));

vi.mock('@/components/ui/lists/flashListCompat/FlashListCompat', async () => ({
    ...((await import('@/dev/testkit/mocks/flashList')) as typeof import('@/dev/testkit/mocks/flashList')).createCapturingFlashListMock({
        componentName: 'FlashListCompat',
        renderItems: true,
    }).module,
}));

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
    useLayoutMaxWidth: () => 1280,
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: any) => React.createElement(
        'DropdownMenu',
        props,
        typeof props.trigger === 'function'
            ? props.trigger({
                open: Boolean(props.open),
                toggle: vi.fn(),
                openMenu: vi.fn(),
                closeMenu: vi.fn(),
                selectedItem: null,
            })
            : null,
    ),
}));

vi.mock('@/sync/domains/session/listing/sessionListOrderingStateV1', () => ({
    SESSION_LIST_GROUP_ORDER_MAX_KEYS_PER_GROUP: 50,
}));

vi.mock('@/sync/domains/session/listing/deriveSessionListActivity', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/sync/domains/session/listing/deriveSessionListActivity')>(),
    resolveSessionListSecondaryLineMode: ({ groupKind }: { groupKind?: string | null }) =>
        groupKind === 'date' ? 'path' : 'status',
}));

vi.mock('@/utils/sessions/sessionUtils', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/utils/sessions/sessionUtils')>(),
    getSessionName: () => 'Session',
    getSessionSubtitle: () => 'Subtitle',
    formatPathRelativeToHome: (path: string) => path,
    getSessionAvatarId: () => 'avatar',
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
    useIsTablet: () => isTabletDevice,
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
            pathname: () => mockPathname,
            router: {
                push: routerPushSpy,
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
        return createStorageModuleMock({
            importOriginal,
            overrides: {
                useSetting: (key: string) => {
                    if (key === 'compactSessionView') return false;
                    if (key === 'compactSessionViewMinimal') return false;
                    if (key === 'sessionTagsEnabled') return true;
                    if (key === 'rememberLastProjectSessionSelections') return rememberLastProjectSessionSelections;
                    return null;
                },
                useHasUnreadMessages: () => false,
                useAllMachines: () => allMachines,
                useMachineDisplayById: () => machineDisplayById,
                useSessionOrganizationProjection: () => buildOrganizationProjectionFromLegacyState(),
                useSettingMutable: (key: string) => {
                    if (key === 'pinnedSessionKeysV1') return [pinnedSessionKeysV1, setPinnedSessionKeysV1];
                    if (key === 'sessionFolderViewModeV1') return [sessionFolderViewModeV1, setSessionFolderViewModeV1];
                    if (key === 'sessionFoldersV1') return [sessionFoldersV1, setSessionFoldersV1];
                    if (key === 'sessionListOrderingModeV1') return [sessionListOrderingModeV1, setSessionListOrderingModeV1];
                    if (key === 'sessionMruOrderV1') {
                        throw new Error('sessionMruOrderV1 must stay in local settings');
                    }
                    if (key === 'sessionTagsV1') return [sessionTagsV1, setSessionTagsV1];
                    if (key === 'workspaceLabelsV1') return [workspaceLabelsV1, setWorkspaceLabelsV1];
                    if (key === 'collapsedGroupKeysV1') {
                        throw new Error('collapsedGroupKeysV1 must stay in local settings');
                    }
                    if (key === 'sessionListGroupOrderV1') return [{}, vi.fn()];
                    return [null, vi.fn()];
                },
                useSessionFolderAssignmentsBySessionKey: () => sessionFolderAssignmentsBySessionKey,
                useLocalSettingMutable: useLocalSettingMutableMock,
                storage: createStorageStoreMock(storageState),
            },
        });
    },
});

vi.mock('expo-image', () => ({
    Image: 'Image',
}));

vi.mock('@/sync/ops/workspaceFavicon', () => ({
    resolveWorkspaceFavicon: resolveWorkspaceFaviconMock,
}));

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

vi.mock('@/sync/ops/sessionMachineTarget', () => ({
    readMachineTargetForSession: (sessionId: string) => readMachineTargetForSessionMock(sessionId),
    readMachineControlTargetForSession: (sessionId: string) => readMachineTargetForSessionMock(sessionId),
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

vi.mock('@/sync/ops/sessionOrganization', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/ops/sessionOrganization')>();
    return {
        ...actual,
        setSessionPin: sessionOrganizationOps.setSessionPin,
        setSessionTagLabels: sessionOrganizationOps.setSessionTagLabels,
    };
});

vi.mock('@/auth/storage/tokenStorage', () => ({
    TokenStorage: {
        getCredentialsForServerUrl: vi.fn(async () => ({ token: 'token' })),
    },
}));

vi.mock('@/sync/domains/server/serverProfiles', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/domains/server/serverProfiles')>();
    return {
        ...actual,
        getServerProfileById: (serverId: string) => ({
            id: serverId,
            serverUrl: 'https://server.example.test',
        }),
    };
});

vi.mock('@/hooks/session/useNavigateToSession', () => ({
    useNavigateToSession: () => navigateToSessionSpy,
}));

vi.mock('@/keyboard/KeyboardShortcutProvider', () => ({
    useKeyboardShortcutHandlers: (handlers: Record<string, () => void>) => {
        keyboardShortcutHandlersRef.current = handlers;
        return true;
    },
}));

let mockAllowedServerIds: string[] = ['server_a'];
let mockActiveServerId = 'server_a';
vi.mock('@/hooks/server/useEffectiveServerSelection', () => ({
    useResolvedActiveServerSelection: () => ({
        enabled: true,
        presentation: 'grouped',
        activeServerId: mockActiveServerId,
        allowedServerIds: mockAllowedServerIds,
    }),
}));

vi.mock('@/hooks/server/useFeatureDecision', () => ({
    useFeatureDecision: () => ({ state: 'enabled' }),
}));

let mockVisibleSessionListViewData: any[] | null = [
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

async function renderSessionsListWithSurfaceOwnership(surfaceOwnership: Readonly<{
    interactive: boolean;
    dataActive: boolean;
    visible?: boolean;
    ownerKey?: string;
}>) {
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

function flattenStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) {
        return style.reduce<Record<string, unknown>>((acc, entry) => ({
            ...acc,
            ...flattenStyle(entry),
        }), {});
    }
    if (!style || typeof style !== 'object') {
        return {};
    }
    return style as Record<string, unknown>;
}

function findChevronOpacityForHeaderPressable(headerPressable: any): unknown {
    const chevronIcon = headerPressable.findAll((node: any) =>
        String(node.type) === 'Icon'
        && (node.props?.name === 'caret-down' || node.props?.name === 'caret-right')
    )[0];
    return flattenStyle(chevronIcon?.parent?.props?.style).opacity;
}

function findPressableByAccessibilityLabel(
    screen: Awaited<ReturnType<typeof renderSessionsList>>,
    label: string,
) {
    return screen.root.findAll((node) =>
        String(node.type) === 'Pressable' && node.props?.accessibilityLabel === label
    )[0] ?? null;
}

function findDropdownByItemTitle(
    screen: Awaited<ReturnType<typeof renderSessionsList>>,
    title: string,
) {
    return screen.root.findAll((node) =>
        String(node.type) === 'DropdownMenu'
        && Array.isArray(node.props?.items)
        && node.props.items.some((item: any) => item.title === title)
    )[0] ?? null;
}

function childTreeContainsType(root: any, type: string): boolean {
    return root.children.some((child: unknown) => (
        typeof child === 'object'
        && child !== null
        && (
            (child as any).type === type
            || childTreeContainsType(child, type)
        )
    ));
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
        const { clearSessionListHeaderFilterRetentionForTests } = await import('./search/useSessionListHeaderFilterRetention');
        clearSessionListHeaderFilterRetentionForTests();
        platformOs = 'ios';
        mockPathname = '';
        isTabletDevice = false;
        pinnedSessionKeysV1 = [];
        sessionMruOrderV1 = [];
        sessionTagsV1 = {};
        workspaceLabelsV1 = {};
        collapsedGroupKeysV1 = {};
        sessionFolderViewModeV1 = 'off';
        sessionFoldersV1 = { v: 1, folders: [] };
        sessionListOrderingModeV1 = 'custom';
        sessionFolderAssignmentsBySessionKey = {};
        rememberLastProjectSessionSelections = null;
        organizationProjectionCache = null;
        machineDisplayById = {
            'machine-target': {
                id: 'machine-target',
                updatedAt: 10,
                active: true,
                activeAt: 10,
                revokedAt: null,
                metadataVersion: 1,
                metadata: {
                    displayName: 'Rebound workstation',
                    host: 'target.local',
                    homeDir: '/Users/test',
                },
            },
            'machine-other': {
                id: 'machine-other',
                updatedAt: 5,
                active: true,
                activeAt: 5,
                revokedAt: null,
                metadataVersion: 1,
                metadata: {
                    displayName: 'Other workstation',
                    host: 'other.local',
                    homeDir: '/Users/test',
                },
            },
        };
        setPinnedSessionKeysV1.mockClear();
        setSessionMruOrderV1.mockClear();
        setDefaultLocalSettingValue.mockClear();
        setSessionTagsV1.mockClear();
        setWorkspaceLabelsV1.mockClear();
        setCollapsedGroupKeysV1.mockClear();
        setSessionFolderViewModeV1.mockClear();
        setSessionFoldersV1.mockClear();
        setSessionListOrderingModeV1.mockClear();
        navigateToSessionSpy.mockClear();
        fetchMoreSessionsMock.mockClear();
        refreshSessionsMock.mockReset();
        refreshSessionsMock.mockResolvedValue(undefined);
        markSessionListScrollActivityMock.mockClear();
        sessionOrganizationOps.setSessionPin.mockClear();
        sessionOrganizationOps.setSessionTagLabels.mockClear();
        keyboardShortcutHandlersRef.current = null;
        routerPushSpy.mockClear();
        mockAllowedServerIds = ['server_a'];
        mockActiveServerId = 'server_a';
        readMachineTargetForSessionMock.mockReset();
        readMachineTargetForSessionMock.mockImplementation(() => null);
        resolveWorkspaceFaviconMock.mockReset();
        resolveWorkspaceFaviconMock.mockResolvedValue({ status: 'missing' });
        delete storageState.sessions.seed_sess;
        clearTempData();
        resetVisibleSessionListViewData();
    });

    afterEach(() => {
        clearTempData();
        standardCleanup();
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

        const trigger = expectPresent(
            screen.findByTestId('session-list-search-trigger'),
            'expected collapsed search trigger',
        );
        const stopPropagation = vi.fn(function (this: { nativeEvent?: unknown }) {
            expect(this.nativeEvent).toEqual({ type: 'press' });
        });
        await act(async () => {
            trigger.props.onPress?.({ nativeEvent: { type: 'press' }, stopPropagation });
        });
        expect(stopPropagation).toHaveBeenCalledTimes(1);

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

    it('shows the header controls on the pinned group when it is the first visible section', async () => {
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
        ];

        const screen = await renderSessionsList();

        expect(screen.findAllByTestId('session-list-search-trigger')).toHaveLength(1);
        expect(screen.findAllByTestId('session-list-ordering-menu-trigger')).toHaveLength(1);
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
        expect(screen.findAllByTestId('session-list-ordering-menu-trigger')).toHaveLength(1);
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
            input.props.onChangeText?.('other-repo');
        });

        expect(screen.findAllByTestId('session-list-search-input').length).toBeGreaterThan(0);
        expect(screen.findAllByTestId('session-list-session:sess_a')).toHaveLength(0);
        expect(screen.findAllByTestId('session-list-header:active')).toHaveLength(1);
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

        expect(screen.findAllByTestId('session-list-header:active')).toHaveLength(1);
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
            input.props.onChangeText?.('other-repo');
            input.props.onBlur?.();
        });

        expect(screen.findAllByTestId('session-list-search-input').length).toBeGreaterThan(0);
        expect(screen.findAllByTestId('session-list-session:sess_a')).toHaveLength(0);
        expect(screen.findAllByTestId('session-list-session:sess_b')).toHaveLength(1);
    });

    it('retains active header search filters across a route-level sessions-list remount', async () => {
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
            ).props.onChangeText?.('other-repo');
        });

        expect(screen.findAllByTestId('session-list-session:sess_a')).toHaveLength(0);
        expect(screen.findAllByTestId('session-list-session:sess_b')).toHaveLength(1);

        standardCleanup();
        const remounted = await renderSessionsList();

        const retainedInput = expectPresent(
            remounted.findByTestId('session-list-search-input'),
            'expected retained search input after remount',
        );
        expect(retainedInput.props.value).toBe('other-repo');
        expect(remounted.findAllByTestId('session-list-session:sess_a')).toHaveLength(0);
        expect(remounted.findAllByTestId('session-list-session:sess_b')).toHaveLength(1);
    });

    it('stores expanded groups as explicit false tombstones', async () => {
        collapsedGroupKeysV1 = { [groupKey]: true, legacyGroup: true };

        const screen = await renderSessionsList();
        expect(screen.findAllByTestId('session-list-session:sess_a')).toHaveLength(0);

        await act(async () => {
            expectPresent(
                screen.findByTestId(`session-list-header:${groupKey}`),
                'expected collapsed date header',
            ).props.onPress?.();
        });

        expect(setCollapsedGroupKeysV1).toHaveBeenCalledWith({
            [groupKey]: false,
            legacyGroup: true,
        });
    });

    it('shows matching sessions from collapsed groups while header filters are active', async () => {
        collapsedGroupKeysV1 = { [groupKey]: true };
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
        ];

        const screen = await renderSessionsList();
        expect(screen.findAllByTestId('session-list-session:sess_a')).toHaveLength(0);

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
            input.props.onChangeText?.('stale-repo');
        });

        expect(screen.findAllByTestId('session-list-session:sess_a')).toHaveLength(1);
    });

    it('shows the header tag filter only when known tags exist and filters by any selected tag', async () => {
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

    it('passes stable recycling hints to native FlashList without deprecated size estimates', async () => {
        platformOs = 'android';

        const screen = await renderSessionsList();
        const list = expectPresent(
            screen.root.findAll((node) => String(node.type) === 'FlashListCompat')[0],
            'expected native FlashListCompat',
        );

        expect(list.props.estimatedItemSize).toBeUndefined();
        const visibleSessionListViewData = expectPresent(
            mockVisibleSessionListViewData,
            'expected visible session list view data',
        );
        expect(list.props.getItemType?.(visibleSessionListViewData[0], 0)).toBe('header:date');
        // Session cell heights depend on group position (last/single rows
        // carry the inter-group gap) and density, so recycling pools are
        // keyed on the HEIGHT CLASS (body vs tail) — a recycled cell can then
        // never bring a stale height from a different position into view,
        // while position flips within the same height class (first↔middle)
        // do not force a remount.
        expect(list.props.getItemType?.(visibleSessionListViewData[1], 1)).toBe('session:default:body');
        expect(list.props.getItemType?.(visibleSessionListViewData[2], 2)).toBe('session:default:tail');
    });

    it('disables web FlatList virtualization for first-page-sized lists', async () => {
        platformOs = 'web';

        const screen = await renderSessionsList();
        const list = expectPresent(
            screen.root.findAll((node) => String(node.type) === 'FlatList')[0],
            'expected web FlatList',
        );

        expect(list.props.disableVirtualization).toBe(true);
    });

    it('disables web FlatList virtualization for medium sidebar lists', async () => {
        platformOs = 'web';
        const header = expectPresent(
            mockVisibleSessionListViewData?.find((item) => item.type === 'header'),
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

        const screen = await renderSessionsList();
        const list = expectPresent(
            screen.root.findAll((node) => String(node.type) === 'FlatList')[0],
            'expected web FlatList',
        );

        expect(list.props.disableVirtualization).toBe(true);
    });

    it('uses FlashListCompat for large web lists instead of relying on React Native Web FlatList virtualization', async () => {
        platformOs = 'web';
        const header = expectPresent(
            mockVisibleSessionListViewData?.find((item) => item.type === 'header'),
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

        const screen = await renderSessionsList();
        const flashList = expectPresent(
            screen.root.findAll((node) => String(node.type) === 'FlashListCompat')[0],
            'expected large web list to use FlashListCompat',
        );

        expect(screen.root.findAll((node) => String(node.type) === 'FlatList')).toHaveLength(0);
        expect(flashList.props.getItemType?.(mockVisibleSessionListViewData[0], 0)).toBe('header:date');
        expect(flashList.props.getItemType?.(mockVisibleSessionListViewData[1], 1)).toBe('session:default:body');
        expect(flashList.props.getItemType?.(mockVisibleSessionListViewData[2], 2)).toBe('session:default:body');
    });

    it('renders the full priority prefix before inactive history on large web lists', async () => {
        platformOs = 'web';
        const makeHeader = (
            title: string,
            headerKind: string,
            groupKeyValue: string,
        ) => ({
            type: 'header',
            title,
            headerKind,
            groupKey: groupKeyValue,
            serverId: 'server_a',
            serverName: 'Server A',
        });
        const makeSession = (
            id: string,
            groupKeyValue: string,
            groupKind: string,
            section: 'active' | 'inactive',
            index: number,
        ) => ({
            type: 'session',
            session: {
                ...sessionA,
                id,
                active: section === 'active',
                updatedAt: sessionA.updatedAt + index,
            },
            groupKey: groupKeyValue,
            groupKind,
            section,
            serverId: 'server_a',
            serverName: 'Server A',
        });
        const attentionRows = Array.from({ length: 6 }, (_, index) =>
            makeSession(`sess_attention_${index}`, 'attention-promotion-v1', 'attention', 'active', index));
        const workingRows = Array.from({ length: 10 }, (_, index) =>
            makeSession(`sess_working_${index}`, 'working-placement-v1', 'working', 'active', 100 + index));
        const pinnedRows = Array.from({ length: 205 }, (_, index) =>
            makeSession(`sess_pinned_${index}`, 'pinned-v1', 'pinned', 'inactive', 200 + index));
        const activeRows = Array.from({ length: 15 }, (_, index) =>
            makeSession(`sess_active_${index}`, 'active', 'active', 'inactive', 500 + index));
        const inactiveRows = Array.from({ length: 40 }, (_, index) =>
            makeSession(`sess_inactive_${index}`, 'inactive', 'date', 'inactive', 700 + index));
        mockVisibleSessionListViewData = [
            makeHeader('Needs attention', 'attention', 'attention-promotion-v1'),
            ...attentionRows,
            makeHeader('Working', 'working', 'working-placement-v1'),
            ...workingRows,
            makeHeader('Pinned', 'pinned', 'pinned-v1'),
            ...pinnedRows,
            makeHeader('Active', 'active', 'active'),
            ...activeRows,
            makeHeader('Inactive', 'inactive', 'inactive'),
            ...inactiveRows,
        ];

        const screen = await renderSessionsList();
        const list = expectPresent(
            screen.root.findAll((node) => String(node.type) === 'FlashListCompat')[0],
            'expected large web list to use FlashListCompat',
        );

        const priorityPrefixLength = 1 + 6 + 1 + 10 + 1 + 205 + 1 + 15;
        expect(screen.root.findAll((node) => String(node.type) === 'FlatList')).toHaveLength(0);
        expect(list.props.data.findIndex((item: any) =>
            item?.type === 'header' && item.headerKind === 'inactive')).toBe(priorityPrefixLength);
        expect(list.props.data.slice(0, priorityPrefixLength).some((item: any) =>
            item?.type === 'header' && item.headerKind === 'inactive')).toBe(false);
    });

    it('keeps native list render props stable across unrelated rerenders', async () => {
        platformOs = 'android';

        const screen = await renderSessionsList();
        const initialList = expectPresent(
            screen.root.findAll((node) => String(node.type) === 'FlashListCompat')[0],
            'expected native FlashListCompat',
        );
        const initialKeyExtractor = initialList.props.keyExtractor;
        const initialRenderItem = initialList.props.renderItem;
        const initialContentContainerStyle = initialList.props.contentContainerStyle;
        const initialListHeaderComponent = initialList.props.ListHeaderComponent;
        const initialListFooterComponent = initialList.props.ListFooterComponent;
        const { SessionsList } = await import('./SessionsList');

        await screen.update(<SessionsList />);

        const updatedList = expectPresent(
            screen.root.findAll((node) => String(node.type) === 'FlashListCompat')[0],
            'expected updated native FlashListCompat',
        );
        expect(updatedList.props.keyExtractor).toBe(initialKeyExtractor);
        expect(updatedList.props.renderItem).toBe(initialRenderItem);
        expect(updatedList.props.contentContainerStyle).toBe(initialContentContainerStyle);
        expect(updatedList.props.ListHeaderComponent).toBe(initialListHeaderComponent);
        expect(updatedList.props.ListFooterComponent).toBe(initialListFooterComponent);
    });

    it('keeps native list chrome callbacks stable when an equivalent session-list refresh has no folder breadcrumbs', async () => {
        platformOs = 'android';

        const screen = await renderSessionsList();
        const initialList = expectPresent(
            screen.root.findAll((node) => String(node.type) === 'FlashListCompat')[0],
            'expected native FlashListCompat',
        );
        const initialListHeaderComponent = initialList.props.ListHeaderComponent;
        const initialListFooterComponent = initialList.props.ListFooterComponent;
        const { SessionsList } = await import('./SessionsList');

        mockVisibleSessionListViewData = mockVisibleSessionListViewData?.map((item) => ({ ...item })) ?? null;
        await screen.update(<SessionsList />);

        const updatedList = expectPresent(
            screen.root.findAll((node) => String(node.type) === 'FlashListCompat')[0],
            'expected updated native FlashListCompat',
        );
        expect(updatedList.props.ListHeaderComponent).toBe(initialListHeaderComponent);
        expect(updatedList.props.ListFooterComponent).toBe(initialListFooterComponent);
    });

    it('keeps native row extra data stable when an equivalent session-list refresh only replaces data objects', async () => {
        platformOs = 'android';
        sessionFolderViewModeV1 = 'tree';

        const screen = await renderSessionsList();
        const initialList = expectPresent(
            screen.root.findAll((node) => String(node.type) === 'FlashListCompat')[0],
            'expected native FlashListCompat',
        );
        const initialExtraData = initialList.props.extraData;
        const initialData = initialList.props.data as Array<SessionListViewItem & { rowModel?: unknown }>;
        const initialSessionItem = expectPresent(
            initialData.find((item) => item.type === 'session' && item.session.id === 'sess_a'),
            'expected initial sess_a row',
        );
        const initialRow = initialList.props.renderItem({
            item: initialSessionItem,
            index: initialData.indexOf(initialSessionItem),
        });
        const { SessionsList } = await import('./SessionsList');

        mockVisibleSessionListViewData = mockVisibleSessionListViewData?.map((item) => (
            item.type === 'session'
                ? { ...item, session: { ...item.session } }
                : { ...item }
        )) ?? null;
        await screen.update(<SessionsList />);

        const updatedList = expectPresent(
            screen.root.findAll((node) => String(node.type) === 'FlashListCompat')[0],
            'expected updated native FlashListCompat',
        );
        const updatedData = updatedList.props.data as Array<SessionListViewItem & { rowModel?: unknown }>;
        const updatedSessionItem = expectPresent(
            updatedData.find((item) => item.type === 'session' && item.session.id === 'sess_a'),
            'expected updated sess_a row',
        );
        const updatedRow = updatedList.props.renderItem({
            item: updatedSessionItem,
            index: updatedData.indexOf(updatedSessionItem),
        });

        expect(updatedList.props.extraData).toBe(initialExtraData);
        expect(updatedRow.props.rowModel).toBe(initialRow.props.rowModel);
        expect(updatedRow.props.onDragStart).toBe(initialRow.props.onDragStart);
        expect(updatedRow.props.onDropResult).toBe(initialRow.props.onDropResult);
        expect(updatedRow.props.onDragCancel).toBe(initialRow.props.onDragCancel);
        expect(updatedRow.props.resolveDropResult).toBe(initialRow.props.resolveDropResult);
        expect(updatedRow.props.onRegisterTreeRowBounds).toBe(initialRow.props.onRegisterTreeRowBounds);
        expect(updatedRow.props.onUnregisterTreeRowBounds).toBe(initialRow.props.onUnregisterTreeRowBounds);
        expect(updatedRow.props.folderMoveMenuItems).toBe(initialRow.props.folderMoveMenuItems);
        expect(updatedRow.props.onMoveToFolder).toBe(initialRow.props.onMoveToFolder);
        expect(updatedRow.props.onMoveToWorkspaceRoot).toBe(initialRow.props.onMoveToWorkspaceRoot);
        expect(updatedRow.props.onMoveUp).toBe(initialRow.props.onMoveUp);
        expect(updatedRow.props.onMoveDown).toBe(initialRow.props.onMoveDown);
        expect(updatedRow.props.onSelectFolderMoveMenuItem).toBe(initialRow.props.onSelectFolderMoveMenuItem);
    });

    it('keeps native FlashList structural data stable when a row overlay update changes one row model', async () => {
        platformOs = 'android';

        const screen = await renderSessionsList();
        const initialList = expectPresent(
            screen.root.findAll((node) => String(node.type) === 'FlashListCompat')[0],
            'expected native FlashListCompat',
        );
        const initialData = initialList.props.data;
        const initialExtraData = initialList.props.extraData;
        const initialSessionItem = expectPresent(
            findSessionItem(screen, 'sess_a'),
            'expected initial sess_a row',
        );
        expect(initialSessionItem.props.rowModel.session.thinking).toBe(false);

        const { SessionsList } = await import('./SessionsList');
        const { storage } = await import('@/sync/domains/state/storage');
        const storeState = storage.getState() as any;
        storeState.sessionListRenderables = {
            ...storeState.sessionListRenderables,
            sess_a: {
                ...sessionA,
                active: true,
                activeAt: 2_000,
                thinking: true,
                thinkingAt: 2_000,
                presence: 'online',
                latestTurnStatus: 'in_progress',
                latestTurnStatusObservedAt: 2_000,
            },
        };
        await screen.update(<SessionsList />);

        const updatedList = expectPresent(
            screen.root.findAll((node) => String(node.type) === 'FlashListCompat')[0],
            'expected updated native FlashListCompat',
        );
        expect(updatedList.props.data).toBe(initialData);
        expect(updatedList.props.extraData).toBe(initialExtraData);
    });

    it('does not invalidate native FlashList rows when viewability changes for the profiled session-list size', async () => {
        platformOs = 'ios';
        sessionFolderViewModeV1 = 'tree';
        const header = expectPresent(
            mockVisibleSessionListViewData?.find((item) => item.type === 'header'),
            'expected header item',
        );
        mockVisibleSessionListViewData = [
            header,
            ...Array.from({ length: 145 }, (_, index) => ({
                type: 'session',
                session: {
                    ...sessionA,
                    id: `sess_profiled_${index}`,
                    updatedAt: sessionA.updatedAt + index,
                },
                groupKey,
                groupKind: 'date',
                serverId: 'server_a',
                serverName: 'Server A',
            })),
        ];

        const screen = await renderSessionsList();
        const initialList = expectPresent(
            screen.root.findAll((node) => String(node.type) === 'FlashListCompat')[0],
            'expected native FlashListCompat',
        );
        const initialExtraData = initialList.props.extraData;
        const initialData = initialList.props.data as Array<SessionListViewItem & { rowModel?: unknown }>;
        const initialSessionItem = expectPresent(
            initialData.find((item) => item.type === 'session' && item.session.id === 'sess_profiled_80'),
            'expected initial profiled session row',
        );
        const initialRow = initialList.props.renderItem({
            item: initialSessionItem,
            index: initialData.indexOf(initialSessionItem),
        });

        await act(async () => {
            initialList.props.onViewableItemsChanged({
                changed: [],
                viewableItems: initialData
                    .filter((item) => item.type === 'session')
                    .slice(75, 88)
                    .map((item, index) => ({
                        index: 76 + index,
                        isViewable: true,
                        item,
                        key: `session:server_a:${item.session.id}`,
                    })),
            });
        });

        const updatedList = expectPresent(
            screen.root.findAll((node) => String(node.type) === 'FlashListCompat')[0],
            'expected updated native FlashListCompat',
        );
        const updatedData = updatedList.props.data as Array<SessionListViewItem & { rowModel?: unknown }>;
        const updatedSessionItem = expectPresent(
            updatedData.find((item) => item.type === 'session' && item.session.id === 'sess_profiled_80'),
            'expected updated profiled session row',
        );
        const updatedRow = updatedList.props.renderItem({
            item: updatedSessionItem,
            index: updatedData.indexOf(updatedSessionItem),
        });

        expect(updatedList.props.extraData).toBe(initialExtraData);
        expect(updatedData).toBe(initialData);
        expect(updatedRow.props.rowModel).toBe(initialRow.props.rowModel);
        expect(updatedRow.props.rowAttentionAnimationEnabled).toBe(initialRow.props.rowAttentionAnimationEnabled);
    });

    it('keeps row action props stable when FlashList re-renders the same item', async () => {
        platformOs = 'android';
        sessionFolderViewModeV1 = 'tree';

        const screen = await renderSessionsList();
        const list = expectPresent(
            screen.root.findAll((node) => String(node.type) === 'FlashListCompat')[0],
            'expected native FlashListCompat',
        );
        const data = list.props.data as Array<SessionListViewItem & { rowModel?: unknown }>;
        const sessionItem = expectPresent(data.find((item) => item.type === 'session'), 'expected session item');

        const firstRow = list.props.renderItem({ item: sessionItem, index: data.indexOf(sessionItem) });
        const secondRow = list.props.renderItem({ item: sessionItem, index: data.indexOf(sessionItem) });

        expect(secondRow.props.rowModel).toBe(firstRow.props.rowModel);
        expect(secondRow.props.onTogglePinned).toBe(firstRow.props.onTogglePinned);
        expect(secondRow.props.onSetTags).toBe(firstRow.props.onSetTags);
        expect(secondRow.props.onMoveToFolder).toBe(firstRow.props.onMoveToFolder);
        expect(secondRow.props.onMoveToWorkspaceRoot).toBe(firstRow.props.onMoveToWorkspaceRoot);
        expect(secondRow.props.onMoveUp).toBe(firstRow.props.onMoveUp);
        expect(secondRow.props.onMoveDown).toBe(firstRow.props.onMoveDown);
        expect(secondRow.props.onSelectFolderMoveMenuItem).toBe(firstRow.props.onSelectFolderMoveMenuItem);
        expect(secondRow.props.tags).toBe(firstRow.props.tags);
        expect(secondRow.props.allKnownTags).toBe(firstRow.props.allKnownTags);
    });

    it('passes structural session rows through virtualized data without widening row extra data', async () => {
        platformOs = 'android';

        const screen = await renderSessionsList();
        const list = expectPresent(
            screen.root.findAll((node) => String(node.type) === 'FlashListCompat')[0],
            'expected native FlashListCompat',
        );
        const data = list.props.data as Array<SessionListViewItem & { rowModel?: unknown }>;
        const sessionItem = expectPresent(findSessionItem(screen, 'sess_a'), 'expected sess_a session item');

        expect(data[0]?.type).toBe('header');
        expect(data[0]).toBe(mockVisibleSessionListViewData?.[0]);
        expect(data[1]?.rowModel).toBeUndefined();
        expect(sessionItem.props.rowModel?.rowKey).toBe('server_a:sess_a');
        expect(list.props.extraData.rowModels).toBeUndefined();
        expect(list.props.extraData.relativeNowMs).toBeUndefined();
        expect(list.props.extraData.runtimeNowMs).toBeUndefined();
    });

    it('updates only affected row data references on relative-time ticks while extra data remains stable', async () => {
        vi.useFakeTimers();
        const now = 1_700_000_000_000;
        vi.setSystemTime(now);
        platformOs = 'android';
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
                session: {
                    ...sessionA,
                    id: 'recent-row',
                    createdAt: now - 59_000,
                    updatedAt: now - 59_000,
                },
                groupKey,
                groupKind: 'date',
                serverId: 'server_a',
                serverName: 'Server A',
            },
            {
                type: 'session',
                session: {
                    ...sessionB,
                    id: 'timeless-row',
                    createdAt: 0,
                    updatedAt: 0,
                },
                groupKey,
                groupKind: 'date',
                serverId: 'server_a',
                serverName: 'Server A',
            },
        ];

        try {
            const screen = await renderSessionsList();
            const initialList = expectPresent(
                screen.root.findAll((node) => String(node.type) === 'FlashListCompat')[0],
                'expected native FlashListCompat',
            );
            const initialData = initialList.props.data as Array<SessionListViewItem & { rowModel?: any }>;
            const initialExtraData = initialList.props.extraData;
            expect(findSessionItem(screen, 'recent-row')?.props.rowModel?.activity.label).toBe('now');
            expect(findSessionItem(screen, 'timeless-row')?.props.rowModel?.activity.label).toBe('');

            await act(async () => {
                vi.advanceTimersByTime(60_000);
            });

            const updatedList = expectPresent(
                screen.root.findAll((node) => String(node.type) === 'FlashListCompat')[0],
                'expected updated native FlashListCompat',
            );
            const updatedData = updatedList.props.data as Array<SessionListViewItem & { rowModel?: any }>;
            expect(updatedList.props.extraData).toBe(initialExtraData);
            expect(updatedData).toBe(initialData);
            expect(findSessionItem(screen, 'recent-row')?.props.rowModel?.activity.label).toBe('1m');
        } finally {
            vi.useRealTimers();
        }
    });

    it('keeps hook order stable when session list data loads after an empty state', async () => {
        mockVisibleSessionListViewData = null;
        const { SessionsList } = await import('./SessionsList');
        const screen = await renderScreen(<SessionsList />);

        resetVisibleSessionListViewData();
        await screen.update(<SessionsList />);

        expect(screen.findAllByTestId('session-list-session:sess_a')).toHaveLength(1);
    });

    it('applies folder presentation to the rendered session list from current settings and assignments', async () => {
        sessionFolderViewModeV1 = 'tree';
        sessionFoldersV1 = {
            v: 1,
            folders: [{
                id: 'folder-planning',
                workspace: {
                    t: 'workspaceScope',
                    serverId: 'server_a',
                    machineId: 'machine-target',
                    rootPath: '/Volumes/target/repo',
                },
                renderWorkspaceKey: 'wl_repo',
                parentId: null,
                name: 'Planning',
                createdAt: 1,
                updatedAt: 1,
            }],
        };
        sessionFolderAssignmentsBySessionKey = {
            'server_a:sess_a': 'folder-planning',
        };
        mockVisibleSessionListViewData = [
            {
                type: 'header',
                title: 'Active',
                headerKind: 'active',
                groupKey: 'active',
                serverId: 'server_a',
            },
            {
                type: 'header',
                title: 'repo',
                headerKind: 'project',
                groupKey: 'server:server_a:active:project:repo',
                workspaceKey: 'wl_repo',
                workspaceScopeHint: {
                    serverId: 'server_a',
                    machineId: 'machine-target',
                    rootPath: '/Volumes/target/repo',
                },
                serverId: 'server_a',
            },
            {
                type: 'session',
                session: sessionB,
                section: 'active',
                groupKey: 'server:server_a:active:project:repo',
                groupKind: 'project',
                serverId: 'server_a',
                variant: 'no-path',
            },
            {
                type: 'session',
                session: sessionA,
                section: 'active',
                groupKey: 'server:server_a:active:project:repo',
                groupKind: 'project',
                serverId: 'server_a',
                variant: 'no-path',
            },
        ];

        const screen = await renderSessionsList();

        expect(screen.findByProps({ testID: 'session-folder-header-folder-planning' })).toBeTruthy();
        expect(findSessionItem(screen, 'sess_a')?.props.folderDepth).toBe(1);
        expect(findSessionItem(screen, 'sess_b')?.props.folderDepth).toBe(0);
    });

    it('uses a focused virtual cursor for Alt+Down session navigation on web', async () => {
        platformOs = 'web';
        mockPathname = '/session/sess_a';
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
            {
                type: 'session',
                session: sessionC,
                groupKey,
                groupKind: 'date',
                serverId: 'server_a',
                serverName: 'Server A',
            },
        ];

        const screen = await renderSessionsList();
        const zones = screen.findAllByTestId('sessions-list-keyboard-zone');
        expect(zones).toHaveLength(1);
        const zone = zones[0];
        const preventDefault = vi.fn();
        const stopPropagation = vi.fn();

        act(() => {
            zone.props.onFocus?.();
            zone.props.onKeyDown?.({
                key: 'ArrowDown',
                altKey: true,
                preventDefault,
                stopPropagation,
            });
            zone.props.onKeyDown?.({
                key: 'ArrowDown',
                altKey: true,
                preventDefault,
                stopPropagation,
            });
        });

        expect(navigateToSessionSpy).toHaveBeenNthCalledWith(1, 'sess_b', { serverId: 'server_a' });
        expect(navigateToSessionSpy).toHaveBeenNthCalledWith(2, 'sess_c', { serverId: 'server_a' });
        expect(preventDefault).toHaveBeenCalledTimes(2);
        expect(stopPropagation).toHaveBeenCalledTimes(2);
    });

    it('does not crash session navigation when the route session id is malformed percent-encoding', async () => {
        platformOs = 'web';
        mockPathname = '/session/%E0%A4%A';

        const screen = await renderSessionsList();
        const zone = expectPresent(
            screen.findAllByTestId('sessions-list-keyboard-zone')[0],
            'expected sessions list keyboard zone',
        );

        act(() => {
            zone.props.onFocus?.();
            zone.props.onKeyDown?.({
                key: 'ArrowDown',
                altKey: true,
                preventDefault: vi.fn(),
                stopPropagation: vi.fn(),
            });
        });

        expect(navigateToSessionSpy).toHaveBeenCalledWith('sess_a', { serverId: 'server_a' });
    });

    it('anchors Alt+Down navigation to the active server when session ids are duplicated', async () => {
        platformOs = 'web';
        mockPathname = '/session/sess_shared';
        mockActiveServerId = 'server_b';
        mockAllowedServerIds = ['server_a', 'server_b'];
        const serverASharedSession = {
            ...sessionA,
            id: 'sess_shared',
            metadata: {
                ...sessionA.metadata,
                host: 'server-a.local',
            },
        };
        const serverBSharedSession = {
            ...sessionA,
            id: 'sess_shared',
            metadata: {
                ...sessionA.metadata,
                host: 'server-b.local',
            },
        };
        const serverBNextSession = {
            ...sessionB,
            id: 'sess_next',
        };
        mockVisibleSessionListViewData = [
            {
                type: 'session',
                session: serverASharedSession,
                groupKey: 'server:server_a:day:2026-02-17',
                groupKind: 'date',
                serverId: 'server_a',
                serverName: 'Server A',
            },
            {
                type: 'session',
                session: serverBSharedSession,
                groupKey: 'server:server_b:day:2026-02-17',
                groupKind: 'date',
                serverId: 'server_b',
                serverName: 'Server B',
            },
            {
                type: 'session',
                session: serverBNextSession,
                groupKey: 'server:server_b:day:2026-02-17',
                groupKind: 'date',
                serverId: 'server_b',
                serverName: 'Server B',
            },
        ];

        const screen = await renderSessionsList();
        const zone = expectPresent(
            screen.findAllByTestId('sessions-list-keyboard-zone')[0],
            'expected sessions list keyboard zone',
        );

        act(() => {
            zone.props.onFocus?.();
            zone.props.onKeyDown?.({
                key: 'ArrowDown',
                altKey: true,
                preventDefault: vi.fn(),
                stopPropagation: vi.fn(),
            });
        });

        expect(navigateToSessionSpy).toHaveBeenCalledTimes(1);
        expect(navigateToSessionSpy).toHaveBeenCalledWith('sess_next', { serverId: 'server_b' });
    });

    it('records active session changes into the server-scoped MRU order', async () => {
        mockPathname = '/session/sess_b';
        sessionMruOrderV1 = ['server_a:stale', 'server_a:sess_a'];

        await renderSessionsList();

        expect(setSessionMruOrderV1).toHaveBeenCalledWith(['server_a:sess_b', 'server_a:sess_a']);
    });

    it('does not record active session changes into MRU order when the surface is not data-active', async () => {
        mockPathname = '/session/sess_b';
        sessionMruOrderV1 = ['server_a:stale', 'server_a:sess_a'];

        await renderSessionsListWithSurfaceOwnership({
            ownerKey: 'phone-root',
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
        expect(keyboardShortcutHandlersRef.current?.['sessions.row.moveToFolder']).toBeTypeOf('function');
        expect(keyboardShortcutHandlersRef.current?.['sessions.row.moveToWorkspaceRoot']).toBeTypeOf('function');
        expect(keyboardShortcutHandlersRef.current?.['sessions.row.moveUp']).toBeTypeOf('function');
        expect(keyboardShortcutHandlersRef.current?.['sessions.row.moveDown']).toBeTypeOf('function');

        act(() => {
            keyboardShortcutHandlersRef.current?.['session.visible.next']?.();
        });

        expect(navigateToSessionSpy).toHaveBeenCalledWith('sess_b', { serverId: 'server_a' });
    });

    it('does not register session list shortcut handlers when the surface is non-interactive', async () => {
        mockPathname = '/session/sess_a';

        await renderSessionsListWithSurfaceOwnership({ interactive: false, dataActive: true });

        expect(keyboardShortcutHandlersRef.current).toEqual({});
    });

    it('does not handle web session navigation keys when the surface is non-interactive', async () => {
        platformOs = 'web';
        mockPathname = '/session/sess_a';

        const screen = await renderSessionsListWithSurfaceOwnership({ interactive: false, dataActive: true });
        const zone = expectPresent(
            screen.findAllByTestId('sessions-list-keyboard-zone')[0],
            'expected sessions list keyboard zone',
        );

        act(() => {
            zone.props.onFocus?.();
            zone.props.onKeyDown?.({
                key: 'ArrowDown',
                altKey: true,
                preventDefault: vi.fn(),
                stopPropagation: vi.fn(),
            });
        });

        expect(navigateToSessionSpy).not.toHaveBeenCalled();
    });

    it('keeps the last active render data while the surface is visible but inactive', async () => {
        const screen = await renderSessionsListWithSurfaceOwnership({
            ownerKey: 'phone-root',
            visible: true,
            interactive: true,
            dataActive: true,
        });
        const list = expectPresent(
            screen.root.findAll((node) => String(node.type) === 'FlashListCompat')[0],
            'expected native FlashListCompat',
        );
        const activeData = list.props.data;
        const nextSession = {
            id: 'sess_hidden_refresh',
            active: true,
            updatedAt: 20,
            metadata: {
                machineId: 'machine-target',
                path: '/Users/test/hidden-refresh',
                homeDir: '/Users/test',
                host: 'target.local',
            },
        };
        mockVisibleSessionListViewData = [
            ...(mockVisibleSessionListViewData ?? []),
            {
                type: 'session',
                session: nextSession,
                serverId: 'server_a',
                section: 'active',
                groupKind: 'active',
            },
        ];

        const { SessionsList } = await import('./SessionsList');
        await screen.update(
            <SessionsList
                surfaceOwnership={{
                    ownerKey: 'phone-root',
                    visible: true,
                    interactive: false,
                    dataActive: false,
                }}
            />,
        );
        const inactiveList = expectPresent(
            screen.root.findAll((node) => String(node.type) === 'FlashListCompat')[0],
            'expected inactive native FlashListCompat',
        );
        expect(inactiveList.props.data).toBe(activeData);

        await screen.update(
            <SessionsList
                surfaceOwnership={{
                    ownerKey: 'phone-root',
                    visible: true,
                    interactive: true,
                    dataActive: true,
                }}
            />,
        );
        const reactivatedList = expectPresent(
            screen.root.findAll((node) => String(node.type) === 'FlashListCompat')[0],
            'expected reactivated native FlashListCompat',
        );
        expect(reactivatedList.props.data).not.toBe(activeData);
        expect(reactivatedList.props.data.some((item: any) => item.type === 'session' && item.session.id === 'sess_hidden_refresh')).toBe(true);
    });

    it('does not expose a load-more handler when the surface is not data-active', async () => {
        const screen = await renderSessionsListWithSurfaceOwnership({
            ownerKey: 'phone-root',
            visible: false,
            interactive: false,
            dataActive: false,
        });
        const list = expectPresent(
            screen.root.findAll((node) => String(node.type) === 'FlashListCompat')[0],
            'expected native FlashListCompat',
        );

        expect(list.props.onEndReached).toBeUndefined();
    });

    it('disables native FlashList maintain-visible-content-position for the session list surface', async () => {
        const screen = await renderSessionsListWithSurfaceOwnership({
            ownerKey: 'phone-root',
            visible: true,
            interactive: true,
            dataActive: true,
        });
        const list = expectPresent(
            screen.root.findAll((node) => String(node.type) === 'FlashListCompat')[0],
            'expected native FlashListCompat',
        );

        expect(list.props.maintainVisibleContentPosition).toEqual({ disabled: true });
    });

    it('refreshes sessions from native pull-to-refresh and keeps the indicator active while pending', async () => {
        let resolveRefresh: (() => void) | null = null;
        const refreshPromise = new Promise<void>((resolve) => {
            resolveRefresh = resolve;
        });
        refreshSessionsMock.mockReturnValueOnce(refreshPromise);
        const screen = await renderSessionsListWithSurfaceOwnership({
            ownerKey: 'phone-root',
            visible: true,
            interactive: true,
            dataActive: true,
        });
        const list = expectPresent(
            screen.root.findAll((node) => String(node.type) === 'FlashListCompat')[0],
            'expected native FlashListCompat',
        );
        const refreshControl = expectPresent(
            list.props.refreshControl,
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

        const refreshingList = expectPresent(
            screen.root.findAll((node) => String(node.type) === 'FlashListCompat')[0],
            'expected refreshing native FlashListCompat',
        );
        expect(refreshingList.props.refreshControl.props.refreshing).toBe(true);

        await act(async () => {
            resolveRefresh?.();
            await refreshPromise;
        });

        const refreshedList = expectPresent(
            screen.root.findAll((node) => String(node.type) === 'FlashListCompat')[0],
            'expected refreshed native FlashListCompat',
        );
        expect(refreshedList.props.refreshControl.props.refreshing).toBe(false);
    });

    it('does not expose native pull-to-refresh when the surface is not data-active', async () => {
        const screen = await renderSessionsListWithSurfaceOwnership({
            ownerKey: 'phone-root',
            visible: false,
            interactive: false,
            dataActive: false,
        });
        const list = expectPresent(
            screen.root.findAll((node) => String(node.type) === 'FlashListCompat')[0],
            'expected native FlashListCompat',
        );

        expect(list.props.refreshControl).toBeUndefined();
    });

    it('deduplicates native pull-to-refresh while a session refresh is already pending', async () => {
        let resolveRefresh: (() => void) | null = null;
        const refreshPromise = new Promise<void>((resolve) => {
            resolveRefresh = resolve;
        });
        refreshSessionsMock.mockReturnValueOnce(refreshPromise);
        const screen = await renderSessionsListWithSurfaceOwnership({
            ownerKey: 'phone-root',
            visible: true,
            interactive: true,
            dataActive: true,
        });
        const list = expectPresent(
            screen.root.findAll((node) => String(node.type) === 'FlashListCompat')[0],
            'expected native FlashListCompat',
        );
        const onRefresh = expectPresent(
            list.props.refreshControl?.props?.onRefresh,
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
            ownerKey: 'phone-root',
            visible: true,
            interactive: true,
            dataActive: true,
        });
        const list = expectPresent(
            screen.root.findAll((node) => String(node.type) === 'FlashListCompat')[0],
            'expected native FlashListCompat',
        );
        const staleOnRefresh = expectPresent(
            list.props.refreshControl?.props?.onRefresh,
            'expected active native refresh handler',
        );
        const { SessionsList } = await import('./SessionsList');

        await screen.update(
            <SessionsList
                surfaceOwnership={{
                    ownerKey: 'phone-root',
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

    it('loads more sessions from native scroll proximity when FlashList does not emit onEndReached', async () => {
        const screen = await renderSessionsListWithSurfaceOwnership({
            ownerKey: 'phone-root',
            visible: true,
            interactive: true,
            dataActive: true,
        });
        const list = expectPresent(
            screen.root.findAll((node) => String(node.type) === 'FlashListCompat')[0],
            'expected native FlashListCompat',
        );

        act(() => {
            list.props.onScroll?.({
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
            ownerKey: 'phone-root',
            visible: true,
            interactive: true,
            dataActive: true,
        });
        const list = expectPresent(
            screen.root.findAll((node) => String(node.type) === 'FlashListCompat')[0],
            'expected native FlashListCompat',
        );
        const staleOnEndReached = expectPresent(
            list.props.onEndReached,
            'expected active load-more handler',
        );
        const { SessionsList } = await import('./SessionsList');

        await screen.update(
            <SessionsList
                surfaceOwnership={{
                    ownerKey: 'phone-root',
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

    it('reuses row item references that are not affected by route selection changes', async () => {
        platformOs = 'android';
        isTabletDevice = true;
        mockPathname = '/session/sess_a';
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
            {
                type: 'session',
                session: sessionC,
                groupKey,
                groupKind: 'date',
                serverId: 'server_a',
                serverName: 'Server A',
            },
        ];

        const screen = await renderSessionsList();
        const initialList = expectPresent(
            screen.root.findAll((node) => String(node.type) === 'FlashListCompat')[0],
            'expected native FlashListCompat',
        );
        const initialData = initialList.props.data as Array<SessionListViewItem & { selected?: boolean }>;
        const initialRenderItem = initialList.props.renderItem;
        expect(initialData[1]?.selected).toBe(true);
        expect(initialData[2]?.selected).toBe(false);
        expect(initialData[3]?.selected).toBe(false);

        mockPathname = '/session/sess_b';
        const { SessionsList } = await import('./SessionsList');
        await screen.update(<SessionsList />);

        const updatedList = expectPresent(
            screen.root.findAll((node) => String(node.type) === 'FlashListCompat')[0],
            'expected updated native FlashListCompat',
        );
        const updatedData = updatedList.props.data as Array<SessionListViewItem & { selected?: boolean }>;
        expect(updatedList.props.renderItem).toBe(initialRenderItem);
        expect(updatedData[0]).toBe(initialData[0]);
        expect(updatedData[1]).not.toBe(initialData[1]);
        expect(updatedData[2]).not.toBe(initialData[2]);
        expect(updatedData[3]).toBe(initialData[3]);
        expect(updatedData[1]?.selected).toBe(false);
        expect(updatedData[2]?.selected).toBe(true);
        expect(updatedData[3]?.selected).toBe(false);
    });

    it('derives aggregate session-list render state for visible rows', async () => {
        platformOs = 'android';
        const { useSessionListViewState } = await import('./view-state/useSessionListViewState');
        const hook = await renderHook(() => useSessionListViewState({
            data: mockVisibleSessionListViewData,
            pathname: '',
        }));

        expect(hook.getCurrent().listItems.filter((item) => item.type === 'session')).toHaveLength(2);
        expect(hook.getCurrent().reachableSessionDisplayByKey.get('server_a:sess_a')).toMatchObject({
            machineId: 'machine-target',
            machineLabel: 'Rebound workstation',
        });
        expect(hook.getCurrent().hasMultipleMachines).toBe(true);

        await hook.unmount();
    });

    it('does not rebuild hidden reachability display data for machine display-only refreshes', async () => {
        platformOs = 'android';
        const { syncPerformanceTelemetry } = await import('@/sync/runtime/syncPerformanceTelemetry');
        syncPerformanceTelemetry.configure({
            enabled: true,
            slowThresholdMs: 1_000_000,
            flushIntervalMs: 60_000,
        });
        syncPerformanceTelemetry.reset();

        try {
            const { useSessionListViewState } = await import('./view-state/useSessionListViewState');
            const hook = await renderHook(({ tick }: { tick: number }) => {
                void tick;
                return useSessionListViewState({
                    data: mockVisibleSessionListViewData,
                    pathname: '',
                    sessionListSurfaceDataActive: false,
                });
            }, { initialProps: { tick: 0 } });

            syncPerformanceTelemetry.reset();
            readMachineTargetForSessionMock.mockClear();
            machineDisplayById = {
                ...machineDisplayById,
                'machine-target': {
                    ...machineDisplayById['machine-target'],
                    updatedAt: Number(machineDisplayById['machine-target']?.updatedAt ?? 0) + 1,
                },
            };
            await hook.rerender({ tick: 1 });

            expect(syncPerformanceTelemetry.snapshot().events.some((event) =>
                event.name === 'ui.sessionsList.render.reachabilityDisplayMap'
            )).toBe(false);
            expect(readMachineTargetForSessionMock).not.toHaveBeenCalled();
            await hook.unmount();
        } finally {
            syncPerformanceTelemetry.configure({ enabled: false });
            syncPerformanceTelemetry.reset();
        }
    });

    it('does not rebuild reachability display data for machine heartbeat-only updates', async () => {
        platformOs = 'android';
        const { syncPerformanceTelemetry } = await import('@/sync/runtime/syncPerformanceTelemetry');
        syncPerformanceTelemetry.configure({
            enabled: true,
            slowThresholdMs: 1_000_000,
            flushIntervalMs: 60_000,
        });
        syncPerformanceTelemetry.reset();

        try {
            const { useSessionListViewState } = await import('./view-state/useSessionListViewState');
            const hook = await renderHook(({ tick }: { tick: number }) => {
                void tick;
                return useSessionListViewState({
                    data: mockVisibleSessionListViewData,
                    pathname: '',
                });
            }, {
                initialProps: { tick: 0 },
            });

            syncPerformanceTelemetry.reset();
            readMachineTargetForSessionMock.mockClear();
            allMachines = allMachines.map((machine) => ({
                ...machine,
                seq: Number(machine.seq ?? 0) + 1,
                updatedAt: Number(machine.updatedAt ?? 0) + 1,
                daemonStateVersion: Number(machine.daemonStateVersion ?? 0) + 1,
            }));
            await hook.rerender({ tick: 1 });

            expect(syncPerformanceTelemetry.snapshot().events.some((event) =>
                event.name === 'ui.sessionsList.render.reachabilityDisplayMap'
            )).toBe(false);
            expect(readMachineTargetForSessionMock).not.toHaveBeenCalled();
            await hook.unmount();
        } finally {
            syncPerformanceTelemetry.configure({ enabled: false });
            syncPerformanceTelemetry.reset();
        }
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

    it('does not mark iOS rows as inline-draggable in date mode when the account has no folders', async () => {
        sessionListOrderingModeV1 = 'updated';
        sessionFolderViewModeV1 = 'tree';
        sessionFoldersV1 = { v: 1, folders: [] };

        const screen = await renderSessionsList();

        const first = expectPresent(findSessionItem(screen, 'sess_a'), 'expected sess_a session row');
        expect(first.props.reorderHandleGesture).toBeUndefined();
        expect(first.props.nativeInlineDragEnabled).toBeUndefined();
        expect(findRecordedGestureDetectors(screen)).toHaveLength(0);
    });

    it('opens the iOS native context menu immediately when the row long-press gesture activates', async () => {
        const screen = await renderSessionsList();
        const initialList = expectPresent(
            screen.root.findAll((node) => String(node.type) === 'FlashListCompat')[0],
            'expected native FlashListCompat',
        );
        const initialRenderItem = initialList.props.renderItem;
        const initialExtraData = initialList.props.extraData;
        const firstGesture = expectPresent(
            findRecordedGestureDetectors(screen)[0]?.props.gesture,
            'expected recorded native row gesture',
        );
        const longPress = findGestureByKind(firstGesture, 'longPress');

        expect(longPress?.__handlers.onStart).toBeTruthy();

        await act(async () => {
            longPress?.__handlers.onStart?.({});
        });

        const first = expectPresent(findSessionItem(screen, 'sess_a'), 'expected sess_a session row');
        expect(first.props.nativeContextMenuOpen).toBe(true);
        const openList = expectPresent(
            screen.root.findAll((node) => String(node.type) === 'FlashListCompat')[0],
            'expected native FlashListCompat after context menu open',
        );
        expect(openList.props.renderItem).toBe(initialRenderItem);
        expect(openList.props.extraData).not.toBe(initialExtraData);

        await act(async () => {
            first.props.onNativeContextMenuOpenChange(false);
        });

        const closed = expectPresent(findSessionItem(screen, 'sess_a'), 'expected sess_a session row after close');
        expect(closed.props.nativeContextMenuOpen).toBe(false);
    });

    it('suppresses iOS native context menu activation while the native list is being scrolled', async () => {
        const screen = await renderSessionsList();
        const list = expectPresent(
            screen.root.findAll((node) => String(node.type) === 'FlashListCompat')[0],
            'expected native FlashListCompat',
        );
        const firstGesture = expectPresent(
            findRecordedGestureDetectors(screen)[0]?.props.gesture,
            'expected recorded native row gesture',
        );
        const longPress = findGestureByKind(firstGesture, 'longPress');

        expect(typeof list.props.onScrollBeginDrag).toBe('function');
        expect(typeof list.props.onScrollEndDrag).toBe('function');

        await act(async () => {
            list.props.onScrollBeginDrag?.();
            longPress?.__handlers.onBegin?.({});
            longPress?.__handlers.onStart?.({});
        });

        const suppressed = expectPresent(
            findSessionItem(screen, 'sess_a'),
            'expected sess_a session row after suppressed long press',
        );
        expect(suppressed.props.nativeContextMenuOpen).toBe(false);

        await act(async () => {
            list.props.onScrollEndDrag?.();
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
        const list = expectPresent(
            screen.root.findAll((node) => String(node.type) === 'FlashListCompat')[0],
            'expected native FlashListCompat',
        );
        const first = expectPresent(findSessionItem(screen, 'sess_a'), 'expected sess_a session row');

        await act(async () => {
            first.props.onNativeContextMenuOpenChange(true);
        });

        const opened = expectPresent(findSessionItem(screen, 'sess_a'), 'expected sess_a session row after open');
        expect(opened.props.nativeContextMenuOpen).toBe(true);

        await act(async () => {
            list.props.onScrollBeginDrag?.();
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

    it('does not wrap Android rows in drag or context-menu long-press gestures', async () => {
        platformOs = 'android';

        const screen = await renderSessionsList();

        const first = expectPresent(findSessionItem(screen, 'sess_a'), 'expected sess_a session row');
        expect(first.props.reorderHandleGesture).toBeUndefined();
        expect(first.props.nativeInlineDragEnabled).toBeUndefined();
        expect(first.props.nativeContextMenuOpen).toBeUndefined();
        expect(first.props.onNativeContextMenuOpenChange).toBeUndefined();
        expect(findRecordedGestureDetectors(screen)).toHaveLength(0);
    });

    it('passes scroll and viewport events to session-list drag autoscroll on native lists', async () => {
        const screen = await renderSessionsList();
        const list = expectPresent(
            screen.root.findAll((node) => String(node.type) === 'FlashListCompat')[0],
            'expected native FlashListCompat',
        );

        expect(typeof list.props.onScroll).toBe('function');
        expect(typeof list.props.onLayout).toBe('function');
        expect(typeof list.props.onContentSizeChange).toBe('function');
        expect(list.props.scrollEventThrottle).toBe(16);
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

    it('routes the project add action into a prefilled new-session flow', async () => {
        mockVisibleSessionListViewData = [
            {
                type: 'header',
                title: '/repo',
                headerKind: 'project',
                groupKey: 'server:server_a:active:project:abc',
                workspaceKey: 'wl_abc',
                workspaceScopeHint: {
                    serverId: 'server_a',
                    machineId: 'machine-target',
                    rootPath: '/repo',
                },
                serverId: 'server_a',
                serverName: 'Server A',
            },
        ];

        const screen = await renderSessionsList();
        const addButton = expectPresent(
            findPressableByAccessibilityLabel(screen, 'machine.launchNewSessionInDirectory'),
            'expected always-visible project add action',
        );

        await act(async () => {
            addButton.props.onPress();
        });

        expect(routerPushSpy).toHaveBeenCalledWith({
            pathname: '/new',
            params: {
                machineId: 'machine-target',
                directory: '/repo',
                spawnServerId: 'server_a',
            },
        });
    });

    it('rebases the project add action onto the reachable machine workspace', async () => {
        rememberLastProjectSessionSelections = false;
        storageState.sessions.seed_sess = {
            ...sessionA,
            id: 'seed_sess',
            metadata: {
                ...sessionA.metadata,
                machineId: 'machine-target',
                path: '/home/coder/repo',
            },
        };
        readMachineTargetForSessionMock.mockImplementation((sessionId: string) =>
            sessionId === 'seed_sess'
                ? {
                    machineId: 'machine-target',
                    basePath: '/Users/test/repo',
                    agentBasePath: '/home/coder/repo',
                    confidence: 'reachable',
                }
                : null,
        );
        mockVisibleSessionListViewData = [
            {
                type: 'header',
                title: '/home/coder/repo',
                headerKind: 'project',
                groupKey: 'server:server_a:active:project:abc',
                workspaceKey: 'wl_abc',
                seedSessionId: 'seed_sess',
                workspaceScopeHint: {
                    serverId: 'server_a',
                    machineId: 'machine-target',
                    rootPath: '/home/coder/repo',
                },
                serverId: 'server_a',
                serverName: 'Server A',
            },
        ];

        const screen = await renderSessionsList();
        const addButton = expectPresent(
            findPressableByAccessibilityLabel(screen, 'machine.launchNewSessionInDirectory'),
            'expected project add action',
        );

        await act(async () => {
            addButton.props.onPress();
        });

        expect(routerPushSpy).toHaveBeenCalledWith({
            pathname: '/new',
            params: {
                machineId: 'machine-target',
                directory: '/Users/test/repo',
                spawnServerId: 'server_a',
            },
        });
    });

    it('uses the latest project session configuration when the remember setting is enabled', async () => {
        rememberLastProjectSessionSelections = true;
        storageState.sessions.seed_sess = {
            id: 'seed_sess',
            active: true,
            createdAt: 20,
            updatedAt: 30,
            seq: 3,
            encryptionMode: 'plain',
            metadata: {
                machineId: 'machine-source',
                path: '/repo/source',
                homeDir: '/repo',
                host: 'source.local',
                flavor: 'codex',
                profileId: 'profile-1',
                transcriptStorage: 'direct',
                codexBackendMode: 'appServer',
                sessionModeOverrideV1: {
                    v: 1,
                    updatedAt: 100,
                    modeId: 'plan',
                },
                sessionConfigOptionOverridesV1: {
                    v: 1,
                    updatedAt: 101,
                    overrides: {
                        effort: { updatedAt: 101, value: 'high' },
                    },
                },
            },
            permissionMode: 'safe-yolo',
            permissionModeUpdatedAt: 102,
            modelMode: 'gpt-5',
            modelModeUpdatedAt: 103,
        };
        mockVisibleSessionListViewData = [
            {
                type: 'header',
                title: '/repo',
                headerKind: 'project',
                groupKey: 'server:server_a:active:project:abc',
                workspaceKey: 'wl_abc',
                seedSessionId: 'seed_sess',
                workspaceScopeHint: {
                    serverId: 'server_a',
                    machineId: 'machine-target',
                    rootPath: '/repo',
                },
                serverId: 'server_a',
                serverName: 'Server A',
            },
        ];

        const screen = await renderSessionsList();
        const addButton = expectPresent(
            findPressableByAccessibilityLabel(screen, 'machine.launchNewSessionInDirectory'),
            'expected project add action',
        );

        await act(async () => {
            addButton.props.onPress();
        });

        const pushArg = routerPushSpy.mock.calls[0]?.[0] as any;
        expect(pushArg).toEqual({
            pathname: '/new',
            params: {
                dataId: expect.any(String),
                machineId: 'machine-target',
                directory: '/repo',
                spawnServerId: 'server_a',
            },
        });
        const tempData = peekTempData<NewSessionData>(pushArg.params.dataId);
        expect(tempData).toEqual(expect.objectContaining({
            prompt: '',
            replacePersistedDraftSelections: true,
            machineId: 'machine-target',
            directory: '/repo',
            agentType: 'codex',
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            selectedProfileId: 'profile-1',
            transcriptStorage: 'direct',
            permissionMode: 'safe-yolo',
            modelMode: 'gpt-5',
            codexBackendMode: 'appServer',
            acpSessionModeId: 'plan',
            sessionConfigOptionOverrides: {
                v: 1,
                updatedAt: 101,
                overrides: {
                    effort: { updatedAt: 101, value: 'high' },
                },
            },
        }));
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
        expect(readMachineTargetForSessionMock).toHaveBeenCalledTimes(1);
        expect(readMachineTargetForSessionMock).toHaveBeenCalledWith('sess_b');
    });

    it('shows project chevrons only on hover unless the group is collapsed, while keeping the add action visible', async () => {
        platformOs = 'web';
        const { ProjectGroupHeader } = await import('./SessionsList');

        const screen = await renderScreen(
            <ProjectGroupHeader
                item={{
                    type: 'header',
                    title: '/repo',
                    headerKind: 'project',
                    groupKey: 'server:server_a:active:project:abc',
                    workspaceKey: 'wl_abc',
                    workspaceScopeHint: {
                        serverId: 'server_a',
                        machineId: 'machine-target',
                        rootPath: '/repo',
                    },
                    serverId: 'server_a',
                    serverName: 'Server A',
                } as any}
                hasMultipleMachines={false}
                workspaceLabelsV1={{}}
                onRenameWorkspace={vi.fn()}
                onResetWorkspaceName={vi.fn()}
                onCreateSession={vi.fn()}
                onAddFolder={vi.fn()}
                collapsed={false}
                onToggleCollapse={vi.fn()}
                headerTestId="project-header"
            />,
        );

        const header = screen.root.findAllByType('Pressable')[0];
        expect(findPressableByAccessibilityLabel(screen as any, 'machine.launchNewSessionInDirectory')).toBeTruthy();
        expect(findChevronOpacityForHeaderPressable(header)).toBe(0);
        expect(screen.root.findAllByType('DropdownMenu')).toHaveLength(0);

        await act(async () => {
            header.props.onHoverIn?.();
        });

        expect(findChevronOpacityForHeaderPressable(screen.root.findAllByType('Pressable')[0])).toBe(1);
        expect(screen.root.findAllByType('DropdownMenu')).toHaveLength(1);
        const menuTrigger = expectPresent(
            findPressableByAccessibilityLabel(screen as any, 'common.moreActions'),
            'expected project menu trigger while hovered',
        );

        await act(async () => {
            menuTrigger.props.onHoverIn?.();
            screen.root.findAllByType('Pressable')[0].props.onHoverOut?.();
        });

        expect(findPressableByAccessibilityLabel(screen as any, 'common.moreActions')).toBeTruthy();
        expect(screen.root.findAllByType('DropdownMenu')).toHaveLength(1);

        await act(async () => {
            menuTrigger.props.onHoverOut?.();
            screen.root.findAllByType('Pressable')[0].props.onHoverOut?.();
        });

        expect(findChevronOpacityForHeaderPressable(screen.root.findAllByType('Pressable')[0])).toBe(0);

        const collapsedScreen = await renderScreen(
            <ProjectGroupHeader
                item={{
                    type: 'header',
                    title: '/repo',
                    headerKind: 'project',
                    groupKey: 'server:server_a:active:project:abc',
                    workspaceKey: 'wl_abc',
                    workspaceScopeHint: {
                        serverId: 'server_a',
                        machineId: 'machine-target',
                        rootPath: '/repo',
                    },
                    serverId: 'server_a',
                    serverName: 'Server A',
                } as any}
                hasMultipleMachines={false}
                workspaceLabelsV1={{}}
                onRenameWorkspace={vi.fn()}
                onResetWorkspaceName={vi.fn()}
                onCreateSession={vi.fn()}
                onAddFolder={vi.fn()}
                collapsed={true}
                onToggleCollapse={vi.fn()}
                headerTestId="project-header-collapsed"
            />,
        );
        const collapsedHeader = collapsedScreen.root.findAllByType('Pressable')[0];
        expect(findChevronOpacityForHeaderPressable(collapsedHeader)).toBe(1);
    });

    it('does not nest project header pressable controls inside another pressable on web', async () => {
        platformOs = 'web';
        const { ProjectGroupHeader } = await import('./SessionsList');

        const screen = await renderScreen(
            <ProjectGroupHeader
                item={{
                    type: 'header',
                    title: '/repo',
                    headerKind: 'project',
                    groupKey: 'server:server_a:active:project:abc',
                    workspaceKey: 'wl_abc',
                    workspaceScopeHint: {
                        serverId: 'server_a',
                        machineId: 'machine-target',
                        rootPath: '/repo',
                    },
                    serverId: 'server_a',
                    serverName: 'Server A',
                } as any}
                hasMultipleMachines={false}
                workspaceLabelsV1={{}}
                onRenameWorkspace={vi.fn()}
                onResetWorkspaceName={vi.fn()}
                onCreateSession={vi.fn()}
                onAddFolder={vi.fn()}
                collapsed={false}
                onToggleCollapse={vi.fn()}
                headerTestId="project-header"
            />,
        );

        for (const pressable of screen.root.findAllByType('Pressable')) {
            expect(childTreeContainsType(pressable, 'Pressable')).toBe(false);
        }
    });

    it('shows detected workspace favicons on project headers when enabled', async () => {
        platformOs = 'web';
        resolveWorkspaceFaviconMock.mockResolvedValueOnce({
            status: 'found',
            uri: 'data:image/svg+xml;base64,PHN2Zy8+',
            relativePath: 'public/favicon.svg',
        });
        const { ProjectGroupHeader } = await import('./SessionsList');

        const screen = await renderScreen(
            <ProjectGroupHeader
                item={{
                    type: 'header',
                    title: 'repo',
                    headerKind: 'project',
                    groupKey: 'server:server_a:active:project:abc',
                    workspaceKey: 'wl_abc',
                    workspaceScopeHint: {
                        serverId: 'server_a',
                        machineId: 'machine-target',
                        rootPath: '/repo',
                    },
                } as any}
                hasMultipleMachines={false}
                workspaceLabelsV1={{}}
                workspaceFaviconsEnabled={true}
                onRenameWorkspace={vi.fn()}
                onResetWorkspaceName={vi.fn()}
                onCreateSession={vi.fn()}
                onAddFolder={vi.fn()}
                collapsed={false}
                onToggleCollapse={vi.fn()}
                headerTestId="project-header-favicon"
            />,
        );

        await act(async () => {
            await Promise.resolve();
        });

        expect(resolveWorkspaceFaviconMock).toHaveBeenCalledWith(expect.objectContaining({
            enabled: true,
            serverId: 'server_a',
            machineId: 'machine-target',
            workspacePath: '/repo',
        }));
        const images = screen.root.findAllByType('Image' as any);
        expect(images).toHaveLength(1);
        expect(images[0].props.source).toEqual({ uri: 'data:image/svg+xml;base64,PHN2Zy8+' });
        expect(screen.root.findByProps({ testID: 'session-list-workspace-favicon' }).props.style).toEqual(expect.objectContaining({
            width: 16,
            minWidth: 16,
            height: 16,
            flexShrink: 0,
        }));
        expect(images[0].props.style).toEqual(expect.arrayContaining([
            expect.objectContaining({
                width: 16,
                height: 16,
                borderRadius: 4,
            }),
        ]));
        expect(images[0].props.contentFit).toBe('cover');
    });

    it('hides expanded section chevrons until hover on web and keeps date headers on the subheader typography tier', async () => {
        platformOs = 'web';
        const { CollapsibleSectionHeader, ProjectGroupHeader } = await import('./SessionsList');

        const activeScreen = await renderScreen(
            <CollapsibleSectionHeader
                title="Active"
                headerKind="active"
                collapsed={false}
                onPress={vi.fn()}
                headerTestId="active-header"
            />,
        );
        const projectScreen = await renderScreen(
            <ProjectGroupHeader
                item={{
                    type: 'header',
                    title: '/repo',
                    headerKind: 'project',
                    groupKey: 'server:server_a:active:project:abc',
                    workspaceKey: 'wl_abc',
                    workspaceScopeHint: {
                        serverId: 'server_a',
                        machineId: 'machine-target',
                        rootPath: '/repo',
                    },
                } as any}
                hasMultipleMachines={false}
                workspaceLabelsV1={{}}
                onRenameWorkspace={vi.fn()}
                onResetWorkspaceName={vi.fn()}
                onCreateSession={vi.fn()}
                onAddFolder={vi.fn()}
                collapsed={false}
                onToggleCollapse={vi.fn()}
                headerTestId="project-header"
            />,
        );
        const yesterdayScreen = await renderScreen(
            <CollapsibleSectionHeader
                title="Yesterday"
                headerKind="date"
                collapsed={false}
                onPress={vi.fn()}
                headerTestId="yesterday-header"
            />,
        );

        const activeHeader = activeScreen.root.findAllByType('Pressable')[0];
        const projectHeader = projectScreen.root.findAllByType('Pressable')[0];
        const yesterdayHeader = yesterdayScreen.root.findAllByType('Pressable')[0];
        expect(findChevronOpacityForHeaderPressable(activeHeader)).toBe(0);
        expect(findChevronOpacityForHeaderPressable(yesterdayHeader)).toBe(0);

        await act(async () => {
            yesterdayHeader.props.onHoverIn?.();
        });

        expect(findChevronOpacityForHeaderPressable(yesterdayScreen.root.findAllByType('Pressable')[0])).toBe(1);

        const activeTextStyle = flattenStyle(activeHeader.findAllByType('Text')[0]?.props?.style);
        const yesterdayTextStyle = flattenStyle(yesterdayHeader.findAllByType('Text')[0]?.props?.style);
        const projectTextStyle = flattenStyle(projectHeader.findAllByType('Text')[0]?.props?.style);

        expect(yesterdayTextStyle.fontSize).toBe(projectTextStyle.fontSize);
        expect(Number(activeTextStyle.fontSize)).toBeGreaterThan(Number(yesterdayTextStyle.fontSize));
    });

    it('wires pin toggling through server-backed organization ops', async () => {
        sessionOrganizationOps.setSessionPin.mockClear();

        const screen = await renderSessionsList();
        const first = expectPresent(findSessionItem(screen, 'sess_a'), 'expected first session item');
        expect(typeof first.props.onTogglePinned).toBe('function');

        await act(async () => {
            first.props.onTogglePinned();
        });

        expect(sessionOrganizationOps.setSessionPin).toHaveBeenCalledTimes(1);
        expect(sessionOrganizationOps.setSessionPin).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'sess_a',
            pinned: true,
        }));
        expect(setPinnedSessionKeysV1).not.toHaveBeenCalled();
    });

    it('writes session tags through server-backed organization ops', async () => {
        sessionTagsV1 = { 'server_a:sess_a': ['important'] };
        sessionOrganizationOps.setSessionTagLabels.mockClear();

        const screen = await renderSessionsList();
        const first = expectPresent(findSessionItem(screen, 'sess_a'), 'expected first session item');
        expect(typeof first.props.onSetTags).toBe('function');
        await act(async () => {
            first.props.onSetTags(['urgent']);
        });

        expect(sessionOrganizationOps.setSessionTagLabels).toHaveBeenCalledTimes(1);
        expect(sessionOrganizationOps.setSessionTagLabels).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'sess_a',
            tags: ['urgent'],
        }));
        expect(setSessionTagsV1).not.toHaveBeenCalled();
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
        expect(item.props.rowModel?.subtitle).toBe('Rebound workstation · repo');
    });

    it('keeps reachability subtitles scoped when servers share a session id', async () => {
        platformOs = 'android';
        const sharedSession = {
            ...sessionA,
            id: 'shared-session',
        };
        storageState = {
            sessions: {},
            machines: {},
            getProjectForSession: () => null,
        };
        machineDisplayById = {
            'machine-a': {
                id: 'machine-a',
                updatedAt: 10,
                active: true,
                activeAt: 10,
                revokedAt: null,
                metadataVersion: 1,
                metadata: {
                    displayName: 'Machine A',
                    host: 'a.local',
                    homeDir: '/Users/test',
                },
            },
            'machine-b': {
                id: 'machine-b',
                updatedAt: 10,
                active: true,
                activeAt: 10,
                revokedAt: null,
                metadataVersion: 1,
                metadata: {
                    displayName: 'Machine B',
                    host: 'b.local',
                    homeDir: '/Users/test',
                },
            },
        };
        mockAllowedServerIds = ['server_a', 'server_b'];
        mockVisibleSessionListViewData = [
            {
                type: 'session',
                session: {
                    ...sharedSession,
                    metadata: {
                        machineId: 'machine-a',
                        path: '/Users/test/workspace/a',
                        homeDir: '/Users/test',
                        host: 'a.local',
                    },
                },
                groupKey: 'server:server_a:project:a',
                groupKind: 'project',
                serverId: 'server_a',
                serverName: 'Server A',
            },
            {
                type: 'session',
                session: {
                    ...sharedSession,
                    metadata: {
                        machineId: 'machine-b',
                        path: '/Users/test/workspace/b',
                        homeDir: '/Users/test',
                        host: 'b.local',
                    },
                },
                groupKey: 'server:server_b:project:b',
                groupKind: 'project',
                serverId: 'server_b',
                serverName: 'Server B',
            },
        ];

        const screen = await renderSessionsList();
        const rows = screen.root.findAll((node) =>
            String(node.type) === 'SessionItem'
            && node.props?.session?.id === 'shared-session'
        );

        expect(rows).toHaveLength(2);
        expect(rows[0]?.props.rowModel?.rowKey).toBe('server_a:shared-session');
        expect(rows[0]?.props.rowModel?.subtitle).toBe('Machine A · a');
        expect(rows[1]?.props.rowModel?.rowKey).toBe('server_b:shared-session');
        expect(rows[1]?.props.rowModel?.subtitle).toBe('Machine B · b');
    });

    it('uses start-side overflow ellipsis for workspace path headers on web without reordering the path', async () => {
        platformOs = 'web';
        const { ProjectGroupHeader } = await import('./SessionsList');
        const workspacePath = '~/Documents/Development/happier/remote-dev';
        const projectHeaderItem = {
            type: 'header',
            title: workspacePath,
            headerKind: 'project',
            groupKey: 'server:server_a:active:project:abc',
            workspaceKey: 'wl_abc',
            workspaceScopeHint: {
                serverId: 'server_a',
                machineId: 'machine-target',
                rootPath: '/Users/test/Documents/Development/happier/remote-dev',
            },
            serverId: 'server_a',
            serverName: 'Server A',
        } satisfies Extract<SessionListViewItem, { type: 'header' }>;

        const screen = await renderScreen(
            <ProjectGroupHeader
                item={projectHeaderItem}
                hasMultipleMachines={false}
                workspaceLabelsV1={{}}
                onRenameWorkspace={vi.fn()}
                onResetWorkspaceName={vi.fn()}
                onCreateSession={vi.fn()}
                onAddFolder={vi.fn()}
                collapsed={false}
                onToggleCollapse={vi.fn()}
                headerTestId="project-header"
            />,
        );

        const outerTitle = screen.root.findAll((node) =>
            String(node.type) === 'Text'
            && node.props.numberOfLines === 1,
        )[0];
        const innerTitle = screen.root.findAll((node) =>
            String(node.type) === 'Text'
            && node.props.children === workspacePath,
        )[0];

        expect(outerTitle).toBeTruthy();
        expect(innerTitle).toBeTruthy();
        expect(flattenStyle(outerTitle?.props.style)).toMatchObject({
            writingDirection: 'rtl',
            textAlign: 'left',
        });
        expect(flattenStyle(innerTitle?.props.style)).toMatchObject({
            writingDirection: 'ltr',
            unicodeBidi: 'isolate',
        });
    });

    it('uses native head ellipsis for workspace path headers outside web', async () => {
        platformOs = 'ios';
        const { ProjectGroupHeader } = await import('./SessionsList');
        const workspacePath = '~/Documents/Development/happier/remote-dev';
        const projectHeaderItem = {
            type: 'header',
            title: workspacePath,
            headerKind: 'project',
            groupKey: 'server:server_a:active:project:abc',
            workspaceKey: 'wl_abc',
            workspaceScopeHint: {
                serverId: 'server_a',
                machineId: 'machine-target',
                rootPath: '/Users/test/Documents/Development/happier/remote-dev',
            },
            serverId: 'server_a',
            serverName: 'Server A',
        } satisfies Extract<SessionListViewItem, { type: 'header' }>;

        const screen = await renderScreen(
            <ProjectGroupHeader
                item={projectHeaderItem}
                hasMultipleMachines={false}
                workspaceLabelsV1={{}}
                onRenameWorkspace={vi.fn()}
                onResetWorkspaceName={vi.fn()}
                onCreateSession={vi.fn()}
                onAddFolder={vi.fn()}
                collapsed={false}
                onToggleCollapse={vi.fn()}
                headerTestId="project-header"
            />,
        );

        const title = screen.root.findAll((node) =>
            String(node.type) === 'Text'
            && node.props.children === workspacePath
            && node.props.numberOfLines === 1,
        )[0];

        expect(title?.props.ellipsizeMode).toBe('head');
    });
});
