import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// This list-shell test does not exercise Markdown. The patched package subpath
// is a genuine third-party boundary and may be absent before UI postinstall.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({
    splitStreamingRevealTextParts: () => [],
}));

import { findGestureByKind, renderScreen, standardCleanup } from '@/dev/testkit';
import { SESSION_LIST_ROW_HEIGHT_DEFAULT } from './sessionListRowHeights';
import { installSessionShellCommonModuleMocks } from './sessionShellTestHelpers';
import { buildSessionListIndexFromViewData, buildSessionListIndexNodeId } from '@/sync/domains/sessionList/sessionListIndex';
import { buildSessionListServerScopedRowKey } from '@/sync/domains/session/listing/sessionListKeyNormalization';
import { localSettingsDefaults, type LocalSettings } from '@/sync/domains/settings/localSettings';
import { clearSessionListViewFilterRetentionForTests } from './search/useSessionListViewFilters';
import { buildSessionOrganizationProjectionFromLegacyTestSettings } from './sessionOrganizationProjectionTestFixture';
import { createUseSettingMock, createUseSettingMutableMockFromReader } from '@/dev/testkit/mocks/storage';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let pinnedSessionKeysV1: string[] = [];
let sessionMruOrderV1: string[] = [];
const setSessionMruOrderV1 = vi.fn();
const readMachineTargetForSessionMock = vi.hoisted(() => vi.fn());
const navigateToSessionSpy = vi.hoisted(() => vi.fn());
const routerPushSpy = vi.hoisted(() => vi.fn());
const openUniversalSearchSpy = vi.hoisted(() => vi.fn());
const fetchMoreSessionsMock = vi.hoisted(() => vi.fn(async () => undefined));
const refreshSessionsMock = vi.hoisted(() => vi.fn<() => Promise<undefined>>(async () => undefined));
const markSessionListScrollActivityMock = vi.hoisted(() => vi.fn());
const preloadEnrichedMarkdownRuntimeSpy = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const setSessionPinOp = vi.hoisted(() => vi.fn(async () => undefined));
const setSessionTagAssignmentsOp = vi.hoisted(() => vi.fn(async () => undefined));
const exactHomeCredentialAccounts = vi.hoisted(() => new Map<string, string>());
const keyboardShortcutHandlersRef = vi.hoisted(() => ({
    current: null as Record<string, (() => void)> | null,
}));
const layoutMaxWidthStyle = vi.hoisted(() => ({ maxWidth: 1280 } as const));
let mockPathname = '';
let platformOs: 'ios' | 'android' = 'ios';
let filteredListingEnabled = false;
let previousRealStorageState: ReturnType<typeof import('@/sync/domains/state/storageStore').storage.getState> | undefined;

vi.mock('@/components/appShell/search/UniversalSearchRuntimeContext', () => ({
    useUniversalSearchRuntime: () => ({
        open: openUniversalSearchSpy,
        buildCommands: vi.fn(),
    }),
}));

let sessionTagsV1: Record<string, string[]> = {};
let sessionListOrderingModeV1: 'custom' | 'created' | 'updated' = 'custom';
let sessionListIdentityDisplay: 'avatar' | 'agentLogo' | 'none' = 'avatar';
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
        reset(): void;
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
    clearSessionListRowsForServerScope: (serverId: string) => {
        const nextRowsByServerId = { ...storageState.sessionListRowsByServerId };
        delete nextRowsByServerId[serverId];
        storageState.sessionListRowsByServerId = nextRowsByServerId;
    },
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
const defaultProjectGroupKey = 'server:server_a:project:default';

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

vi.mock('@/constants/Typography', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/constants/Typography')>();
    return {
        ...actual,
        FontWeights: {
            regular: '400',
            semiBold: '500',
            bold: '600',
        },
        Typography: {
            ...actual.Typography,
            default: () => ({}),
            mono: () => ({}),
            pillLabel: () => ({}),
            rowMeta: () => ({}),
        },
    };
});

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


vi.mock('@/components/ui/layout/layout', () => ({
    layout: { maxWidth: 1280 },
    useLayoutMaxWidthStyle: () => layoutMaxWidthStyle,
    useLayoutMaxWidth: () => 1280,
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: any) => React.createElement('DropdownMenu', props),
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
    useDeviceType: () => 'phone',
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
                ? storageState.sessionListRowsByServerId?.[normalizedServerId]?.[normalizedSessionId]
                : null;
            return scopedRow ?? null;
        };
        const buildRowRenderableMapForItems = (items: readonly any[] | null | undefined) => {
            const next = new Map<string, any>();
            for (const item of items ?? []) {
                if (!item || item.type !== 'session') continue;
                const serverId = typeof item.serverId === 'string' ? item.serverId.trim() : '';
                const sessionId = typeof item.sessionId === 'string' ? item.sessionId.trim() : '';
                if (!serverId || !sessionId) continue;
                const row = resolveRowRenderableForTest(serverId, sessionId);
                const key = buildSessionListServerScopedRowKey(serverId, sessionId);
                if (row && key) next.set(key, row);
            }
            return next;
        };
        return createStorageModuleMock({
            importOriginal,
            overrides: {
                useSetting: createUseSettingMock({ fallback: (key) => {
                    if (key === 'compactSessionView') return false;
                    if (key === 'compactSessionViewMinimal') return false;
                    if (key === 'sessionListIdentityDisplay') return sessionListIdentityDisplay;
                    if (key === 'sessionTagsEnabled') return true;
                    if (key === 'sessionListOrderingModeV1') return sessionListOrderingModeV1;
                    if (key === 'workspaceRefsV1') return workspaceRefsV1;
                    if (key === 'workspacePathDisplayModeV1') return workspacePathDisplayModeV1;
                    return null;
                } }),
                useSettings: () => {
                    throw new Error('SessionsList must subscribe only to settings that affect its rendered output');
                },
                useHasUnreadMessages: () => false,
                useMachineDisplayById: () => Object.fromEntries(
                    allMachines.map((machine) => [machine.id, buildMachineDisplayRenderableFromMachine(machine as any)]),
                ),
                useSettingMutable: createUseSettingMutableMockFromReader((key) => {
                    if (key === 'sessionListOrderingModeV1') return [sessionListOrderingModeV1, setSessionListOrderingModeV1];
                    if (key === 'workspaceRefsV1') return [workspaceRefsV1, setWorkspaceRefsV1];
                    return [null, vi.fn()];
                }),
                useLocalSetting: <K extends keyof LocalSettings>(key: K): LocalSettings[K] => ({
                    ...localSettingsDefaults,
                    sessionMruOrderV1,
                })[key],
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
                useSessionOrganizationProjections: (serverIds: readonly string[]) => React.useMemo(
                    () => Object.fromEntries(serverIds.map((serverId) => [
                        serverId,
                        buildSessionOrganizationProjectionFromLegacyTestSettings({
                            serverId,
                            pinnedSessionKeysV1,
                            sessionTagsV1,
                        }),
                    ])),
                    [serverIds.join('\u0000'), pinnedSessionKeysV1, sessionTagsV1],
                ),
                useSessionListRenderableWithServerScope: (_serverId: any, sessionId: string) => {
                    if (sessionId === 'sess_a') return sessionA as any;
                    if (sessionId === 'sess_b') return sessionB as any;
                    return null;
                },
                useSessionListRowRenderablesForItems: buildRowRenderableMapForItems,
                useSessionListRowsByServerId: () => ({
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
    writeSessionOrganizationTagLabels: setSessionTagAssignmentsOp,
    writeSessionOrganizationWorkspaceLabels: vi.fn(async () => undefined),
    writeSessionOrganizationWorkspaceOrder: vi.fn(async () => undefined),
}));

vi.mock('@/sync/domains/server/serverProfiles', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/domains/server/serverProfiles')>();
    const serverProfiles = [{ id: 'server_a', serverUrl: 'https://server-a.example.test' }];
    const readServerProfiles = () => exactHomeCredentialAccounts.has('server_b')
        ? [...serverProfiles, { id: 'server_b', serverUrl: 'https://server-b.example.test' }]
        : serverProfiles;
    return {
        ...actual,
        listServerProfiles: readServerProfiles,
        getServerProfileById: (serverId: string) => readServerProfiles().find((profile) => profile.id === serverId) ?? null,
    };
});

vi.mock('@/auth/storage/tokenStorage', async (importOriginal) => {
    const { createTokenStorageModuleMock } = await import('@/dev/testkit/mocks/tokenStorage');
    return await createTokenStorageModuleMock({
        importOriginal,
        tokenStorage: {
            getCredentialsForServerUrl: vi.fn(async (serverUrl: string) => {
                const accountId = exactHomeCredentialAccounts.get(serverUrl.includes('server-b') ? 'server_b' : 'server_a');
                return {
                    token: accountId === 'account-b'
                        ? 'header.eyJzdWIiOiJhY2NvdW50LWIifQ==.signature'
                        : accountId === 'account-a'
                            ? 'header.eyJzdWIiOiJhY2NvdW50LWEifQ==.signature'
                            : 'test-token',
                };
            }),
        },
    });
});

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
    useFeatureEnabled: (featureId: string) => (
        featureId === 'sessions.folders'
        || (featureId === 'sessions.filteredListing' && filteredListingEnabled)
    ),
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
        title: 'Project',
        headerKind: 'project',
        groupKey: defaultProjectGroupKey,
        serverId: 'server_a',
        serverName: 'Server A',
    },
    {
        type: 'session',
        session: sessionA,
        groupKey: defaultProjectGroupKey,
        groupKind: 'project',
        serverId: 'server_a',
        serverName: 'Server A',
    },
    {
        type: 'session',
        session: sessionB,
        groupKey: defaultProjectGroupKey,
        groupKind: 'project',
        serverId: 'server_a',
        serverName: 'Server A',
    },
];

vi.mock('@/hooks/session/useVisibleSessionListPaneState', async () => {
    const { useSessionListFeatureHomeSupportByServerId } = await import('@/sync/domains/session/listing/useSessionListQuerySourceState');
    return {
        useVisibleSessionListPaneState: () => {
            const folderSupport = useSessionListFeatureHomeSupportByServerId('sessions.folders', mockAllowedServerIds, true);
            return {
                summary: {
                    sessionsReady: true,
                    sessionCount: mockVisibleSessionListViewData.filter((item) => item.type === 'session').length,
                },
                visibleSessionListIndex: buildSessionListIndexFromViewData(mockVisibleSessionListViewData),
                folderFeatureEnabledServerIds: mockAllowedServerIds.filter((serverId) => folderSupport[serverId] === true),
                showLoading: false,
                showEmptyState: false,
            };
        },
    };
});

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
            title: 'Project',
            headerKind: 'project',
            groupKey: defaultProjectGroupKey,
            serverId: 'server_a',
            serverName: 'Server A',
        },
        {
            type: 'session',
            session: sessionA,
            groupKey: defaultProjectGroupKey,
            groupKind: 'project',
            serverId: 'server_a',
            serverName: 'Server A',
        },
        {
            type: 'session',
            session: sessionB,
            groupKey: defaultProjectGroupKey,
            groupKind: 'project',
            serverId: 'server_a',
            serverName: 'Server A',
        },
    ];
}

async function renderSessionsList(props: React.ComponentProps<typeof import('./SessionsList').SessionsList> = {}) {
    const { SessionsList } = await import('./SessionsList');
    return renderScreen(<SessionsList {...props} />);
}

async function renderSessionsListWithSurfaceOwnership(surfaceOwnership: Readonly<{
    interactive?: boolean;
    dataActive?: boolean;
    visible?: boolean;
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
        virtualizedListState.current?.reset();
        sessionListOrderingModeV1 = 'custom';
        sessionListIdentityDisplay = 'avatar';
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
        routerPushSpy.mockClear();
        openUniversalSearchSpy.mockClear();
        fetchMoreSessionsMock.mockClear();
        refreshSessionsMock.mockReset();
        refreshSessionsMock.mockResolvedValue(undefined);
        markSessionListScrollActivityMock.mockClear();
        preloadEnrichedMarkdownRuntimeSpy.mockClear();
        keyboardShortcutHandlersRef.current = null;
        exactHomeCredentialAccounts.clear();
        clearSessionListViewFilterRetentionForTests();
        const { resetSessionListPaneRetentionForTests } = await import('./sessionListPaneRetention');
        resetSessionListPaneRetentionForTests();
        mockAllowedServerIds = ['server_a'];
        platformOs = 'ios';
        filteredListingEnabled = false;
        workspacePathDisplayModeV1 = null;
        readMachineTargetForSessionMock.mockReset();
        readMachineTargetForSessionMock.mockImplementation(() => null);
        resetVisibleSessionListViewData();
        storageState.sessionListRowsByServerId = {
            server_a: {
                sess_a: sessionA,
                sess_b: sessionB,
            },
        };
        const { storage: realStorage } = await import('@/sync/domains/state/storageStore');
        previousRealStorageState = realStorage.getState();
        realStorage.setState({ sessionListRowsByServerId: storageState.sessionListRowsByServerId });
        const { resetServerFeaturesClientForTests, primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
        resetServerFeaturesClientForTests();
        primeServerFeaturesSnapshot({
            serverId: 'server_a',
            snapshot: { status: 'ready', features: createRootLayoutFeaturesResponse({
                features: { sessions: { folders: { enabled: false } } },
            }) },
        });
    });

    afterEach(async () => {
        standardCleanup();
        const { storage: realStorage } = await import('@/sync/domains/state/storageStore');
        if (previousRealStorageState) realStorage.setState(previousRealStorageState, true);
        const { resetServerFeaturesClientForTests } = await import('@/sync/api/capabilities/serverFeaturesClient');
        resetServerFeaturesClientForTests();
    });

    it('preloads the transcript markdown runtime before a session is opened from the list', async () => {
        await renderSessionsList();
        expect(preloadEnrichedMarkdownRuntimeSpy).toHaveBeenCalledOnce();
    });

    it('defers bulk action targets until selection opens and rebuilds current targets when reopened', async () => {
        const screen = await renderSessionsList();
        const { SessionsList } = await import('./SessionsList');
        const { buildServerScopedSessionKey } = await import('@/sync/domains/session/navigation/sessionNavigationOrder');
        const selectedKey = buildServerScopedSessionKey('sess_a', 'server_a');
        const { SessionListSelectionStoreProvider } = await import('./selection/SessionListSelectionContext');
        const { SessionListSelectionActionBarHost } = await import('./selection/SessionListSelectionActionBar');
        const store = screen.root.findByType(SessionListSelectionStoreProvider).props.store;
        const readTargets = () => screen.root.findByType(SessionListSelectionActionBarHost).props.targetsByKey;

        // This is the unused bulk model, not the virtualized row projection.
        expect(readTargets().size).toBe(0);
        await act(async () => { store.enter(selectedKey); });
        expect(readTargets().size).toBe(1);
        expect(readTargets().get(selectedKey).tags).toEqual([]);
        await act(async () => { store.selectAllVisible(); });
        expect(store.getSnapshot().count).toBe(2);
        expect(readTargets().size).toBe(2);
        await act(async () => { store.exit(); });
        expect(readTargets().size).toBe(0);

        sessionTagsV1 = { 'server_a:sess_a': ['updated-while-closed'] };
        await screen.update(<SessionsList />);
        expect(readTargets().size).toBe(0);
        await act(async () => { store.enter(selectedKey); });
        expect(readTargets().get(selectedKey).tags).toEqual(['updated-while-closed']);
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

    it('keeps an explicitly expanded empty search input mounted across incidental blur', async () => {
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

        expect(screen.findByTestId('session-list-search-input')).toBeTruthy();
    });

    it.each([
        { headerKind: 'attention' as const, groupKind: 'attention' as const, title: 'Needs Attention' },
        { headerKind: 'working' as const, groupKind: 'working' as const, title: 'Working' },
    ])('renders exactly one stable search chrome above the list for the $headerKind group', async ({ headerKind, groupKind, title }) => {
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

        expect(screen.findAllByTestId('session-list-search-chrome')).toHaveLength(1);
        expect(screen.findAllHostsByTestId('session-list-search-trigger')).toHaveLength(1);
        expect(screen.findAll((node) =>
            String(node.type) === 'DropdownMenu'
            && Array.isArray((node.props as any)?.items)
            && (node.props as any).items.some((item: any) => item?.id === 'layout:projects')
        )).toHaveLength(1);
    });

    it('renders the canonical filter editor trigger when structural listing is available', async () => {
        filteredListingEnabled = true;

        const screen = await renderSessionsList();

        const trigger = expectPresent(
            screen.findByTestId('session-list-filter-trigger'),
            'expected filter editor trigger',
        );
        expect(trigger.props.accessibilityRole).toBe('button');
        expect(trigger.props.accessibilityLabel).toBe('sessionsList.filtersMyWork');
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

    it('keeps one stable search field across multiple primary sections while typing', async () => {
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
        // The chrome is a sibling of the one virtualized list, not per-section header data.
        expect(screen.findAllHostsByTestId('session-list-search-trigger')).toHaveLength(1);

        await act(async () => {
            expectPresent(
                screen.findByTestId('session-list-search-trigger'),
                'expected collapsed search trigger',
            ).props.onPress?.({ stopPropagation: vi.fn() });
        });

        const inputOnOpen = expectPresent(
            screen.findByTestId('session-list-search-input'),
            'expected expanded search input',
        );

        // First character: the list rebuilds around the field; the field itself must not.
        await act(async () => {
            inputOnOpen.props.onChangeText?.('s');
        });
        const inputAfterFirstChar = expectPresent(
            screen.findByTestId('session-list-search-input'),
            'expected retained search input after typing',
        );
        expect(inputAfterFirstChar).toBe(inputOnOpen);
        expect(inputAfterFirstChar.props.value).toBe('s');

        // Subsequent characters, including a query that empties the list.
        await act(async () => {
            inputAfterFirstChar.props.onChangeText?.('sess_b');
        });
        expect(screen.findByTestId('session-list-search-input')).toBe(inputOnOpen);
        expect(screen.findAllByTestId('session-list-session:sess_a')).toHaveLength(0);
        expect(screen.findAllByTestId('session-list-session:sess_b')).toHaveLength(1);

        await act(async () => {
            expectPresent(
                screen.findByTestId('session-list-search-input'),
                'expected search input before no-results query',
            ).props.onChangeText?.('zzz-no-results');
        });
        expect(screen.findByTestId('session-list-search-input')).toBe(inputOnOpen);
        expect(screen.findAllByTestId('session-list-session:sess_a')).toHaveLength(0);
        expect(screen.findAllByTestId('session-list-session:sess_b')).toHaveLength(0);
        expect(screen.findAllByTestId('session-list-filtered-no-results').length).toBeGreaterThan(0);

        // Clearing keeps the same field mounted and restores the prior list state.
        await act(async () => {
            expectPresent(
                screen.findByTestId('session-list-search-input'),
                'expected search input before clearing',
            ).props.onChangeText?.('');
        });
        expect(screen.findByTestId('session-list-search-input')).toBe(inputOnOpen);
        expect(screen.findAllByTestId('session-list-session:sess_a')).toHaveLength(1);
        expect(screen.findAllByTestId('session-list-session:sess_b')).toHaveLength(1);

        await act(async () => {
            expectPresent(
                screen.findByTestId('session-list-search-input'),
                'expected search input before the final query',
            ).props.onChangeText?.('sess_a');
        });
        expect(screen.findByTestId('session-list-search-input')).toBe(inputOnOpen);
        expect(screen.findAllByTestId('session-list-session:sess_a')).toHaveLength(1);
        expect(screen.findAllByTestId('session-list-session:sess_b')).toHaveLength(0);
    });

    it('escalates the contextual query through the canonical Search opener with the query preserved', async () => {
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
                'expected search input before contextual escalation',
            ).props.onChangeText?.('vector');
        });

        const escalation = expectPresent(
            screen.findByTestId('session-list-search-everything'),
            'expected Search everything escalation row',
        );
        expect(escalation.props.accessibilityRole).toBe('button');

        await act(async () => {
            escalation.props.onPress?.({ stopPropagation: vi.fn() });
        });

        expect(openUniversalSearchSpy).toHaveBeenCalledWith('vector');
        expect(routerPushSpy).not.toHaveBeenCalled();
    });

    it('seeds Search everything from the mounted Team Home instead of the globally active Home', async () => {
        filteredListingEnabled = true;
        exactHomeCredentialAccounts.set('server_a', 'account-a');
        exactHomeCredentialAccounts.set('server_b', 'account-b');
        const screen = await renderSessionsList({
            viewContext: {
                kind: 'team',
                team: { serverId: 'server_b', teamId: 'team_b' },
                teamDisplayName: 'Team B',
            },
        });
        await act(async () => {
            await Promise.resolve();
            expectPresent(
                screen.findByTestId('session-list-search-trigger'),
                'expected Team-context search trigger',
            ).props.onPress?.({ stopPropagation: vi.fn() });
        });
        await act(async () => {
            expectPresent(
                screen.findByTestId('session-list-search-input'),
                'expected Team-context search input',
            ).props.onChangeText?.('vector');
        });

        await vi.waitFor(() => {
            expect(screen.findByTestId('session-list-search-everything')).toBeTruthy();
        });
        await act(async () => {
            expectPresent(
                screen.findByTestId('session-list-search-everything'),
                'expected Team-context Search everything action after its exact Account binding resolves',
            ).props.onPress?.({ stopPropagation: vi.fn() });
        });

        expect(openUniversalSearchSpy).toHaveBeenCalledWith('vector', {
            accountId: 'account-b',
            serverId: 'server_b',
            sessionId: null,
            machineId: null,
            rootPath: null,
        });
        expect(openUniversalSearchSpy).not.toHaveBeenCalledWith('vector', expect.objectContaining({
            accountId: 'account-a',
            serverId: 'server_a',
        }));
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
        const searchTriggers = screen.findAllHostsByTestId('session-list-search-trigger');
        expect(searchTriggers).toHaveLength(1);

        await act(async () => {
            expectPresent(
                searchTriggers[0],
                'expected stable search trigger',
            ).props.onPress?.({ stopPropagation: vi.fn() });
        });

        await act(async () => {
            expectPresent(
                screen.findByTestId('session-list-search-input'),
                'expected expanded search input',
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

    it('retains a selected tag through a temporary missing organization projection', async () => {
        const { SessionsList } = await import('./SessionsList');
        sessionTagsV1 = { 'server_a:sess_a': ['important'], 'server_a:sess_b': ['later'] };
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
        expect(screen.findAllByTestId('session-list-session:sess_b')).toHaveLength(0);

        // A loading/offline projection may temporarily have no known tags. That
        // absence is not authoritative deletion evidence and must not erase the
        // canonical qualified filter selection.
        sessionTagsV1 = {};
        await screen.update(<SessionsList />);
        sessionTagsV1 = { 'server_a:sess_a': ['important'], 'server_a:sess_b': ['later'] };
        await screen.update(<SessionsList />);

        expect(screen.findAllByTestId('session-list-session:sess_a')).toHaveLength(1);
        expect(screen.findAllByTestId('session-list-session:sess_b')).toHaveLength(0);
    });

    it('keeps iOS rows free of any drag gesture outside Organize mode, so scroll, swipe and long-press keep their meaning (K1)', async () => {
        const screen = await renderSessionsList();

        const first = expectPresent(findSessionItem(screen, 'sess_a'), 'expected sess_a session row');
        expect(first.props.dragEnabled).toBe(true);
        expect(first.props.organizeMode).toBe(false);
        expect(first.props.dragGripGesture).toBeUndefined();
        expect(findRecordedGestureDetectors(screen)).toHaveLength(0);
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

        expect(first.props.dragGripGesture).toBeUndefined();
        expect(findRecordedGestureDetectors(screen)).toHaveLength(0);
        expect(String(rowWrapper.type)).toBe('View');
        expect(rowWrapper.props.collapsable).toBe(false);
    });

    it('opens the iOS native context menu when the row reports its long press (K1: the long press is the menu)', async () => {
        const screen = await renderSessionsList();
        const initialListProps = virtualizedListState.current?.props;
        expect(initialListProps).toBeTruthy();
        const initialRenderItem = initialListProps?.renderItem;
        const initialExtraData = initialListProps?.extraData;
        const row = expectPresent(findSessionItem(screen, 'sess_a'), 'expected sess_a session row');

        await act(async () => {
            row.props.onNativeContextMenuOpenChange(true);
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
        const row = expectPresent(findSessionItem(screen, 'sess_a'), 'expected sess_a session row');

        expect(typeof listProps?.onScrollBeginDrag).toBe('function');
        expect(typeof listProps?.onScrollEndDrag).toBe('function');

        await act(async () => {
            listProps?.onScrollBeginDrag?.();
            row.props.onNativeContextMenuOpenChange(true);
        });

        const suppressed = expectPresent(
            findSessionItem(screen, 'sess_a'),
            'expected sess_a session row after suppressed long press',
        );
        expect(suppressed.props.nativeContextMenuOpen).toBe(false);

        await act(async () => {
            listProps?.onScrollEndDrag?.();
            row.props.onNativeContextMenuOpenChange(true);
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

    it('keeps the native date-ordered carry source free of gestures outside Organize mode', async () => {
        sessionListOrderingModeV1 = 'updated';

        const screen = await renderSessionsList();

        const first = expectPresent(findSessionItem(screen, 'sess_a'), 'expected sess_a session row');
        expect(first.props.dragEnabled).toBe(true);
        expect(first.props.dragGripGesture).toBeUndefined();
        expect(findRecordedGestureDetectors(screen)).toHaveLength(0);
    });

    it('keeps Android session rows free of drag gestures and native inline context menus outside Organize mode', async () => {
        platformOs = 'android';

        const screen = await renderSessionsList();

        const first = expectPresent(findSessionItem(screen, 'sess_a'), 'expected sess_a session row');
        expect(first.props.dragGripGesture).toBeUndefined();
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

        const nextExtraData = virtualizedListState.current?.props?.extraData;
        const changedKeys = Object.keys(initialExtraData ?? {}).filter((key) =>
            !Object.is(initialExtraData[key], nextExtraData?.[key]));
        expect(nextExtraData, `Changed row inputs: ${changedKeys.join(', ')}`).toBe(initialExtraData);
    });

    it('invalidates mounted native rows when a row presentation setting changes', async () => {
        const screen = await renderSessionsList();
        const initialExtraData = virtualizedListState.current?.props?.extraData;
        const { SessionsList } = await import('./SessionsList');

        sessionListIdentityDisplay = 'none';
        mockPathname = '/sessions';
        await screen.update(<SessionsList />);

        expect(virtualizedListState.current?.props?.extraData).not.toBe(initialExtraData);
        expect(virtualizedListState.current?.props?.extraData?.sessionListIdentityDisplay).toBe('none');
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
        const serverRows = Object.fromEntries(
            profiledSessions.map((session) => [session.id, session]),
        );
        storageState.sessionListRowsByServerId = {
            server_a: serverRows,
        };

        const {
            registerExternalSessionStatusDemandTransport,
            resetExternalSessionStatusDemandCoordinatorForTests,
        } = await import('@/sync/runtime/orchestration/externalSessions/externalSessionStatusDemandCoordinator');
        resetExternalSessionStatusDemandCoordinatorForTests();
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

        storageState.sessionListRowsByServerId = {
            ...storageState.sessionListRowsByServerId,
            server_a: {
                ...storageState.sessionListRowsByServerId.server_a,
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
        const { storage: realStorage } = await import('@/sync/domains/state/storageStore');
        await act(async () => {
            realStorage.setState({ sessionListRowsByServerId: storageState.sessionListRowsByServerId });
        });
        await screen.update(<SessionsList />);

        expect(virtualizedListState.current?.props?.data).toBe(initialData);
        expect(virtualizedListState.current?.props?.extraData).toBe(initialExtraData);
    });

    it('keeps row move action props stable when an equivalent session-list refresh only replaces data objects', async () => {
        platformOs = 'android';
        exactHomeCredentialAccounts.set('server_a', 'account-a');
        const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
        primeServerFeaturesSnapshot({
            serverId: 'server_a',
            snapshot: { status: 'ready', features: createRootLayoutFeaturesResponse({
                features: { sessions: { enabled: true, folders: { enabled: true } } },
            }) },
        });
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

    it('does not rewrite focused-session MRU from the active list projection', async () => {
        mockPathname = '/session/sess_b';
        sessionMruOrderV1 = ['server_a:stale', 'server_a:sess_a'];

        await renderSessionsList();

        expect(setSessionMruOrderV1).not.toHaveBeenCalled();
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
        const activeExtraData = virtualizedListState.current?.props?.extraData;
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
        expect(virtualizedListState.current?.props?.extraData).not.toBe(activeExtraData);
        expect(virtualizedListState.current?.props?.extraData?.sessionListSurfaceDataActive).toBe(false);
        const inactiveExtraData = virtualizedListState.current?.props?.extraData;

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
        expect(virtualizedListState.current?.props?.extraData).not.toBe(inactiveExtraData);
        expect(virtualizedListState.current?.props?.extraData?.sessionListSurfaceDataActive).toBe(true);
        const hiddenRefreshNodeId = buildSessionListIndexNodeId({
            type: 'session',
            serverId: 'server_a',
            sessionId: 'sess_hidden_refresh',
        });
        expect(reactivatedData.some((item: any) => item.id === hiddenRefreshNodeId)).toBe(true);
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

    it('keeps native pull-to-refresh mounted but disabled while the surface is inactive', async () => {
        await renderSessionsListWithSurfaceOwnership({
            visible: true,
            interactive: false,
            dataActive: false,
        });

        expect(virtualizedListState.current?.props?.refreshControl?.props).toMatchObject({
            enabled: false,
            refreshing: false,
        });
        expect(virtualizedListState.current?.props?.refreshControl?.props?.onRefresh).toBeUndefined();
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

    it('seats the stable chrome and the sole virtualized list inside the non-scroll keyboard-aware frame', async () => {
        const screen = await renderSessionsList();

        const frame = screen.findHostByTestId('sessions-list-keyboard-frame');
        expect(frame).not.toBeNull();

        const hasAncestorWithFrame = (node: { parent: any }): boolean => {
            let current = node.parent;
            while (current !== null && current !== undefined) {
                if (current.props?.testID === 'sessions-list-keyboard-frame') return true;
                current = current.parent;
            }
            return false;
        };

        // The stable search chrome and the virtualized rows both live inside
        // ONE non-scroll keyboard-aware frame, so the keyboard resizes the
        // viewport around them instead of scrolling a nested container.
        const chrome = screen.root.findByProps({ testID: 'session-list-search-chrome' });
        expect(hasAncestorWithFrame(chrome)).toBe(true);
        const row = screen.root.findByProps({ testID: 'session-list-session:sess_a' });
        expect(hasAncestorWithFrame(row)).toBe(true);
    });
});
