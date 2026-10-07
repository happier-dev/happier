import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    findTestInstanceByTypeContainingText,
    invokeTestInstanceHandler,
    renderScreen,
} from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createSessionListRenderableSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createCapturingFlatListMock } from '@/dev/testkit/mocks/virtualizedList';
import { installSessionShellCommonModuleMocks } from './sessionShellTestHelpers';
import { buildSessionListIndexFromViewData } from '@/sync/domains/sessionList/sessionListIndex';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { applySessionOrganizationLegacyTestSettings } from './sessionOrganizationProjectionTestFixture';
import { buildSessionOrganizationSessionKey } from '@/sync/domains/session/organization/keys';
import { createUseSettingMock, createUseSettingMutableMockFromReader } from '@/dev/testkit/mocks/storage';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/components/appShell/search/UniversalSearchRuntimeContext', () => ({
    useUniversalSearchRuntime: () => ({
        open: vi.fn(),
        buildCommands: vi.fn(),
    }),
}));

let capturedRootFlatListProps: any | null = null;
const routerPushSpy = vi.fn();
const modalAlertSpy = vi.hoisted(() => vi.fn());
let hideInactiveSessions = false;
const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
let homeA: string;
const pinPath = '/v2/session-organization/pins/sess_a';
const tagsPath = '/v2/session-organization/tag-assignments/sess_a';
let previousStorageState: ReturnType<typeof import('@/sync/domains/state/storageStore').storage.getState>;

let pinnedSessionKeysV1: string[] = [];

let sessionListGroupOrderV1: Record<string, string[]> = {};

let sessionTagsV1: Record<string, string[]> = {};
let workspaceRefsV1: any[] = [];
const setWorkspaceRefsV1 = vi.fn();
const readMachineTargetForSessionMock = vi.hoisted(() => vi.fn());
const mockMachinesState = vi.hoisted(() => ({ current: [] as any[] }));
const flatListMock = createCapturingFlatListMock({ renderItems: true });

const groupKey = 'server:server_a:day:2026-02-17';

const sessionA = createSessionListRenderableSessionFixture({
    id: 'sess_a',
    seq: 1,
    createdAt: 1,
    updatedAt: 1,
    active: false,
    activeAt: 0,
    metadata: null,
    metadataVersion: 1,
    agentStateVersion: 1,
    thinking: false,
    thinkingAt: 0,
    presence: 0,
    owner: 'account-a',
});

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
    modal: async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({
        spies: { alert: modalAlertSpy },
    }).module,
    storage: async (importOriginal) => {
        const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleMock({
            importOriginal,
            overrides: {
                useSetting: createUseSettingMock({ fallback: (key) => {
                    if (key === 'compactSessionView') return false;
                    if (key === 'compactSessionViewMinimal') return false;
                    if (key === 'sessionTagsEnabled') return true;
                    if (key === 'hideInactiveSessions') return hideInactiveSessions;
                    if (key === 'workspaceRefsV1') return workspaceRefsV1;
                    if (key === 'workspacePathDisplayModeV1') return 'path';
                    return null;
                } }),
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
                    connectedServiceCredentialRevisionsV1: [],
                    connectedAccountsV4: [],
                    connectedAccountGroupsV4: [],
                }),
                useAllMachines: () => mockMachinesState.current,
                useMachineDisplayById: () => Object.fromEntries(
                    mockMachinesState.current.map((machine) => [machine.id, machine]),
                ),
                useSettingMutable: createUseSettingMutableMockFromReader((key) => {
                    if (key === 'workspaceRefsV1') return [workspaceRefsV1, setWorkspaceRefsV1];
                    return [null, vi.fn()];
                }),
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


vi.mock('@/utils/sessions/sessionUtils', () => ({
    getSessionName: () => 'Session',
    // Rows ask whether the title is the untitled fallback; these fixtures are all named.
    isUntitledSessionName: () => false,
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

vi.mock('./sessionListRow', () => ({
    SessionListRow: (props: any) => React.createElement('SessionListRow', {
        ...props,
        testID: `session-list-session:${String(props.session?.id ?? 'unknown')}`,
        onSetTags: (tags: string[]) => props.onSetTagsSessionKey?.(props.sessionKey, tags),
        onTogglePinned: () => props.onTogglePinnedSessionKey?.(props.sessionKey),
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
    const { storage } = await import('@/sync/domains/state/storageStore');
    const rowsByServerId: Record<string, Record<string, SessionListRenderableSession>> = {};
    for (const item of mockVisibleSessionListViewData) {
        if (item.type !== 'session') continue;
        (rowsByServerId[item.serverId] ??= {})[item.session.id] = item.session;
    }
    storage.setState({
        sessionListRowsByServerId: rowsByServerId,
        ordinarySessionListMembershipByServerId: Object.fromEntries(
            Object.entries(rowsByServerId).map(([serverId, rows]) => [serverId, Object.keys(rows)]),
        ),
    });
    for (const serverId of mockAllowedServerIds) {
        await applySessionOrganizationLegacyTestSettings({
            serverId, pinnedSessionKeysV1, sessionListGroupOrderV1, sessionTagsV1,
        });
    }
    const { SessionsListView } = await import('./SessionsList');
    return renderScreen(<SessionsListView paneState={createPaneState()} />);
}

function createPaneState() {
    return {
        summary: { sessionsReady: true, sessionCount: mockVisibleSessionListViewData.filter((item) => item.type === 'session').length },
        visibleSessionListIndex: buildSessionListIndexFromViewData(mockVisibleSessionListViewData),
        hasHiddenInactiveSessions: false,
        folderFocus: null,
        folderFeatureEnabledServerIds: [],
        showLoading: false,
        showEmptyState: false,
    } satisfies import('@/hooks/session/useVisibleSessionListPaneState').VisibleSessionListPaneState;
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
    beforeEach(async () => {
        const { storage } = await import('@/sync/domains/state/storageStore');
        previousStorageState = storage.getState();
        await home.reset();
        homeA = await home.addHome({ name: 'Server A', serverUrl: 'https://server-a.example.test', serverIdentityId: 'server_a', accountId: 'account-a' });
        await home.addHome({ name: 'Server B', serverUrl: 'https://server-b.example.test', serverIdentityId: 'server_b', accountId: 'account-b', active: false });
        home.answer(homeA, pinPath, { body: { pin: { sessionId: 'sess_a', sortKey: null, pinnedAt: 1 } } });
        home.answer(homeA, tagsPath, { body: { sessionId: 'sess_a', tagIds: ['fixture-tag-2'] } });
        pinnedSessionKeysV1 = [];
        sessionListGroupOrderV1 = {};
        sessionTagsV1 = {};
        workspaceRefsV1 = [];
        setWorkspaceRefsV1.mockClear();
        modalAlertSpy.mockClear();
        routerPushSpy.mockReset();
        mockAllowedServerIds = ['server_a'];
        capturedRootFlatListProps = null;
        hideInactiveSessions = false;
        readMachineTargetForSessionMock.mockReset();
        mockMachinesState.current = [];
        resetVisibleSessionListViewData();
    });

    afterEach(async () => {
        standardCleanup();
        await home.reset();
        const { storage } = await import('@/sync/domains/state/storageStore');
        storage.setState(previousStorageState, true);
    });

    it('leaves Archived to the list title\'s scope menu instead of a footer card', async () => {
        const screen = await renderSessionsList();

        expect(findTestInstanceByTypeContainingText(screen.root, 'Pressable', 'sessionInfo.archivedSessions')).toBeUndefined();
        expect(findTestInstanceByTypeContainingText(screen.root, 'Pressable', 'sessionInfo.inactiveAndArchivedSessions')).toBeUndefined();

        // The scope menu itself is covered by the filter control's DOM test; here the list offers it.
        expect(screen.findByTestId('session-list-filter-trigger')).toBeTruthy();
    });

    it('hands the scope editor the number of sessions the list shows, counted from the list rows', async () => {
        const screen = await renderSessionsList();

        // The popover itself needs a DOM (covered by the editor and portal tests); here the list is
        // the producer: its own rows, not a second derivation, are the count the editor states.
        const [control] = screen.findAll((node) => (
            typeof node.props?.editor === 'object'
            && node.props.editor !== null
            && 'resetFilters' in node.props.editor
        ));
        expect(control?.props.editor.resultCount).toBe(2);
    });

    it('exposes stable test ids on primary section headers', async () => {
        mockVisibleSessionListViewData = [
            { type: 'header', title: 'Pinned', headerKind: 'pinned', groupKey: 'pinned-v1', serverId: 'server_a', serverName: 'Server A' },
            { type: 'session', session: sessionA, groupKey: 'pinned-v1', groupKind: 'pinned', serverId: 'server_a', serverName: 'Server A' },
            { type: 'header', title: 'Active', headerKind: 'active', serverId: 'server_a', serverName: 'Server A' },
            { type: 'session', session: sessionLive1, groupKey, groupKind: 'date', serverId: 'server_a', serverName: 'Server A' },
        ];

        const screen = await renderSessionsList();

        expect(screen.findByTestId('session-list-header:pinned-v1')).toBeTruthy();
        expect(screen.findByTestId('session-list-header:active')).toBeTruthy();
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

    it('uses the canonical virtualized list for large web lists', async () => {
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

        expect(capturedRootFlatListProps).toBeTruthy();
        expect(capturedRootFlatListProps?.disableVirtualization).toBeUndefined();
        expect(capturedRootFlatListProps?.scrollEventThrottle).toBe(32);
    });

    it('renders the full priority prefix before inactive history on large web lists', async () => {
        const makeHeader = (title: string, headerKind: string, groupKeyValue: string) => ({
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
            groupKindValue: string,
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
            groupKind: groupKindValue,
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

        await renderSessionsList();

        expect(capturedRootFlatListProps).toBeTruthy();
        expect(capturedRootFlatListProps?.disableVirtualization).toBeUndefined();
    });

    it('passes session tags from organization projection into session items when enabled', async () => {
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
        const { SessionsListView: SessionsListComponent } = await import('./SessionsList');
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

        await applySessionOrganizationLegacyTestSettings({ serverId: 'server_a', sessionTagsV1 });
        await screen.update(<SessionsListComponent paneState={createPaneState()} />);

        const updatedRow = expectPresent(
            findSessionItem(screen, 'sess_a'),
            'expected updated sess_a session row',
        );
        expect(updatedRow.props.allKnownTags).toBe(firstKnownTags);
        expect(updatedRow.props.allKnownTags).toEqual(['blocked', 'important', 'review']);
    });

    it('writes updated session tags through organization assignments', async () => {
        sessionTagsV1 = { 'server_a:sess_a': ['important'], 'server_a:sess_b': ['urgent'] };
        const screen = await renderSessionsList();

        const row = expectPresent(
            findSessionItem(screen, 'sess_a'),
            'expected sess_a session row',
        );

        await act(async () => {
            invokeTestInstanceHandler(row, 'onSetTags', ['urgent'], 'expected sess_a session row');
            await Promise.resolve();
        });

        expect(home.requestsFor(tagsPath)).toEqual([expect.objectContaining({
            serverId: homeA, serverUrl: 'https://server-a.example.test', input: { tagIds: ['fixture-tag-2'] },
            token: home.findByServerUrl('https://server-a.example.test')?.token,
        })]);
        const { storage } = await import('@/sync/domains/state/storageStore');
        expect(storage.getState().sessionOrganizationTagAssignmentsBySessionKey[buildSessionOrganizationSessionKey('server_a', 'sess_a')]).toEqual({
            sessionId: 'sess_a', tagIds: ['fixture-tag-2'],
        });
    });

    it('does not write session tags when the requested tags already match the projected value', async () => {
        sessionTagsV1 = { 'server_a:sess_a': ['important'] };
        const screen = await renderSessionsList();

        const row = expectPresent(
            findSessionItem(screen, 'sess_a'),
            'expected sess_a session row',
        );

        await act(async () => {
            invokeTestInstanceHandler(row, 'onSetTags', ['important'], 'expected sess_a session row');
            await Promise.resolve();
        });

        expect(home.requestsFor(tagsPath)).toEqual([]);
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

    it('wires pin toggling through organization pins', async () => {

        const screen = await renderSessionsList();

        const row = expectPresent(
            findSessionItem(screen, 'sess_a'),
            'expected sess_a session row',
        );

        await act(async () => {
            invokeTestInstanceHandler(row, 'onTogglePinned', undefined, 'expected sess_a session row');
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(home.requestsFor(pinPath)).toEqual([expect.objectContaining({
            serverId: homeA, serverUrl: 'https://server-a.example.test', input: { pinned: true },
            token: home.findByServerUrl('https://server-a.example.test')?.token,
        })]);
        const { storage } = await import('@/sync/domains/state/storageStore');
        expect(storage.getState().sessionOrganizationPinsBySessionKey[buildSessionOrganizationSessionKey('server_a', 'sess_a')]).toEqual({
            sessionId: 'sess_a', sortKey: null, pinnedAt: 1,
        });
    });

    it('keeps the exact URL-shaped Home identity when pinning a qualified Session row', async () => {
        const serverId = 'https://home.example.test:8443';
        const exactHome = await home.addHome({ name: 'Remote Home', serverUrl: serverId, serverIdentityId: serverId, accountId: 'account-url' });
        mockAllowedServerIds = [serverId];
        home.answer(exactHome, pinPath, { body: { pin: { sessionId: 'sess_a', sortKey: null, pinnedAt: 2 } } });
        mockVisibleSessionListViewData = [
            {
                type: 'header',
                title: 'Today',
                headerKind: 'date',
                groupKey,
                serverId,
                serverName: 'Remote Home',
            },
            {
                type: 'session',
                session: sessionA,
                groupKey,
                groupKind: 'date',
                serverId,
                serverName: 'Remote Home',
            },
        ];
        const screen = await renderSessionsList();
        const row = expectPresent(
            findSessionItem(screen, 'sess_a'),
            'expected URL-scoped sess_a row',
        );

        await act(async () => {
            invokeTestInstanceHandler(row, 'onTogglePinned', undefined, 'expected URL-scoped sess_a row');
            await Promise.resolve();
        });

        expect(home.requestsFor(pinPath)).toEqual([expect.objectContaining({
            serverId: exactHome, serverUrl: serverId, input: { pinned: true }, token: home.findByServerUrl(serverId)?.token,
        })]);
        const { storage } = await import('@/sync/domains/state/storageStore');
        expect(storage.getState().sessionOrganizationPinsBySessionKey[buildSessionOrganizationSessionKey(serverId, 'sess_a')]).toEqual({
            sessionId: 'sess_a', sortKey: null, pinnedAt: 2,
        });
        expect(storage.getState().sessionOrganizationPinsBySessionKey[buildSessionOrganizationSessionKey('server_a', 'sess_a')]).toBeUndefined();
    });

    it('shows actionable pin errors instead of silently rolling the row back', async () => {
        home.answer(homeA, pinPath, { status: 400, body: { error: 'session-pin-limit-exceeded' } });
        const screen = await renderSessionsList();
        const row = expectPresent(findSessionItem(screen, 'sess_a'), 'expected sess_a session row');

        await act(async () => {
            invokeTestInstanceHandler(row, 'onTogglePinned', undefined, 'expected sess_a session row');
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(modalAlertSpy).toHaveBeenCalledWith(
            'common.error',
            'sessionInfo.pinLimitExceeded',
        );
        const { storage } = await import('@/sync/domains/state/storageStore');
        expect(storage.getState().sessionOrganizationPinsBySessionKey[buildSessionOrganizationSessionKey('server_a', 'sess_a')]).toBeUndefined();
    });

    it('surfaces the exact Home scope failure instead of silently dropping the list action', async () => {
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        vi.mocked(TokenStorage.getCredentialsForServerUrl).mockResolvedValue(null);
        const screen = await renderSessionsList();
        const row = expectPresent(
            findSessionItem(screen, 'sess_a'),
            'expected sess_a session row',
        );

        await act(async () => {
            invokeTestInstanceHandler(row, 'onTogglePinned', undefined, 'expected sess_a session row');
            await Promise.resolve();
        });

        expect(home.requestsFor(pinPath)).toEqual([]);
        expect(modalAlertSpy).toHaveBeenCalledWith(
            'common.error',
            expect.stringContaining('server_a'),
        );
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

        expect(screen.findAllHostsByTestId(`session-list-project-header:${projectGroupKey}`)).toHaveLength(1);

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
