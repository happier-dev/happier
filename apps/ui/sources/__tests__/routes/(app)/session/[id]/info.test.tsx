import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';
import { createStorageModuleMock } from '@/dev/testkit/mocks/storage';
import type { LocalSettings } from '@/sync/domains/settings/localSettings';
import { clearTempData, peekTempData, type NewSessionData } from '@/utils/sessions/tempDataStore';
import { installSessionRouteCommonModuleMocks } from './sessionRouteTestHelpers';
import type { SessionRouteHydrationState } from '@/sync/domains/session/sessionRouteHydrationState';
import type { SessionOrganizationProjection } from '@/sync/domains/session/organization';
import type { SessionOrganizationFolder } from '@happier-dev/protocol';
import { createUseSettingMock, createUseSettingMutableMockFromReader } from '@/dev/testkit/mocks/storage';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let mockSessionId = 'session-1';
let mockServerId: string | undefined;
let mockSession: any = null;
let isDataReady = true;
let routeHydrationState: SessionRouteHydrationState = { kind: 'available', sessionId: 'session-1' };
let sessionIsConnected = true;
let localDevModeEnabled = false;
const allSessionsState = vi.hoisted(() => ({
    current: [] as any[],
}));
const allMachinesState = vi.hoisted(() => ({
    current: [] as any[],
}));
const routerPushSpy = vi.fn();
const routerBackSpy = vi.fn();
const safeRouterBackSpy = vi.fn();
const readMachineTargetForSessionSpy = vi.fn();
const resolveSessionTargetServerIdSpy = vi.fn();
const resolveServerIdForSessionIdFromLocalCacheSpy = vi.fn();
const machineRpcWithServerScopeSpy = vi.fn();
const machineContributionRegistryProjectionDescribeMock = vi.fn(async (..._args: unknown[]): Promise<any> => ({ supported: false, reason: 'not-supported' }));
const useSessionExecutionRunsSupportedSpy = vi.fn<(sessionId: string, sessionServerId?: string | null) => boolean>(() => false);
type CreateDefaultActionExecutorConfig = Readonly<{
    resolveServerIdForSessionId?: (sessionId: string) => string | null;
    openSession?: (
        sessionId: string,
        options?: Readonly<{ serverId?: string | null }>,
    ) => void | Promise<void>;
}>;
const createDefaultActionExecutorSpy = vi.fn((_config: CreateDefaultActionExecutorConfig) => ({}));
const sessionStopSpy = vi.fn(async () => ({ success: true }));
type ArchiveSpyResult = Readonly<{
    success: boolean;
    archivedAt?: number | null;
    message?: string;
    code?: string;
}>;
const sessionArchiveSpy = vi.fn(async (): Promise<ArchiveSpyResult> => ({ success: true, archivedAt: 1 }));
const sessionDeleteSpy = vi.fn(async () => ({ success: true }));
const sessionSetManualReadStateSpy = vi.fn(async () => ({ success: true, readState: 'unread', lastViewedSessionSeq: 0, didChange: true }));
const modalAlertSpy = vi.fn();
const modalConfirmSpy = vi.fn(async () => true);
const modalPromptSpy = vi.fn(async () => 'urgent, review');
const applySessionListRenderablePatchesSpy = vi.fn();
const setPinnedSessionKeysV1Spy = vi.fn();
const setSessionTagsV1Spy = vi.fn();
const openMoveSheetSpy = vi.fn(async () => null as any);
const setSessionFolderAssignmentSpy = vi.fn(async () => undefined);
const setSessionPinSpy = vi.fn(async () => undefined);
const setSessionTagLabelsSpy = vi.fn(async () => undefined);
type OrganizationMutationScopeResult =
    | Readonly<{
        ok: true;
        scope: {
            credentials: { token: string };
            serverId: string;
            serverIdAliases: readonly string[];
            serverUrl: string;
        };
    }>
    | Readonly<{
        ok: false;
        reason: 'serverIdRequired' | 'serverProfileUnavailable' | 'credentialsUnavailable';
        requestedServerId: string;
        serverId?: string;
    }>;
const resolveSessionOrganizationMutationScopeSpy = vi.fn(
    async (): Promise<OrganizationMutationScopeResult> => ({
        ok: true,
        scope: {
            credentials: { token: 'token' },
            serverId: 'server-1',
            serverIdAliases: [],
            serverUrl: 'https://server.example.test',
        },
    }),
);
let hideInactiveSessions = false;
let pinnedSessionKeysV1: unknown = null;
let sessionTagsV1: unknown = null;
let sessionFoldersV1: unknown = null;
let acpCatalogSettingsV1: unknown = null;
let backendEnabledByTargetKey: unknown = null;
let resolvedServerId = 'server-1';
let sessionHandoffFeatureEnabled = false;
let sessionFoldersFeatureEnabled = false;
let serverFeaturesSnapshot: any = {
    status: 'ready',
    features: {
        features: {
            sessions: {
                enabled: true,
                handoff: {
                    enabled: true,
                },
            },
            machines: {
                enabled: true,
                transfer: {
                    enabled: true,
                    directPeer: {
                        enabled: true,
                    },
                    serverRouted: {
                        enabled: false,
                    },
                },
            },
        },
        capabilities: {},
    },
};
let mockAgentCore: any = {
    displayNameKey: 'agentInput.agent.claude',
    resume: {},
    permissions: { modeGroup: 'codexLike' },
    ui: { agentPickerIconName: 'code-slash-outline' },
};
const AnimatedValue = vi.hoisted(
    () =>
        class AnimatedValue {
            constructor(_value: unknown) {}

            setValue(_value: unknown) {}

            interpolate(_config: unknown) {
                return 1;
            }
        },
);
const useHappyActionMock = vi.hoisted(() =>
    vi.fn((fn: any): readonly [boolean, any] => [false, fn] as const),
);
const mockResolveAgentIdFromFlavor = vi.fn<(flavor: string | null | undefined) => string | undefined>(() => 'claude');
const useSessionSpy = vi.fn<(sessionId: string) => any>(() => mockSession);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return value != null && typeof value === 'object' && !Array.isArray(value);
}

function stripServerSessionKey(serverId: string, keyRaw: unknown): string | null {
    const key = typeof keyRaw === 'string' ? keyRaw.trim() : '';
    const prefix = `${serverId}:`;
    if (!key.startsWith(prefix)) return null;
    const sessionId = key.slice(prefix.length).trim();
    return sessionId || null;
}

function buildSessionOrganizationProjectionFromLegacyFixtures(serverIdRaw: unknown): SessionOrganizationProjection {
    const serverId = typeof serverIdRaw === 'string' && serverIdRaw.trim()
        ? serverIdRaw.trim()
        : 'server-1';
    const pinnedSessionIds = Array.isArray(pinnedSessionKeysV1)
        ? pinnedSessionKeysV1
            .map((key) => stripServerSessionKey(serverId, key))
            .filter((sessionId): sessionId is string => sessionId != null)
        : [];
    const tagAssignmentsBySessionId = isPlainRecord(sessionTagsV1)
        ? Object.fromEntries(
            Object.entries(sessionTagsV1)
                .map(([key, tags]) => {
                    const sessionId = stripServerSessionKey(serverId, key);
                    return sessionId && Array.isArray(tags) ? [sessionId, tags] : null;
                })
                .filter((entry): entry is [string, string[]] => entry != null),
        )
        : {};
    const folders = isPlainRecord(sessionFoldersV1) && Array.isArray(sessionFoldersV1.folders)
        ? sessionFoldersV1.folders
        : [];
    const folderEntries: Array<[string, SessionOrganizationFolder]> = [];
    for (const folder of folders) {
        if (!isPlainRecord(folder)) continue;
        const folderId = typeof folder.id === 'string' ? folder.id.trim() : '';
        if (!folderId) continue;
        folderEntries.push([folderId, {
            folderId,
            folderKey: folderId,
            parentFolderId: typeof folder.parentId === 'string' ? folder.parentId : null,
            parentFolderKey: typeof folder.parentId === 'string' ? folder.parentId : null,
            display: {
                t: 'plain',
                v: {
                    name: typeof folder.name === 'string' ? folder.name : folderId,
                    workspace: folder.workspace,
                },
            },
            sortKey: typeof folder.sortKey === 'string' ? folder.sortKey : null,
            createdAt: typeof folder.createdAt === 'number' ? folder.createdAt : 0,
            updatedAt: typeof folder.updatedAt === 'number' ? folder.updatedAt : 0,
            archivedAt: null,
        }]);
    }
    const foldersById = Object.fromEntries(folderEntries);
    return {
        schemaVersion: 1,
        version: 1,
        pinnedSessionIds,
        pinsBySessionId: Object.fromEntries(pinnedSessionIds.map((sessionId, index) => [
            sessionId,
            { sessionId, sortKey: String(index + 1).padStart(4, '0'), pinnedAt: index + 1 },
        ])),
        foldersById,
        folderAssignmentsBySessionId: {},
        tagsById: {},
        tagAssignmentsBySessionId,
        orderEntriesByScopeKey: {},
        labelsByLabelKey: {},
    };
}

const routerMock = createExpoRouterMock({
    router: {
        push: routerPushSpy,
        back: routerBackSpy,
        replace: vi.fn(),
        setParams: vi.fn(),
    },
    params: () => ({
        id: mockSessionId,
        serverId: mockServerId,
    }),
});

installSessionRouteCommonModuleMocks({
    router: async () => routerMock.module,
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: 'View',
            Animated: {
                View: 'AnimatedView',
                Value: AnimatedValue,
                loop: vi.fn(() => ({ start: vi.fn() })),
                sequence: vi.fn(() => ({ start: vi.fn() })),
                timing: vi.fn(() => ({ start: vi.fn() })),
            },
        });
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            confirmResult: true,
            spies: {
                alert: modalAlertSpy,
                confirm: modalConfirmSpy,
                prompt: modalPromptSpy,
            },
        }).module;
    },
    storageModule: async (importOriginal) =>
        createStorageModuleMock({
            importOriginal,
            overrides: {
                storage: {
                    getState: () => ({
                        sessions: { [mockSessionId]: mockSession },
                        machines: {},
                        settings: {},
                        concurrentSessionListCacheByServerId: {},
                        sessionListIndexByServerId: {},
                        sessionListRowStateByServerId: {},
                        applySessionListRenderablePatches: applySessionListRenderablePatchesSpy,
                    }),
                } as any,
                useSession: (sessionId: string) => useSessionSpy(sessionId),
                useIsDataReady: () => isDataReady,
                useAllSessions: () => allSessionsState.current,
                useAllMachines: () => allMachinesState.current,
                useProjectForSession: () => null,
                useLocalSetting: <K extends keyof LocalSettings>(name: K): LocalSettings[K] => {
                    if (name === 'devModeEnabled') {
                        return localDevModeEnabled as LocalSettings[K];
                    }
                    return null as unknown as LocalSettings[K];
                },
                useSetting: createUseSettingMock({ fallback: (key) => {
                    if (key === 'hideInactiveSessions') {
                        return hideInactiveSessions;
                    }
                    if (key === 'pinnedSessionKeysV1') {
                        return pinnedSessionKeysV1;
                    }
                    if (key === 'sessionTagsV1') {
                        return sessionTagsV1;
                    }
                    if (key === 'sessionFoldersV1') {
                        return sessionFoldersV1;
                    }
                    if (key === 'acpCatalogSettingsV1') {
                        return acpCatalogSettingsV1;
                    }
                    if (key === 'backendEnabledByTargetKey') {
                        return backendEnabledByTargetKey;
                    }
                    return null;
                } }),
                useSettingMutable: createUseSettingMutableMockFromReader((key) => {
                    if (key === 'pinnedSessionKeysV1') {
                        return [pinnedSessionKeysV1, setPinnedSessionKeysV1Spy];
                    }
                    if (key === 'sessionTagsV1') {
                        return [sessionTagsV1, setSessionTagsV1Spy];
                    }
                    return [null, vi.fn()];
                }),
                useSessionOrganizationProjection: (serverId: string | null | undefined) =>
                    buildSessionOrganizationProjectionFromLegacyFixtures(serverId),
            },
        }),
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
    Octicons: 'Octicons',
}));

vi.mock('@/sync/ops/sessionMachineTarget', () => ({
    readMachineTargetForSession: (sessionId: string) => readMachineTargetForSessionSpy(sessionId),
}));
vi.mock('@/components/sessions/model/useSessionMachineReachability', () => ({
    useSessionReachableMachineTarget: (sessionId: string) => readMachineTargetForSessionSpy(sessionId),
}));

vi.mock('@/hooks/session/useHydrateSessionForRoute', () => ({
    useHydrateSessionForRoute: (sessionId: string) => ({
        ...routeHydrationState,
        sessionId,
    }),
}));
vi.mock('@/utils/navigation/safeRouterBack', () => ({
    safeRouterBack: (...args: any[]) => safeRouterBackSpy(...args),
}));

vi.mock('@/components/ui/text/Text', () => ({ Text: (props: any) => React.createElement('Text', props, props.children) }));
vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement('Item', { ...props, testID: props.testID ?? props.title }, props.children),
}));
vi.mock('@/components/ui/lists/ItemGroup', () => ({ ItemGroup: 'ItemGroup' }));
vi.mock('@/components/ui/lists/ItemList', () => ({ ItemList: 'ItemList' }));
vi.mock('@/components/ui/avatar/Avatar', () => ({
    Avatar: (props: any) => React.createElement('Avatar', { ...props, testID: props.testID ?? 'session-info-avatar' }),
}));
vi.mock('@/components/ui/media/CodeView', () => ({
    CodeView: ({ code, language }: { code: string; language: string }) =>
        React.createElement('CodeView', { code, language }),
}));
vi.mock('@/components/sessions/info/SessionRetentionNotice', () => ({ SessionRetentionNotice: 'SessionRetentionNotice' }));
vi.mock('@/hooks/ui/useHappyAction', () => ({ useHappyAction: (fn: any) => useHappyActionMock(fn) }));
vi.mock('@/sync/ops', () => ({
    sessionArchiveWithServerScope: sessionArchiveSpy,
    sessionDelete: sessionDeleteSpy,
    sessionDeleteWithServerScope: sessionDeleteSpy,
    sessionRename: vi.fn(),
    sessionSetManualReadStateWithServerScope: sessionSetManualReadStateSpy,
    sessionStop: sessionStopSpy,
    sessionStopWithServerScope: sessionStopSpy,
}));

vi.mock('@/sync/ops/machineContributionRegistryProjection', () => ({
    getMachineContributionRegistryProjectionRevision: () => 0,
    subscribeMachineContributionRegistryProjectionInvalidation: () => () => {},
    machineContributionRegistryProjectionDescribe: (...args: any[]) => machineContributionRegistryProjectionDescribeMock(...args),
}));
vi.mock('@/agents/catalog/catalog', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/agents/catalog/catalog')>();
    return {
        ...actual,
        DEFAULT_AGENT_ID: 'claude',
        getAgentCore: () => mockAgentCore,
        resolveAgentIdFromFlavor: (flavor: string | null | undefined) => mockResolveAgentIdFromFlavor(flavor),
    };
});
vi.mock('@/hooks/session/useSessionSharingSupport', () => ({ useSessionSharingSupport: () => false }));
vi.mock('@/hooks/server/useAutomationsSupport', () => ({ useAutomationsSupport: () => ({ enabled: false }) }));
vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (featureId: string) => {
        if (featureId === 'sessions.handoff') {
            return sessionHandoffFeatureEnabled;
        }
        if (featureId === 'sessions.folders') {
            return sessionFoldersFeatureEnabled;
        }
        return false;
    },
}));
vi.mock('@/components/sessions/shell/move-sheet/useSessionListMoveSheet', () => ({
    useSessionListMoveSheet: () => ({
        openMoveSheet: openMoveSheetSpy,
    }),
}));
vi.mock('@/auth/storage/tokenStorage', () => ({
    TokenStorage: {
        getCredentialsForServerUrl: vi.fn(async () => ({ token: 'token' })),
    },
}));
vi.mock('@/sync/domains/server/serverProfiles', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/domains/server/serverProfiles')>();
    return {
        ...actual,
        getServerProfileById: () => ({
            id: 'server-1',
            serverUrl: 'https://server.example.test',
        }),
    };
});
vi.mock('@/sync/ops/sessionOrganization', () => ({
    resolveSessionOrganizationMutationScope: resolveSessionOrganizationMutationScopeSpy,
    writeSessionOrganizationFolderAssignment: setSessionFolderAssignmentSpy,
    writeSessionOrganizationPin: setSessionPinSpy,
    writeSessionOrganizationTagLabels: setSessionTagLabelsSpy,
}));
vi.mock('@/hooks/server/useSessionExecutionRunsSupported', () => ({
    useSessionExecutionRunsSupported: (sessionId: string, sessionServerId?: string | null) =>
        useSessionExecutionRunsSupportedSpy(sessionId, sessionServerId),
}));
vi.mock('@/sync/ops/actions/defaultActionExecutor', () => ({ createDefaultActionExecutor: (config: CreateDefaultActionExecutorConfig) => createDefaultActionExecutorSpy(config) }));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId', () => ({
    resolvePreferredServerIdForSessionId: (sessionId: string) => resolveSessionTargetServerIdSpy(sessionId),
}));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/resolveServerIdForSessionIdFromLocalCache', () => ({
    resolveServerIdForSessionIdFromLocalCache: (sessionId: string) => resolveServerIdForSessionIdFromLocalCacheSpy(sessionId),
}));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: (...args: unknown[]) => machineRpcWithServerScopeSpy(...args),
}));
vi.mock('@/sync/domains/features/featureDecisionRuntime', () => ({
    useServerFeaturesSnapshotForServerId: () => serverFeaturesSnapshot,
}));
vi.mock('@/sync/domains/settings/actionsSettings', () => ({ isActionEnabledInState: () => true }));
vi.mock('@/sync/domains/sessionFork/forkUiSupport', () => ({ canForkConversation: () => true }));
vi.mock('@/sync/domains/sessionFork/executeSessionForkAction', () => ({ executeSessionForkAction: vi.fn() }));
vi.mock('@/sync/domains/sessionHandoff/handoffUiSupport', () => ({ canHandoffConversation: () => true }));
vi.mock('@/sync/domains/sessionHandoff/runSessionHandoffPickerFlow', () => ({ runSessionHandoffPickerFlow: vi.fn() }));
vi.mock('@happier-dev/protocol', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@happier-dev/protocol')>();
    return {
        ...actual,
        getActionSpec: () => ({
            id: 'session.handoff',
            title: 'Hand off session',
            description: 'Move the current session',
        }),
    };
});
vi.mock('@happier-dev/agents', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@happier-dev/agents')>();
    return {
        ...actual,
        resolveAgentIdFromSessionMetadata: (metadata: Record<string, unknown> | null | undefined) => {
            const runtimeDescriptor = (metadata?.runtimeDescriptorV1 ?? metadata?.agentRuntimeDescriptorV1) as any;
            if (typeof runtimeDescriptor?.agentId === 'string') return runtimeDescriptor.agentId;
            const flavor = typeof metadata?.flavor === 'string' ? metadata.flavor : null;
            return mockResolveAgentIdFromFlavor(flavor) ?? null;
        },
    };
});
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));
vi.mock('@/utils/sessions/sessionUtils', () => ({
    getSessionName: () => 'name',
    useSessionStatus: () => ({
        isConnected: sessionIsConnected,
        statusText: 'Connected',
        statusColor: 'green',
        statusDotColor: 'green',
        isPulsing: false,
    }),
    formatOSPlatform: () => 'macOS',
    formatPathRelativeToHome: (p: string) => p,
    getSessionAvatarId: () => 'id',
}));
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }));
vi.mock('@/utils/system/versionUtils', () => ({ isVersionSupported: () => true, MINIMUM_CLI_VERSION: '0.0.0' }));
vi.mock('@/utils/sessions/terminalSessionDetails', () => ({ getAttachCommandForSession: () => null, getTmuxFallbackReason: () => null, getTmuxTargetForSession: () => null }));
vi.mock('@/utils/errors/errors', () => ({ HappyError: class HappyError extends Error {} }));
vi.mock('@/sync/domains/profiles/profileUtils', () => ({ resolveProfileById: () => null }));
vi.mock('@/components/profiles/profileDisplay', () => ({ getProfileDisplayName: () => 'profile' }));
vi.mock('@/components/ui/layout/layout', () => ({ layout: { screenPaddingHorizontal: 16 } }));

describe('/session/[id]/info', () => {
    beforeEach(() => {
        mockSessionId = 'session-1';
        mockServerId = undefined;
        mockSession = null;
        isDataReady = true;
        routeHydrationState = { kind: 'available', sessionId: 'session-1' };
        sessionIsConnected = true;
        localDevModeEnabled = false;
        routerPushSpy.mockReset();
        routerBackSpy.mockReset();
        safeRouterBackSpy.mockReset();
        readMachineTargetForSessionSpy.mockReset();
        readMachineTargetForSessionSpy.mockReturnValue(null);
        sessionStopSpy.mockClear();
        sessionArchiveSpy.mockClear();
        sessionDeleteSpy.mockClear();
        sessionSetManualReadStateSpy.mockClear();
        modalAlertSpy.mockClear();
        modalConfirmSpy.mockClear();
        modalPromptSpy.mockClear();
        modalPromptSpy.mockResolvedValue('urgent, review');
        setPinnedSessionKeysV1Spy.mockClear();
        setSessionTagsV1Spy.mockClear();
        openMoveSheetSpy.mockClear();
        openMoveSheetSpy.mockResolvedValue(null);
        setSessionFolderAssignmentSpy.mockClear();
        setSessionPinSpy.mockClear();
        setSessionTagLabelsSpy.mockClear();
        resolveSessionOrganizationMutationScopeSpy.mockReset();
        resolveSessionOrganizationMutationScopeSpy.mockResolvedValue({
            ok: true,
            scope: {
                credentials: { token: 'token' },
                serverId: 'server-1',
                serverIdAliases: [],
                serverUrl: 'https://server.example.test',
            },
        });
        resolveSessionTargetServerIdSpy.mockClear();
        resolveServerIdForSessionIdFromLocalCacheSpy.mockClear();
        machineRpcWithServerScopeSpy.mockClear();
        useSessionExecutionRunsSupportedSpy.mockClear();
        resolveSessionTargetServerIdSpy.mockImplementation(() => resolvedServerId);
        resolveServerIdForSessionIdFromLocalCacheSpy.mockImplementation(() => null);
        machineRpcWithServerScopeSpy.mockRejectedValue(new Error('unreachable'));
        hideInactiveSessions = false;
        pinnedSessionKeysV1 = null;
        sessionTagsV1 = null;
        sessionFoldersV1 = null;
        acpCatalogSettingsV1 = null;
        backendEnabledByTargetKey = null;
        resolvedServerId = 'server-1';
        sessionHandoffFeatureEnabled = false;
        sessionFoldersFeatureEnabled = false;
        allSessionsState.current = [];
        allMachinesState.current = [];
        serverFeaturesSnapshot = {
            status: 'ready',
            features: {
                features: {
                    sessions: {
                        enabled: true,
                        handoff: {
                            enabled: true,
                        },
                    },
                    machines: {
                        enabled: true,
                        transfer: {
                            enabled: true,
                            directPeer: {
                                enabled: true,
                            },
                            serverRouted: {
                                enabled: false,
                            },
                        },
                    },
                },
                capabilities: {},
            },
        };
        mockAgentCore = {
            displayNameKey: 'agentInput.agent.claude',
            resume: {},
            permissions: { modeGroup: 'codexLike' },
            ui: { agentPickerIconName: 'code-slash-outline' },
        };
        useSessionSpy.mockClear();
        mockResolveAgentIdFromFlavor.mockReset();
        mockResolveAgentIdFromFlavor.mockReturnValue('claude');
        vi.clearAllMocks();
        useHappyActionMock.mockReset();
        useHappyActionMock.mockImplementation((fn: any) => [false, fn] as const);
        useSessionExecutionRunsSupportedSpy.mockReturnValue(false);
        machineContributionRegistryProjectionDescribeMock.mockReset();
        machineContributionRegistryProjectionDescribeMock.mockResolvedValue({ supported: false, reason: 'not-supported' });
        clearTempData();
    });

    afterEach(() => {
        clearTempData();
        standardCleanup();
    });

    async function renderInfoScreen() {
        const Screen = (await import('@/app/(app)/session/[id]/info')).default;
        return renderScreen(<Screen />);
    }

    it('shows loading while the route hydration is still in progress', async () => {
        routeHydrationState = { kind: 'loading', sessionId: 'session-1', reason: 'store-miss' };
        const screen = await renderInfoScreen();
        expect(screen.getTextContent()).toContain('common.loading');
    });

    it('shows loading while route hydration is retrying without rendering terminal unavailable', async () => {
        routeHydrationState = { kind: 'retrying', sessionId: 'session-1', cause: 'server_unavailable' };
        const screen = await renderInfoScreen();
        expect(screen.getTextContent()).toContain('common.loading');
        expect(screen.getTextContent()).not.toContain('errors.sessionDeleted');
    });

    it('renders terminal fallback when route hydration is missing', async () => {
        routeHydrationState = { kind: 'missing', sessionId: 'session-1', cause: 'not_found' };
        const screen = await renderInfoScreen();
        expect(screen.getTextContent()).not.toContain('common.loading');
        expect(screen.getTextContent()).toContain('errors.sessionDeleted');
    });

    it('does not keep the route loading after route hydration is available when global data is not ready', async () => {
        isDataReady = false;
        const screen = await renderInfoScreen();
        expect(screen.getTextContent()).not.toContain('common.loading');
        expect(screen.getTextContent()).toContain('errors.sessionDeleted');
    });

    it('fails open and renders the session when the record exists even if global hydration is still in progress', async () => {
        mockSession = {
            id: 'session-1234567890abcdef',
            active: false,
            accessLevel: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 1,
            metadata: {},
        };
        isDataReady = false;
        routeHydrationState = { kind: 'loading', sessionId: 'session-1', reason: 'store-miss' };
        const screen = await renderInfoScreen();
        expect(screen.getTextContent()).not.toContain('common.loading');
        expect(screen.getTextContent()).toContain('name');
    });

    it('normalizes the route id before looking up the session', async () => {
        mockSessionId = ['session-2 '] as any;
        await renderInfoScreen();
        expect(useSessionSpy).toHaveBeenCalledWith('session-2');
    });

    it('threads the route session server id into the default action executor fallback', async () => {
        mockSession = {
            id: 'session-1',
            serverId: 'server-session-info',
            active: false,
            accessLevel: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 1,
            metadata: {},
        };
        resolveSessionTargetServerIdSpy.mockImplementation((_sessionId, fallbackServerId) => fallbackServerId ?? null);

        await renderInfoScreen();

        const executorConfig = (createDefaultActionExecutorSpy.mock.calls as Array<[CreateDefaultActionExecutorConfig]>).at(-1)?.[0];
        const resolved = await executorConfig?.resolveServerIdForSessionId?.('child-session');
        expect(resolved).toBe('server-session-info');
        await executorConfig?.openSession?.('child-session');
        expect(routerPushSpy).toHaveBeenCalledWith('/session/child-session?serverId=server-session-info');
        expect(useSessionExecutionRunsSupportedSpy).toHaveBeenCalledWith('session-1', 'server-session-info');
    });

    it('uses daemon merged projection titles when resolving the default session action backend label', async () => {
        mockSession = {
            id: 'session-merged-projection',
            serverId: 'server-session-info',
            active: false,
            accessLevel: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 1,
            metadata: {
                machineId: 'machine-projection-1',
                flavor: 'claude',
                host: 'host-a',
                path: '/tmp/session',
                homeDir: '/home/me',
            },
        };

        machineContributionRegistryProjectionDescribeMock.mockResolvedValue({
            supported: true,
            projection: {
                v: 1,
                providersById: {
                    claude: {
                        providerId: 'claude',
                        title: 'Claude Provider',
                        subtitle: null,
                        channel: 'stable',
                        isBuiltIn: true,
                    },
                },
                backendsById: {
                    claude: {
                        backendId: 'claude',
                        providerId: 'claude',
                        title: 'Claude (daemon)',
                        subtitle: null,
                        catalogAgentId: 'claude',
                        iconAgentId: 'claude',
                    },
                },
            },
        });

        const screen = await renderInfoScreen();
        await flushHookEffects({ cycles: 10 });

        const aiProviderItems = screen
            .findAllByType('Item' as any)
            .filter((node: any) => node.props?.title === 'sessionInfo.aiProvider');
        expect(aiProviderItems).toHaveLength(1);
        expect(aiProviderItems[0]?.props?.subtitle).toBe('Claude (daemon)');
    });

    it('defers raw dev JSON rendering until a section is opened', async () => {
        localDevModeEnabled = true;
        mockSession = {
            id: 'session-1',
            active: false,
            accessLevel: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 1,
            metadata: {
                path: '/workspace/repo',
                sessionModelsV1: {
                    availableModels: Array.from({ length: 50 }, (_, index) => ({
                        id: `model-${index}`,
                        description: 'large metadata payload',
                    })),
                },
            },
            agentState: {
                controlledByUser: false,
                requests: {},
            },
        };

        const screen = await renderInfoScreen();
        expect(screen.findAllByType('CodeView' as any)).toHaveLength(0);

        const metadataRawItem = screen.findAllByType('Item' as any)
            .find((node: any) => node.props?.title === 'sessionInfo.metadata' && typeof node.props?.onPress === 'function');
        expect(metadataRawItem).toBeTruthy();

        await act(async () => {
            metadataRawItem?.props.onPress();
        });

        const codeViews = screen.findAllByType('CodeView' as any);
        expect(codeViews).toHaveLength(1);
        expect(codeViews[0]?.props.language).toBe('json');
        expect(codeViews[0]?.props.code).toContain('"sessionModelsV1"');
    });

    it('redacts sensitive fields from copied and expanded dev JSON', async () => {
        localDevModeEnabled = true;
        mockSession = {
            id: 'session-1',
            active: false,
            accessLevel: null,
            createdAt: 1,
            updatedAt: 1,
            seq: 1,
            dataEncryptionKey: 'raw-session-data-key',
            metadata: {
                path: '/workspace/repo',
                apiKey: 'raw-metadata-api-key',
                nested: {
                    authorization: 'Bearer raw-auth-token',
                    visible: 'safe-visible-value',
                },
            },
            agentState: {
                controlledByUser: false,
                requests: {
                    req_1: {
                        secret: 'raw-agent-secret',
                        visible: 'safe-agent-value',
                    },
                },
            },
        };

        const screen = await renderInfoScreen();
        const copyMetadataItem = screen.findAllByType('Item' as any)
            .find((node: any) => node.props?.title === 'sessionInfo.copyMetadata');
        expect(copyMetadataItem?.props.copy).toContain('safe-visible-value');
        expect(copyMetadataItem?.props.copy).not.toContain('raw-metadata-api-key');
        expect(copyMetadataItem?.props.copy).not.toContain('raw-auth-token');

        const fullSessionRawItem = screen.findAllByType('Item' as any)
            .find((node: any) => node.props?.title === 'sessionInfo.fullSessionObject' && typeof node.props?.onPress === 'function');
        expect(fullSessionRawItem).toBeTruthy();

        await act(async () => {
            fullSessionRawItem?.props.onPress();
        });

        const codeViews = screen.findAllByType('CodeView' as any);
        expect(codeViews).toHaveLength(1);
        const rawCode = String(codeViews[0]?.props.code ?? '');
        expect(rawCode).toContain('safe-visible-value');
        expect(rawCode).toContain('safe-agent-value');
        expect(rawCode).not.toContain('raw-session-data-key');
        expect(rawCode).not.toContain('raw-metadata-api-key');
        expect(rawCode).not.toContain('raw-auth-token');
        expect(rawCode).not.toContain('raw-agent-secret');
    });

    it('keeps expanded dev session JSON stable across live session refreshes until reopened', async () => {
        localDevModeEnabled = true;
        mockSession = {
            id: 'session-1',
            active: true,
            accessLevel: null,
            createdAt: 1,
            updatedAt: 1,
            seq: 1,
            metadata: {
                path: '/workspace/repo',
                liveHeartbeat: 'initial-value',
            },
        };

        const screen = await renderInfoScreen();
        const fullSessionRawItem = screen.findAllByType('Item' as any)
            .find((node: any) => node.props?.title === 'sessionInfo.fullSessionObject' && typeof node.props?.onPress === 'function');
        expect(fullSessionRawItem).toBeTruthy();

        await act(async () => {
            fullSessionRawItem?.props.onPress();
        });
        const initialCode = String(screen.findAllByType('CodeView' as any)[0]?.props.code ?? '');
        expect(initialCode).toContain('initial-value');

        mockSession = {
            ...mockSession,
            updatedAt: 2,
            metadata: {
                ...mockSession.metadata,
                liveHeartbeat: 'refreshed-value',
            },
        };
        const Screen = (await import('@/app/(app)/session/[id]/info')).default;
        await screen.update(<Screen />);

        const refreshedCode = String(screen.findAllByType('CodeView' as any)[0]?.props.code ?? '');
        expect(refreshedCode).toBe(initialCode);
        expect(refreshedCode).not.toContain('refreshed-value');

        const reopenedRawItem = screen.findAllByType('Item' as any)
            .find((node: any) => node.props?.title === 'sessionInfo.fullSessionObject' && typeof node.props?.onPress === 'function');
        await act(async () => {
            reopenedRawItem?.props.onPress();
        });
        await act(async () => {
            reopenedRawItem?.props.onPress();
        });

        const reopenedCode = String(screen.findAllByType('CodeView' as any)[0]?.props.code ?? '');
        expect(reopenedCode).toContain('refreshed-value');
    });

    it('shows projected product activity status without raw thinking diagnostics outside dev mode', async () => {
        const previousDevFlag = (globalThis as { __DEV__?: boolean }).__DEV__;
        (globalThis as { __DEV__?: boolean }).__DEV__ = false;
        localDevModeEnabled = false;
        mockSession = {
            id: 'session-projected-status',
            active: true,
            accessLevel: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 1,
            metadata: {},
            thinking: true,
            thinkingAt: Date.now(),
            latestTurnStatus: 'completed',
            latestTurnStatusObservedAt: Date.now(),
        };

        try {
            const screen = await renderInfoScreen();
            const items = screen.findAllByType('Item' as any);

            expect(items.some((node: any) =>
                node.props?.title === 'sessionInfo.sessionStatus'
                && node.props?.detail === 'Connected'
            )).toBe(true);
            expect(items.some((node: any) => node.props?.title === 'sessionInfo.thinking')).toBe(false);
        } finally {
            (globalThis as { __DEV__?: boolean }).__DEV__ = previousDevFlag;
        }
    });

    it('fails closed and hides the handoff quick action when direct peer truth is runtime-unknown and server-routed fallback would make the UI untruthful', async () => {
        sessionHandoffFeatureEnabled = true;
        serverFeaturesSnapshot = {
            status: 'ready',
            features: {
                features: {
                    sessions: {
                        enabled: true,
                        handoff: {
                            enabled: true,
                        },
                    },
                    machines: {
                        enabled: true,
                        transfer: {
                            enabled: true,
                            directPeer: {
                                enabled: true,
                            },
                            serverRouted: {
                                enabled: true,
                            },
                        },
                    },
                },
                capabilities: {},
            },
        };
        mockSession = {
            id: 'session-1234567890abcdef',
            active: false,
            accessLevel: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 1,
            metadata: {
                machineId: 'machine_source',
                flavor: 'claude',
                claudeSessionId: 'claude-session-1',
            },
        };

        const screen = await renderInfoScreen();
        const handoffItems = screen.findAllByType('Item' as any).filter((node: any) => node.props?.title === 'Hand off session');
        expect(handoffItems).toHaveLength(0);
    });

    it('fails closed and hides the handoff quick action when the selected server only exposes direct-peer handoff transport', async () => {
        sessionHandoffFeatureEnabled = true;
        serverFeaturesSnapshot = {
            status: 'ready',
            features: {
                features: {
                    sessions: {
                        enabled: true,
                        handoff: {
                            enabled: true,
                        },
                    },
                    machines: {
                        enabled: true,
                        transfer: {
                            enabled: true,
                            directPeer: {
                                enabled: true,
                            },
                            serverRouted: {
                                enabled: false,
                            },
                        },
                    },
                },
                capabilities: {},
            },
        };
        mockSession = {
            id: 'session-1234567890abcdef',
            serverId: 'server_reactive_info',
            active: false,
            accessLevel: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 1,
            metadata: {
                machineId: 'machine_source',
                flavor: 'claude',
                claudeSessionId: 'claude-session-1',
            },
        };

        const screen = await renderInfoScreen();
        const handoffItems = screen.findAllByType('Item' as any).filter((node: any) => node.props?.title === 'Hand off session');
        expect(handoffItems).toHaveLength(0);
    });

    it('shows manual mark-unread in quick actions for read sessions and uses scoped server mutations', async () => {
        mockSession = {
            id: 'session-read-state',
            active: false,
            accessLevel: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 4,
            lastViewedSessionSeq: 4,
            latestTurnStatus: 'completed',
            metadata: {
                machineId: 'machine_source',
                flavor: 'claude',
            },
        };
        resolveServerIdForSessionIdFromLocalCacheSpy.mockReturnValue('server-cached');

        const screen = await renderInfoScreen();
        const item = screen.findByProps({ testID: 'session-info-mark-unread' });
        expect(item).toBeTruthy();

        await act(async () => {
            item.props.onPress();
        });

        expect(sessionSetManualReadStateSpy).toHaveBeenCalledWith(
            'session-read-state',
            'unread',
            { serverId: 'server-cached' },
        );
    });

    it('hides manual read-state quick actions for archived sessions', async () => {
        mockSession = {
            id: 'session-read-state-archived',
            active: false,
            accessLevel: null,
            archivedAt: 123,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 4,
            lastViewedSessionSeq: 4,
            latestTurnStatus: 'completed',
            metadata: {
                machineId: 'machine_source',
                flavor: 'claude',
            },
        };

        const screen = await renderInfoScreen();

        expect(screen.findAllByProps({ testID: 'session-info-mark-unread' })).toHaveLength(0);
        expect(screen.findAllByProps({ testID: 'session-info-mark-read' })).toHaveLength(0);
    });

    it('hides pin quick action for archived sessions', async () => {
        mockServerId = 'server-b';
        mockSession = {
            id: 'session-1',
            active: false,
            accessLevel: null,
            archivedAt: 123,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 2,
            lastViewedSessionSeq: 2,
            latestTurnStatus: 'completed',
            metadata: {},
        };

        const screen = await renderInfoScreen();

        expect(screen.findAllByProps({ testID: 'session-info-session-pin' })).toHaveLength(0);
        expect(screen.findAllByProps({ testID: 'session-info-session-unpin' })).toHaveLength(0);
    });

    it('surfaces pin and tag actions from the session view quick actions', async () => {
        mockServerId = 'server-b';
        pinnedSessionKeysV1 = [];
        sessionTagsV1 = { 'server-1:session-1': ['existing'] };
        mockSession = {
            id: 'session-1',
            active: false,
            accessLevel: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 2,
            lastViewedSessionSeq: 1,
            latestTurnStatus: 'completed',
            archivedAt: null,
            metadata: {},
        };

        const screen = await renderInfoScreen();

        await screen.pressByTestIdAsync('session-info-session-pin');
        expect(setSessionPinSpy).toHaveBeenCalledWith(expect.objectContaining({
            scope: expect.objectContaining({
                serverId: 'server-1',
                serverUrl: 'https://server.example.test',
            }),
            sessionId: 'session-1',
            pinned: true,
        }));
        expect(setPinnedSessionKeysV1Spy).not.toHaveBeenCalled();

        await screen.pressByTestIdAsync('session-info-session-tags-edit');
        expect(modalPromptSpy).toHaveBeenCalledWith(
            'sessionsList.selectionSetTagsPromptTitle',
            'sessionsList.selectionTagsPromptMessage',
            expect.objectContaining({ defaultValue: 'existing' }),
        );
        expect(setSessionTagLabelsSpy).toHaveBeenCalledWith(expect.objectContaining({
            scope: expect.objectContaining({
                serverId: 'server-1',
                serverUrl: 'https://server.example.test',
            }),
            sessionId: 'session-1',
            tags: ['urgent', 'review'],
        }));
        expect(setSessionTagsV1Spy).not.toHaveBeenCalled();
    });

    it('surfaces the existing info-screen error when organization mutation scope is unavailable', async () => {
        mockServerId = 'server-b';
        pinnedSessionKeysV1 = [];
        mockSession = {
            id: 'session-1',
            active: false,
            accessLevel: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 2,
            lastViewedSessionSeq: 1,
            latestTurnStatus: 'completed',
            archivedAt: null,
            metadata: {},
        };
        resolveSessionOrganizationMutationScopeSpy.mockResolvedValueOnce({
            ok: false,
            reason: 'credentialsUnavailable',
            requestedServerId: 'server-1',
            serverId: 'server-1',
        });

        const screen = await renderInfoScreen();

        await expect(
            screen.pressByTestIdAsync('session-info-session-pin'),
        ).rejects.toThrow('errors.unknownError');
        expect(setSessionPinSpy).not.toHaveBeenCalled();
    });

    it('surfaces move-to-folder from the session view when folder targets match the session workspace', async () => {
        mockServerId = 'server-1';
        sessionFoldersFeatureEnabled = true;
        sessionFoldersV1 = {
            v: 1,
            folders: [{
                id: 'folder-1',
                workspace: {
                    t: 'workspaceScope',
                    serverId: 'server-1',
                    machineId: 'machine-1',
                    rootPath: '/repo',
                },
                parentId: null,
                name: 'Planning',
                createdAt: 1,
                updatedAt: 1,
            }],
        };
        mockSession = {
            id: 'session-1',
            active: false,
            accessLevel: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 2,
            lastViewedSessionSeq: 1,
            latestTurnStatus: 'completed',
            archivedAt: null,
            metadata: {
                machineId: 'machine-1',
                path: '/repo',
            },
        };
        openMoveSheetSpy.mockResolvedValue({
            id: 'session-info-move-folder:folder-1',
            kind: 'folder',
            label: 'Planning',
            disabled: false,
            result: { instruction: { kind: 'idle' }, visual: { kind: 'none' } },
        });

        const screen = await renderInfoScreen();
        await screen.pressByTestIdAsync('session-info-session-move-to-folder');

        expect(openMoveSheetSpy).toHaveBeenCalledWith(expect.objectContaining({
            sourceLabel: 'name',
            targets: expect.arrayContaining([
                expect.objectContaining({ id: 'session-info-move-folder:folder-1', label: 'Planning' }),
            ]),
        }));
        expect(setSessionFolderAssignmentSpy).toHaveBeenCalledWith(expect.objectContaining({
            scope: expect.objectContaining({ serverId: 'server-1' }),
            sessionId: 'session-1',
            folderId: 'folder-1',
        }));
    });

    it('fails closed and hides the handoff quick action when server-routed transfer is the only transport the selected server advertises', async () => {
        sessionHandoffFeatureEnabled = true;
        serverFeaturesSnapshot = {
            status: 'ready',
            features: {
                features: {
                    sessions: {
                        enabled: true,
                        handoff: {
                            enabled: true,
                        },
                    },
                    machines: {
                        enabled: true,
                        transfer: {
                            enabled: true,
                            directPeer: {
                                enabled: false,
                            },
                            serverRouted: {
                                enabled: true,
                            },
                        },
                    },
                },
                capabilities: {},
            },
        };
        mockSession = {
            id: 'session-1234567890abcdef',
            active: false,
            accessLevel: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 1,
            metadata: {
                machineId: 'machine_source',
                flavor: 'claude',
                claudeSessionId: 'claude-session-1',
            },
        };

        const screen = await renderInfoScreen();
        const handoffItems = screen.findAllByType('Item' as any).filter((node: any) => node.props?.title === 'Hand off session');
        expect(handoffItems).toHaveLength(0);
    });

    it('reacts when machine-rpc direct-peer viability becomes available for the reachable machine target after metadata goes stale', async () => {
        sessionHandoffFeatureEnabled = true;
        resolvedServerId = 'server_reactive_info';
        resolveSessionTargetServerIdSpy.mockReturnValue('server_reactive_info');
        readMachineTargetForSessionSpy.mockReturnValue({
            machineId: 'machine_rebound',
            basePath: '/workspace/repo',
        });
        serverFeaturesSnapshot = {
            status: 'ready',
            features: {
                features: {
                    sessions: {
                        enabled: true,
                        handoff: {
                            enabled: true,
                        },
                    },
                    machines: {
                        enabled: true,
                        transfer: {
                            enabled: true,
                            directPeer: {
                                enabled: true,
                            },
                            serverRouted: {
                                enabled: false,
                            },
                        },
                    },
                },
                capabilities: {},
            },
        };
        mockSession = {
            id: 'session-1234567890abcdef',
            active: false,
            accessLevel: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 1,
            metadata: {
                machineId: 'machine_source',
                flavor: 'claude',
                claudeSessionId: 'claude-session-1',
            },
        };

        const screen = await renderInfoScreen();
        let handoffItems = screen.findAllByType('Item' as any).filter((node: any) => node.props?.title === 'Hand off session');
        expect(handoffItems).toHaveLength(0);

        const { recordCachedMachineRpcDirectRouteViable } = await import('@/sync/domains/transfers/runtime/transferRouteCache');
        await act(async () => {
            recordCachedMachineRpcDirectRouteViable({
                serverId: 'server_reactive_info',
                remoteMachineId: 'machine_rebound',
            });
        });
        await flushHookEffects({ cycles: 10 });

        handoffItems = screen.findAllByType('Item' as any).filter((node: any) => node.props?.title === 'Hand off session');
        expect(handoffItems).toHaveLength(1);
    });

    it('falls back to the canonical target server when the local server cache misses and still surfaces handoff after a scoped reachability probe succeeds', async () => {
        sessionHandoffFeatureEnabled = true;
        resolvedServerId = 'server_preferred_info';
        resolveSessionTargetServerIdSpy.mockReturnValue('server_preferred_info');
        machineRpcWithServerScopeSpy.mockResolvedValue({ ok: true });
        serverFeaturesSnapshot = {
            status: 'ready',
            features: {
                features: {
                    sessions: {
                        enabled: true,
                        handoff: {
                            enabled: true,
                        },
                    },
                    machines: {
                        enabled: true,
                        transfer: {
                            enabled: true,
                            directPeer: {
                                enabled: true,
                            },
                            serverRouted: {
                                enabled: false,
                            },
                        },
                    },
                },
                capabilities: {},
            },
        };
        mockSession = {
            id: 'session-1234567890abcdef',
            active: false,
            accessLevel: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 1,
            metadata: {
                machineId: 'machine_source',
                flavor: 'claude',
                claudeSessionId: 'claude-session-1',
            },
        };

        const screen = await renderInfoScreen();
        await flushHookEffects({ cycles: 10 });

        const handoffItems = screen.findAllByType('Item' as any).filter((node: any) => node.props?.title === 'Hand off session');
        expect(handoffItems).toHaveLength(1);
    });

    it('shows the configured ACP backend title in AI provider metadata when a concrete backend target is stored on the session', async () => {
        mockResolveAgentIdFromFlavor.mockReturnValue('customAcp');
        mockAgentCore = {
            resume: {},
            displayNameKey: 'agents.customAcp.displayName',
            ui: { agentPickerIconName: 'code-slash-outline' },
        };
        acpCatalogSettingsV1 = {
            v: 2,
            backends: [{
                id: 'qa-acp-stub',
                name: 'qa-acp-stub',
                title: 'QA ACP Stub Backend',
                command: 'qa-acp-stub',
                args: [],
                env: {},
                auth: { support: 'unsupported' },
                transportProfile: 'generic',
                capabilities: {
                    supportsLoadSession: false,
                    supportsModes: 'unknown',
                    supportsModels: 'unknown',
                    supportsConfigOptions: 'unknown',
                    promptImageSupport: 'unknown',
                },
                createdAt: 1,
                updatedAt: 1,
            }],
        };
        backendEnabledByTargetKey = {
            'acpBackend:qa-acp-stub': false,
        };
        mockSession = {
            id: 'session-1234567890abcdef',
            active: false,
            accessLevel: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 1,
            metadata: {
                flavor: 'customAcp',
                agent: 'customAcp',
                acpConfiguredBackendV1: {
                    v: 1,
                    updatedAt: 1,
                    backendId: 'qa-acp-stub',
                    title: 'QA ACP Stub Backend',
                },
            },
        };

        const screen = await renderInfoScreen();
        const providerItem = screen.findByTestId('sessionInfo.aiProvider');
        expect(providerItem?.props.subtitle).toBe('QA ACP Stub Backend');
    });

    it('shows the provider resume surfaces when the vendor resume id only exists in agentRuntimeDescriptorV1', async () => {
        mockResolveAgentIdFromFlavor.mockReturnValue('opencode');
        mockAgentCore = {
            resume: {
                vendorResumeIdField: 'opencodeSessionId',
                uiVendorResumeIdLabelKey: 'sessionInfo.openCodeSessionId',
                uiVendorResumeIdCopiedKey: 'sessionInfo.openCodeSessionIdCopied',
            },
            displayNameKey: 'agents.opencode.displayName',
            ui: { agentPickerIconName: 'code-slash-outline' },
        };
        mockSession = {
            id: 'session-1234567890abcdef',
            active: false,
            accessLevel: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 1,
            metadata: {
                flavor: 'opencode',
                agentRuntimeDescriptorV1: {
                    v: 1,
                    agentId: 'opencode',
                    provider: {
                        backendMode: 'server',
                        providerSessionId: 'runtime-session-1234567890',
                    },
                },
            },
        };

        const screen = await renderInfoScreen();
        expect(screen.findByTestId('sessionInfo.openCodeSessionId')).toBeTruthy();
        expect(screen.findByTestId('sessionInfo.copyResumeCommand')).toBeTruthy();
    });

    it('infers the provider from agentRuntimeDescriptorV1 when flavor is missing', async () => {
        mockAgentCore = {
            resume: {
                vendorResumeIdField: 'opencodeSessionId',
                uiVendorResumeIdLabelKey: 'sessionInfo.openCodeSessionId',
                uiVendorResumeIdCopiedKey: 'sessionInfo.openCodeSessionIdCopied',
            },
            displayNameKey: 'agents.opencode.displayName',
            ui: { agentPickerIconName: 'code-slash-outline' },
        };
        mockSession = {
            id: 'session-1234567890abcdef',
            active: false,
            accessLevel: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 1,
            metadata: {
                agentRuntimeDescriptorV1: {
                    v: 1,
                    agentId: 'opencode',
                    provider: {
                        backendMode: 'server',
                        providerSessionId: 'runtime-session-1234567890',
                    },
                },
            },
        };

        const screen = await renderInfoScreen();
        expect(screen.findByTestId('sessionInfo.openCodeSessionId')).toBeTruthy();
        const avatar = screen.findByTestId('session-info-avatar');
        if (!avatar) {
            throw new Error('expected session info avatar');
        }
        expect(avatar.props.flavor).toBe('opencode');
    });

    it('routes View Machine to the reachable machine target when session metadata is stale after handoff', async () => {
        readMachineTargetForSessionSpy.mockReturnValue({
            machineId: 'machine-target',
            basePath: '/workspace/repo',
        });
        mockSession = {
            id: 'session-1',
            active: true,
            accessLevel: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 1,
            metadata: {
                machineId: 'machine-source',
                path: '/workspace/repo',
                flavor: 'claude',
            },
        };

        const screen = await renderInfoScreen();
        const viewMachineItem = screen.findByTestId('sessionInfo.viewMachine');
        expect(viewMachineItem).toBeTruthy();
        expect(viewMachineItem?.props.subtitleAccessory).toBeTruthy();
        expect(viewMachineItem?.props.subtitleAccessory?.props.testID).toBe('sessionInfo.viewMachineTargetMachineId');
        expect(viewMachineItem?.props.subtitleAccessory?.props.children).toBe('machine-target');
        expect(screen.findByTestId('sessionInfo.path')).toBeTruthy();

        screen.pressByTestId('sessionInfo.viewMachine');

        expect(routerPushSpy).toHaveBeenCalledWith('/machine/machine-target?serverId=server-1');
    });

    it('opens a new session seeded from the current session configuration', async () => {
        mockResolveAgentIdFromFlavor.mockReturnValue('codex');
        readMachineTargetForSessionSpy.mockReturnValue({
            machineId: 'machine-target',
            basePath: '/workspace/repo',
        });
        mockSession = {
            id: 'session-1',
            active: false,
            accessLevel: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 1,
            encryptionMode: 'plain',
            metadata: {
                machineId: 'machine-source',
                path: '/workspace/source',
                homeDir: '/workspace',
                host: 'source.local',
                flavor: 'codex',
                backendTarget: { kind: 'backend', backendId: 'codex' },
                profileId: 'profile-1',
                transcriptStorage: 'direct',
                codexBackendMode: 'appServer',
                sessionModeOverrideV1: {
                    v: 1,
                    updatedAt: 100,
                    modeId: 'plan',
                },
            },
            permissionMode: 'acceptEdits',
            permissionModeUpdatedAt: 101,
            modelMode: 'gpt-5',
            modelModeUpdatedAt: 102,
        };

        const screen = await renderInfoScreen();
        screen.pressByTestId('session-info-new-session-same-setup');

        const pushArg = routerPushSpy.mock.calls[0]?.[0] as any;
        expect(pushArg).toEqual({
            pathname: '/new',
            params: {
                dataId: expect.any(String),
                machineId: 'machine-target',
                directory: '/workspace/repo',
                spawnServerId: 'server-1',
            },
        });
        const tempData = peekTempData<NewSessionData>(pushArg.params.dataId);
        expect(tempData).toEqual(expect.objectContaining({
            prompt: '',
            replacePersistedDraftSelections: true,
            machineId: 'machine-target',
            directory: '/workspace/repo',
            agentType: 'codex',
            backendTarget: { kind: 'backend', backendId: 'codex' },
            selectedProfileId: 'profile-1',
            transcriptStorage: 'direct',
            permissionMode: 'safe-yolo',
            modelSelection: {
                v: 1,
                ref: {
                    agentTargetKey: 'backend:codex',
                    modelId: 'gpt-5',
                    providerConnectionId: null,
                },
                updatedAt: 102,
            },
            codexBackendMode: 'appServer',
            acpSessionModeId: 'plan',
        }));
    });

    it('always shows the View session log action even when developer mode is disabled', async () => {
        mockSession = {
            id: 'session-1',
            active: false,
            accessLevel: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 1,
            metadata: {},
        };

        const screen = await renderInfoScreen();
        expect(screen.findByTestId('sessionInfo.viewSessionLogTitle')).toBeTruthy();
    });

    it('shows the session log path row when a sessionLogPath is present even when developer mode is disabled', async () => {
        mockSession = {
            id: 'session-1',
            active: false,
            accessLevel: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 1,
            metadata: {
                sessionLogPath: '/tmp/.happier/logs/session.log',
            },
        };

        const screen = await renderInfoScreen();
        expect(screen.findByTestId('sessionLog.logPathCopyLabel')).toBeTruthy();
    });

    it('copies developer debug information and omits unknown provider artifact lines', async () => {
        const Clipboard = await import('expo-clipboard');
        localDevModeEnabled = true;
        mockAgentCore = {
            displayNameKey: 'agentInput.agent.codex',
            resume: { vendorResumeIdField: 'codexSessionId' },
            permissions: { modeGroup: 'codexLike' },
            ui: { agentPickerIconName: 'code-slash-outline' },
        };
        mockSession = {
            id: 'session-1',
            active: false,
            accessLevel: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 1,
            metadata: {
                host: 'host',
                path: '/workspace/repo',
                homeDir: '/Users/agent',
                sessionLogPath: '/tmp/.happier/logs/session.log',
                runtimeDescriptorV1: {
                    v: 1,
                    agentId: 'codex',
                    provider: {
                        backendMode: 'appServer',
                        providerSessionId: 'codex-session-1',
                    },
                },
            },
        };

        const screen = await renderInfoScreen();
        const copyDebugRow = screen.findByTestId('session-info-copy-debug-information');
        expect(copyDebugRow?.props.copy).toBe([
            'Happier session ID: session-1',
            'agentInput.agent.codex session ID: codex-session-1',
            'Happier logs: /tmp/.happier/logs/session.log',
        ].join('\n'));
        expect(Clipboard.setStringAsync).not.toHaveBeenCalled();
    });

    it('shows and copies provider session logs when a provider artifact path is known', async () => {
        const Clipboard = await import('expo-clipboard');
        localDevModeEnabled = true;
        mockAgentCore = {
            displayNameKey: 'agentInput.agent.claude',
            resume: { vendorResumeIdField: 'claudeSessionId' },
            permissions: { modeGroup: 'codexLike' },
            ui: { agentPickerIconName: 'code-slash-outline' },
        };
        mockSession = {
            id: 'session-1',
            active: false,
            accessLevel: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 1,
            metadata: {
                host: 'host',
                path: '/workspace/repo',
                homeDir: '/Users/agent',
                claudeSessionId: 'claude-session-1',
                claudeTranscriptPath: '/tmp/claude/session.jsonl',
            },
        };

        const screen = await renderInfoScreen();
        const providerLogsRow = screen.findByTestId('sessionInfo.providerSessionLogs');
        expect(providerLogsRow?.props.copy).toBe('/tmp/claude/session.jsonl');
        expect(Clipboard.setStringAsync).not.toHaveBeenCalled();
    });

    it('stops without archiving even when inactive sessions are hidden and unpinned', async () => {
        mockServerId = 'server-b';
        hideInactiveSessions = true;
        pinnedSessionKeysV1 = [];
        mockSession = {
            id: 'session-1',
            active: true,
            accessLevel: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 1,
            metadata: {},
        };

        const screen = await renderInfoScreen();
        await screen.pressByTestIdAsync('sessionInfo.stopSession');

        expect(modalConfirmSpy).toHaveBeenCalledWith(
            'sessionInfo.stopSession',
            'sessionInfo.stopSessionConfirm',
            {
                cancelText: 'common.cancel',
                confirmText: 'sessionInfo.stopSession',
                destructive: true,
            },
        );
        expect(modalAlertSpy).not.toHaveBeenCalled();

        expect(sessionStopSpy).toHaveBeenCalledWith('session-1', { serverId: 'server-b' });
        expect(sessionArchiveSpy).not.toHaveBeenCalled();
        expect(routerBackSpy).not.toHaveBeenCalled();
        expect(safeRouterBackSpy).toHaveBeenCalledTimes(2);
        expect(safeRouterBackSpy).toHaveBeenNthCalledWith(1, {
            router: expect.any(Object),
            fallbackHref: '/session/session-1?serverId=server-b',
        });
        expect(safeRouterBackSpy).toHaveBeenNthCalledWith(2, {
            router: expect.any(Object),
            fallbackHref: '/',
        });
    });

    it('stops and retries archiving when an inactive session is still active server-side', async () => {
        mockServerId = 'server-b';
        sessionArchiveSpy
            .mockResolvedValueOnce({
                success: false,
                message: 'Cannot archive an active session',
                code: 'session_active',
            })
            .mockResolvedValueOnce({ success: true, archivedAt: 1 });
        mockSession = {
            id: 'session-1',
            active: false,
            accessLevel: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 1,
            metadata: {},
            archivedAt: null,
        };

        const screen = await renderInfoScreen();
        await screen.pressByTestIdAsync('sessionInfo.archiveSession');

        expect(modalAlertSpy).not.toHaveBeenCalled();
        expect(sessionArchiveSpy).toHaveBeenCalledTimes(2);
        expect(sessionStopSpy).toHaveBeenCalledWith('session-1', { serverId: 'server-b' });
        expect(safeRouterBackSpy).toHaveBeenCalledTimes(2);
    });

    it('stops with the cached owning server id when route scope and preferred scope are unavailable', async () => {
        mockServerId = undefined;
        hideInactiveSessions = true;
        pinnedSessionKeysV1 = [];
        resolvedServerId = 'server-cache-info';
        resolveSessionTargetServerIdSpy.mockReturnValue(null);
        resolveServerIdForSessionIdFromLocalCacheSpy.mockReturnValue('server-cache-info');
        mockSession = {
            id: 'session-1',
            active: true,
            accessLevel: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 1,
            metadata: {},
        };

        const screen = await renderInfoScreen();
        await screen.pressByTestIdAsync('sessionInfo.stopSession');

        expect(modalConfirmSpy).toHaveBeenCalledTimes(1);
        expect(sessionStopSpy).toHaveBeenCalledWith('session-1', { serverId: 'server-cache-info' });
    });

    it('stops with the cached owning server id before a stale route server id', async () => {
        mockServerId = 'server-stale-route';
        hideInactiveSessions = true;
        pinnedSessionKeysV1 = [];
        resolvedServerId = 'server-preferred';
        resolveServerIdForSessionIdFromLocalCacheSpy.mockReturnValue('server-cache-info');
        mockSession = {
            id: 'session-1',
            active: true,
            accessLevel: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 1,
            metadata: {},
        };

        const screen = await renderInfoScreen();
        await screen.pressByTestIdAsync('sessionInfo.stopSession');

        expect(modalConfirmSpy).toHaveBeenCalledTimes(1);
        expect(sessionStopSpy).toHaveBeenCalledWith('session-1', { serverId: 'server-cache-info' });
    });

    it('stops without prompting to archive when the session is pinned', async () => {
        mockServerId = 'server-b';
        hideInactiveSessions = true;
        pinnedSessionKeysV1 = ['server-1:session-1'];
        resolvedServerId = 'server-1';
        mockSession = {
            id: 'session-1',
            serverId: 'server-1',
            active: true,
            accessLevel: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 1,
            metadata: {},
        };

        const screen = await renderInfoScreen();
        await screen.pressByTestIdAsync('sessionInfo.stopSession');

        expect(modalConfirmSpy).toHaveBeenCalledTimes(1);

        expect(sessionStopSpy).toHaveBeenCalledWith('session-1', { serverId: 'server-b' });
        expect(sessionArchiveSpy).not.toHaveBeenCalled();
        expect(routerBackSpy).not.toHaveBeenCalled();
        expect(safeRouterBackSpy).toHaveBeenCalledTimes(2);
        expect(safeRouterBackSpy).toHaveBeenNthCalledWith(1, {
            router: expect.any(Object),
            fallbackHref: '/session/session-1?serverId=server-b',
        });
        expect(safeRouterBackSpy).toHaveBeenNthCalledWith(2, {
            router: expect.any(Object),
            fallbackHref: '/',
        });
    });

    it('archives an inactive session and exits via the safe back helper', async () => {
        mockServerId = 'server-b';
        mockSession = {
            id: 'session-1',
            active: false,
            accessLevel: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 1,
            metadata: {},
            archivedAt: null,
        };

        const screen = await renderInfoScreen();
        await screen.pressByTestIdAsync('sessionInfo.archiveSession');

        expect(modalConfirmSpy).toHaveBeenCalledWith(
            'sessionInfo.archiveSession',
            'sessionInfo.archiveSessionConfirm',
            {
                cancelText: 'common.cancel',
                confirmText: 'sessionInfo.archiveSession',
                destructive: true,
            },
        );
        expect(modalAlertSpy).not.toHaveBeenCalled();

        expect(sessionArchiveSpy).toHaveBeenCalledWith('session-1', { serverId: 'server-b' });
        expect(routerBackSpy).not.toHaveBeenCalled();
        expect(safeRouterBackSpy).toHaveBeenCalledTimes(2);
        expect(safeRouterBackSpy).toHaveBeenNthCalledWith(1, {
            router: expect.any(Object),
            fallbackHref: '/session/session-1?serverId=server-b',
        });
        expect(safeRouterBackSpy).toHaveBeenNthCalledWith(2, {
            router: expect.any(Object),
            fallbackHref: '/',
        });
    });

    it('deletes a session and exits via the safe back helper', async () => {
        mockServerId = 'server-b';
        sessionIsConnected = false;
        mockSession = {
            id: 'session-1',
            active: false,
            accessLevel: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 1,
            metadata: {
                terminalControlServiceabilityV1: {
                    v: 1,
                    state: 'unknown',
                    observedAt: Date.now(),
                    retired: true,
                },
            },
            archivedAt: null,
        };

        const screen = await renderInfoScreen();
        await screen.pressByTestIdAsync('sessionInfo.deleteSession');

        expect(modalConfirmSpy).toHaveBeenCalledWith(
            'sessionInfo.deleteSession',
            'sessionInfo.deleteSessionWarning',
            {
                cancelText: 'common.cancel',
                confirmText: 'sessionInfo.deleteSession',
                destructive: true,
            },
        );
        expect(modalAlertSpy).not.toHaveBeenCalled();

        expect(sessionDeleteSpy).toHaveBeenCalledWith('session-1', { serverId: 'server-b' });
        expect(routerBackSpy).not.toHaveBeenCalled();
        expect(safeRouterBackSpy).toHaveBeenCalledTimes(2);
        expect(safeRouterBackSpy).toHaveBeenNthCalledWith(1, {
            router: expect.any(Object),
            fallbackHref: '/session/session-1?serverId=server-b',
        });
        expect(safeRouterBackSpy).toHaveBeenNthCalledWith(2, {
            router: expect.any(Object),
            fallbackHref: '/',
        });
    });

    it('archives an active session by stopping it first and then archiving it', async () => {
        mockServerId = 'server-b';
        mockSession = {
            id: 'session-1',
            active: true,
            accessLevel: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 1,
            metadata: {},
        };

        const screen = await renderInfoScreen();
        await screen.pressByTestIdAsync('sessionInfo.archiveSession');

        expect(modalConfirmSpy).toHaveBeenCalledTimes(1);

        expect(sessionStopSpy).toHaveBeenCalledWith('session-1', { serverId: 'server-b' });
        expect(sessionArchiveSpy).toHaveBeenCalledWith('session-1', { serverId: 'server-b' });
        expect(safeRouterBackSpy).toHaveBeenCalledTimes(2);
    });

    it('shows loading on the stop and archive rows while their mutations are running', async () => {
        useHappyActionMock.mockImplementation((fn: any) => [true, fn] as const);
        mockSession = {
            id: 'session-1',
            active: true,
            accessLevel: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 1,
            metadata: {},
            archivedAt: null,
        };

        const screen = await renderInfoScreen();

        expect(screen.findByTestId('sessionInfo.stopSession')?.props.loading).toBe(true);
        expect(screen.findByTestId('sessionInfo.archiveSession')?.props.loading).toBe(true);
    });

    it.each(['view', 'edit'] as const)('hides rename quick action for %s shared sessions', async (accessLevel) => {
        mockServerId = 'server-b';
        mockSession = {
            id: 'session-1',
            active: false,
            accessLevel,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 1,
            metadata: {},
            archivedAt: null,
        };

        const screen = await renderInfoScreen();
        const renameItems = screen.findAllByType('Item' as any)
            .filter((node: any) => node.props?.title === 'sessionInfo.renameSession');

        expect(renameItems).toHaveLength(0);
    });
});
