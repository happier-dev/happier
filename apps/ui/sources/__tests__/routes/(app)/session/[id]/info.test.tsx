import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { createSessionFixture, flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';
import { createServerFetchWithReachabilityProbe, matchServerFetchUrl } from '@/dev/testkit/mocks/serverFetch';
import { createStorageModuleStub, createStorageStoreProxy } from '@/dev/testkit/mocks/storage';
import { setActiveServerId, upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import type { LocalSettings } from '@/sync/domains/settings/localSettings';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol';
import { clearTempData, peekTempData, type NewSessionData } from '@/utils/sessions/tempDataStore';
import { installSessionRouteCommonModuleMocks } from './sessionRouteTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let mockSessionId = 'session-1';
const realStorageRef = vi.hoisted(() => ({ current: null as typeof import('@/sync/domains/state/storageStore')['storage'] | null }));
let mockServerId: string | undefined;
let mockSession: any = null;
let isDataReady = true;
let sessionHydrated = true;
let sessionIsConnected = true;
let localDevModeEnabled = false;
const routerPushSpy = vi.fn();
const routerNavigateSpy = vi.fn();
const routerBackSpy = vi.fn();
const safeRouterBackSpy = vi.fn();
const readMachineTargetForSessionSpy = vi.fn();
const readDisplayMachineTargetForSessionSpy = vi.fn();
const resolveServerIdForSessionIdFromLocalCacheSpy = vi.fn();
const resolvePreferredServerIdForSessionIdSpy = vi.fn();
const usePreferredServerIdForSessionSpy = vi.fn();
const machineRpcWithServerScopeSpy = vi.fn();
const sessionStopSpy = vi.fn(async () => ({ success: true }));
const sessionReadStateSpy = vi.fn(async () => ({ success: true }));
type ArchiveSpyResult = Readonly<{
    success: boolean;
    archivedAt?: number | null;
    message?: string;
    code?: string;
}>;
const sessionArchiveSpy = vi.fn(async (): Promise<ArchiveSpyResult> => ({ success: true, archivedAt: 1 }));
const deleteBoundarySpies: Array<{ mockRestore(): void }> = [];
const modalAlertSpy = vi.fn();
const modalConfirmSpy = vi.fn(async () => true);
const modalPromptSpy = vi.fn(async () => 'urgent, review');
const createDefaultActionExecutorSpy = vi.fn<(options: unknown) => unknown>();
const completeSessionForkNavigationSpy = vi.fn<(params: unknown) => Promise<void>>(async () => undefined);
const setPinnedSessionKeysV1Spy = vi.fn();
const setSessionTagsV1Spy = vi.fn();
const openMoveSheetSpy = vi.fn(async () => null as any);
const setSessionFolderAssignmentSpy = vi.fn(async () => undefined);
const sessionOrganizationOps = vi.hoisted(() => ({
    setSessionPin: vi.fn(async () => undefined),
    setSessionTagAssignments: vi.fn(async () => undefined),
    setSessionFolderAssignment: vi.fn(async () => undefined),
    sessionSetAttentionStandingWithServerScope: vi.fn(async () => ({ success: true })),
}));
let hideInactiveSessions = false;
let actionsSettings = settingsDefaults.actionsSettingsV1;
let sessionListAttentionPromotionMode: string | null = null;
let pinnedSessionKeysV1: unknown = null;
let sessionTagsV1: unknown = null;
let sessionFoldersV1: unknown = null;
let sessionOrganizationProjection: any = null;
let resolvedServerId = 'server-1';
let sessionHandoffFeatureEnabled = false;
let sessionFoldersFeatureEnabled = false;
let automationsEnabled = false;
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
    resume: {},
    displayNameKey: 'agentInput.agent.claude',
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
const useSessionStatusSpy = vi.fn();
const itemListRenderSpy = vi.fn();
const useSessionExecutionRunsSupportedSpy = vi.fn<(sessionId: string) => boolean>(() => false);
const useSessionSpy = vi.fn<(sessionId: string) => any>(() => mockSession);
const hydrateSpy = vi.fn((sessionId: string, _tag: string, options?: { serverId?: string }) =>
    sessionHydrated
        ? { kind: 'available', sessionId, serverId: options?.serverId }
        : { kind: 'loading', sessionId, serverId: options?.serverId, reason: 'cold' },
);

const routerMock = createExpoRouterMock({
    router: {
        push: routerPushSpy,
        navigate: routerNavigateSpy,
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
    storageModule: async () => {
        const store = createStorageStoreProxy(() => {
            if (!realStorageRef.current) throw new Error('Real storage must be initialized before rendering');
            return realStorageRef.current;
        });
        return createStorageModuleStub({
                storage: store,
                getStorage: () => store,
                useSession: (sessionId: string) => useSessionSpy(sessionId),
                useIsDataReady: () => isDataReady,
                useLocalSetting: <K extends keyof LocalSettings>(name: K): LocalSettings[K] => {
                    if (name === 'devModeEnabled') {
                        return localDevModeEnabled as LocalSettings[K];
                    }
                    return null as unknown as LocalSettings[K];
                },
                useSetting: (key: string) => {
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
                    if (key === 'sessionListAttentionPromotionModeV1') {
                        return sessionListAttentionPromotionMode;
                    }
                    return null;
                },
                useSessionOrganizationProjection: () => sessionOrganizationProjection,
                useSettingMutable: (key: string) => {
                    if (key === 'pinnedSessionKeysV1') {
                        return [pinnedSessionKeysV1, setPinnedSessionKeysV1Spy];
                    }
                    if (key === 'sessionTagsV1') {
                        return [sessionTagsV1, setSessionTagsV1Spy];
                    }
                    return [null, vi.fn()];
                },
        });
    },
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
    Octicons: 'Octicons',
}));

vi.mock('@/sync/ops/sessionMachineTarget', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/ops/sessionMachineTarget')>();
    return {
        ...actual,
        readMachineTargetForSession: (sessionId: string) => readMachineTargetForSessionSpy(sessionId),
        resolveMachineTargetForSessionFromState: (_state: unknown, sessionId: string) =>
            readMachineTargetForSessionSpy(sessionId),
        readDisplayMachineTargetForSession: (params: any) => readDisplayMachineTargetForSessionSpy(params),
    };
});

vi.mock('@/hooks/session/useHydrateSessionForRoute', () => ({
    useHydrateSessionForRoute: (sessionId: string, tag: string, options?: { serverId?: string }) =>
        hydrateSpy(sessionId, tag, options),
}));
vi.mock('@/utils/navigation/safeRouterBack', () => ({
    safeRouterBack: (...args: any[]) => safeRouterBackSpy(...args),
}));

vi.mock('@/components/ui/text/Text', () => ({ Text: (props: any) => React.createElement('Text', props, props.children) }));
vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement('Item', { ...props, testID: props.testID ?? props.title }, props.children),
}));
vi.mock('@/components/ui/lists/ItemGroup', () => ({ ItemGroup: 'ItemGroup' }));
vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: (props: any) => {
        itemListRenderSpy(props);
        return React.createElement('ItemList', props, props.children);
    },
}));
vi.mock('@/components/ui/avatar/Avatar', () => ({
    Avatar: (props: any) => React.createElement('Avatar', { ...props, testID: props.testID ?? 'session-info-avatar' }),
}));
vi.mock('@/components/ui/media/CodeView', () => ({
    CodeView: ({ code, language }: { code: string; language: string }) =>
        React.createElement('CodeView', { code, language }),
}));
vi.mock('@/components/sessions/info/SessionRetentionNotice', () => ({ SessionRetentionNotice: 'SessionRetentionNotice' }));
vi.mock('@/hooks/ui/useHappyAction', () => ({ useHappyAction: (fn: any) => useHappyActionMock(fn) }));
vi.mock('@/sync/ops', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/ops')>();
    return {
        sessionArchiveWithServerScope: sessionArchiveSpy,
        sessionDelete: actual.sessionDelete,
        sessionDeleteWithServerScope: actual.sessionDeleteWithServerScope,
        sessionRename: vi.fn(),
        sessionSetManualReadStateWithServerScope: sessionReadStateSpy,
        sessionStop: sessionStopSpy,
        sessionStopWithServerScope: sessionStopSpy,
    };
});
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
vi.mock('@/hooks/server/useAutomationsSupport', () => ({
    useAutomationsSupport: () => ({ enabled: automationsEnabled }),
}));
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
vi.mock('@/auth/storage/tokenStorage', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/auth/storage/tokenStorage')>(),
    TokenStorage: {
        getCredentialsForServerUrl: vi.fn(async () => ({ token: 'token' })),
    },
}));
vi.mock('@/sync/ops/sessionFolders', () => ({
    setSessionFolderAssignment: setSessionFolderAssignmentSpy,
}));
vi.mock('@/sync/ops/sessionOrganization', () => ({
    setSessionPin: sessionOrganizationOps.setSessionPin,
    setSessionTagLabels: sessionOrganizationOps.setSessionTagAssignments,
    setSessionFolderAssignment: sessionOrganizationOps.setSessionFolderAssignment,
    sessionSetAttentionStandingWithServerScope: sessionOrganizationOps.sessionSetAttentionStandingWithServerScope,
}));
vi.mock('@/hooks/server/useSessionExecutionRunsSupported', () => ({
    useSessionExecutionRunsSupported: (sessionId: string) => useSessionExecutionRunsSupportedSpy(sessionId),
}));
vi.mock('@/sync/ops/actions/defaultActionExecutor', () => ({
    createDefaultActionExecutor: (options: unknown) => createDefaultActionExecutorSpy(options),
}));
vi.mock('@/components/sessions/transcript/forkContext/completeSessionForkNavigation', () => ({
    completeSessionForkNavigation: (params: unknown) => completeSessionForkNavigationSpy(params),
}));
vi.mock(
    '@/sync/runtime/orchestration/serverScopedRpc/resolveServerIdForSessionIdFromLocalCache',
    async (importOriginal) => {
        const { createResolveServerIdForSessionIdFromLocalCacheModuleMock } = await import(
            '@/dev/testkit/mocks/serverScopedRpc'
        );
        return createResolveServerIdForSessionIdFromLocalCacheModuleMock({
            importOriginal,
            overrides: {
                resolveServerIdForSessionIdFromLocalCache: (sessionId: string) =>
                    resolveServerIdForSessionIdFromLocalCacheSpy(sessionId),
            },
        });
    },
);
vi.mock(
    '@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId',
    async (importOriginal) => {
        const { createResolvePreferredServerIdForSessionIdModuleMock } = await import(
            '@/dev/testkit/mocks/serverScopedRpc'
        );
        return createResolvePreferredServerIdForSessionIdModuleMock({
            importOriginal,
            overrides: {
                resolvePreferredServerIdForSessionId: (sessionId: string) =>
                    resolvePreferredServerIdForSessionIdSpy(sessionId),
            },
        });
    },
);
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession', () => ({
    usePreferredServerIdForSession: (sessionId: string) => usePreferredServerIdForSessionSpy(sessionId),
}));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: (...args: unknown[]) => machineRpcWithServerScopeSpy(...args),
}));
vi.mock('@/sync/domains/features/featureDecisionRuntime', () => ({
    useServerFeaturesSnapshotForServerId: () => serverFeaturesSnapshot,
}));
vi.mock('@/sync/domains/settings/actionsSettings', () => ({ isActionEnabledInState: () => true }));
vi.mock('@/sync/domains/sessionFork/forkUiSupport', () => ({ canForkConversation: () => true }));
vi.mock('@/components/sessions/fork/openSessionForkStrategyFlow', () => ({ openSessionForkStrategyFlow: vi.fn() }));
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
            const runtimeDescriptor = metadata?.agentRuntimeDescriptorV1 as any;
            return typeof runtimeDescriptor?.providerId === 'string' ? runtimeDescriptor.providerId : null;
        },
    };
});
vi.mock('@/utils/sessions/sessionUtils', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/utils/sessions/sessionUtils')>(),
    getSessionName: () => 'name',
    useSessionStatus: (...args: unknown[]) => {
        useSessionStatusSpy(...args);
        return {
            isConnected: sessionIsConnected,
            statusText: 'Connected',
            statusColor: 'green',
            statusDotColor: 'green',
            isPulsing: false,
        };
    },
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

const { storage } = await import('@/sync/domains/state/storageStore');
realStorageRef.current = storage;
const { TokenStorage } = await import('@/auth/storage/tokenStorage');
const { apiSocket } = await import('@/sync/api/session/apiSocket');
const { buildSessionListRenderableFromSession } = await import('@/sync/domains/session/listing/sessionListRenderable');
const runtimeFetch = await import('@/utils/system/runtimeFetch');
const { HappyError } = await import('@/utils/errors/errors');
const { default: Screen } = await import('@/app/(app)/session/[id]/info');

describe('/session/[id]/info', () => {
    beforeEach(() => {
        for (const serverId of ['server-1', 'server-b', 'server-cache-info', 'server_preferred_info', 'server_reactive_info']) {
            upsertServerProfile({ serverUrl: `https://${serverId}` });
        }
        setActiveServerId('server-1');
        storage.setState(storage.getInitialState(), true);
        actionsSettings = settingsDefaults.actionsSettingsV1;
        storage.getState().applySettingsLocal({ actionsSettingsV1: actionsSettings });
        mockSessionId = 'session-1';
        mockServerId = undefined;
        mockSession = null;
        isDataReady = true;
        sessionHydrated = true;
        sessionIsConnected = true;
        localDevModeEnabled = false;
        routerPushSpy.mockReset();
        routerNavigateSpy.mockReset();
        routerBackSpy.mockReset();
        safeRouterBackSpy.mockReset();
        readMachineTargetForSessionSpy.mockReset();
        readMachineTargetForSessionSpy.mockReturnValue(null);
        readDisplayMachineTargetForSessionSpy.mockReset();
        readDisplayMachineTargetForSessionSpy.mockReturnValue(null);
        sessionStopSpy.mockClear();
        sessionReadStateSpy.mockClear();
        sessionArchiveSpy.mockClear();
        modalAlertSpy.mockClear();
        modalConfirmSpy.mockClear();
        modalPromptSpy.mockClear();
        modalPromptSpy.mockResolvedValue('urgent, review');
        createDefaultActionExecutorSpy.mockClear();
        completeSessionForkNavigationSpy.mockClear();
        setPinnedSessionKeysV1Spy.mockClear();
        setSessionTagsV1Spy.mockClear();
        openMoveSheetSpy.mockClear();
        openMoveSheetSpy.mockResolvedValue(null);
        setSessionFolderAssignmentSpy.mockClear();
        sessionListAttentionPromotionMode = null;
        sessionOrganizationOps.sessionSetAttentionStandingWithServerScope.mockClear();
        sessionOrganizationOps.setSessionPin.mockClear();
        sessionOrganizationOps.setSessionTagAssignments.mockClear();
        sessionOrganizationOps.setSessionFolderAssignment.mockClear();
        resolvedServerId = 'server-1';
        resolveServerIdForSessionIdFromLocalCacheSpy.mockClear();
        resolvePreferredServerIdForSessionIdSpy.mockClear();
        usePreferredServerIdForSessionSpy.mockClear();
        useSessionStatusSpy.mockClear();
        itemListRenderSpy.mockClear();
        useSessionExecutionRunsSupportedSpy.mockClear();
        machineRpcWithServerScopeSpy.mockClear();
        hydrateSpy.mockClear();
        resolveServerIdForSessionIdFromLocalCacheSpy.mockReturnValue(resolvedServerId);
        resolvePreferredServerIdForSessionIdSpy.mockImplementation(() => resolvedServerId);
        usePreferredServerIdForSessionSpy.mockImplementation(() => resolvedServerId);
        machineRpcWithServerScopeSpy.mockRejectedValue(new Error('unreachable'));
        hideInactiveSessions = false;
        pinnedSessionKeysV1 = null;
        sessionTagsV1 = null;
        sessionFoldersV1 = null;
        resetSessionOrganizationProjection();
        sessionHandoffFeatureEnabled = false;
        sessionFoldersFeatureEnabled = false;
        automationsEnabled = false;
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
            resume: {},
            displayNameKey: 'agentInput.agent.claude',
            permissions: { modeGroup: 'codexLike' },
            ui: { agentPickerIconName: 'code-slash-outline' },
        };
        useSessionSpy.mockClear();
        mockResolveAgentIdFromFlavor.mockReset();
        mockResolveAgentIdFromFlavor.mockReturnValue('claude');
        clearTempData();
        vi.clearAllMocks();
        useHappyActionMock.mockReset();
        useHappyActionMock.mockImplementation((fn: any) => [false, fn] as const);
        createDefaultActionExecutorSpy.mockReturnValue({});
    });

    afterEach(() => {
        clearTempData();
        standardCleanup();
        while (deleteBoundarySpies.length > 0) deleteBoundarySpies.pop()?.mockRestore();
    });

    async function renderInfoScreen() {
        storage.getState().applySettingsLocal({ actionsSettingsV1: actionsSettings });
        return renderScreen(<Screen />);
    }

    function setSessionOwnerServer(serverId: string | null) {
        resolvedServerId = serverId ?? 'server-1';
        resolveServerIdForSessionIdFromLocalCacheSpy.mockReturnValue(serverId);
        resolvePreferredServerIdForSessionIdSpy.mockReturnValue(serverId);
        usePreferredServerIdForSessionSpy.mockReturnValue(serverId);
    }

    function resetSessionOrganizationProjection(overrides: Record<string, unknown> = {}) {
        sessionOrganizationProjection = {
            schemaVersion: 1,
            version: 1,
            pinnedSessionIds: [],
            pinsBySessionId: {},
            foldersById: {},
            folderAssignmentsBySessionId: {},
            tagsById: {},
            tagAssignmentsBySessionId: {},
            attentionStandingsBySessionId: {},
            orderEntriesByScopeKey: {},
            labelsByLabelKey: {},
            ...overrides,
        };
    }

    function plainDisplay(value: Record<string, unknown>) {
        return { t: 'plain', v: value };
    }

    it('shows loading while the route hydration is still in progress', async () => {
        sessionHydrated = false;
        mockServerId = 'server-b';
        const screen = await renderInfoScreen();
        expect(screen.getTextContent()).toContain('common.loading');
        expect(hydrateSpy).toHaveBeenCalledWith('session-1', 'SessionInfoRoute.ensureSessionVisible', { serverId: 'server-b' });
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
        sessionHydrated = false;
        const screen = await renderInfoScreen();
        expect(screen.getTextContent()).not.toContain('common.loading');
        expect(screen.getTextContent()).toContain('name');
    });

    it('normalizes the route id before looking up the session', async () => {
        mockSessionId = ['session-2 '] as any;
        await renderInfoScreen();
        expect(useSessionSpy).toHaveBeenCalledWith('session-2');
    });

    it('keeps scoped route helpers stable when only volatile session fields change', async () => {
        mockServerId = 'server-b';
        mockSession = {
            id: 'session-1234567890abcdef',
            active: true,
            accessLevel: null,
            createdAt: 100,
            updatedAt: 200,
            seq: 1,
            metadata: {},
        };

        const screen = await renderScreen(<Screen />);
        expect(createDefaultActionExecutorSpy).toHaveBeenCalledTimes(1);

        mockSession = {
            ...mockSession,
            updatedAt: 300,
            seq: 2,
            thinkingAt: 301,
        };

        await screen.update(<Screen />);

        expect(createDefaultActionExecutorSpy).toHaveBeenCalledTimes(1);
    });

    it('derives status from the route session without duplicate store subscriptions', async () => {
        mockSession = {
            id: 'session-1234567890abcdef',
            active: true,
            accessLevel: null,
            createdAt: 100,
            updatedAt: 200,
            seq: 1,
            metadata: {},
        };

        await renderInfoScreen();

        expect(useSessionStatusSpy).toHaveBeenCalledWith(mockSession, {
            subscribeToSession: false,
            subscribeToTranscript: false,
        });
    });

    it('shows projected product activity before raw thinking diagnostics', async () => {
        mockSession = {
            id: 'session-1234567890abcdef',
            active: true,
            accessLevel: null,
            createdAt: 100,
            updatedAt: 200,
            seq: 1,
            thinking: true,
            thinkingAt: 150,
            latestTurnStatus: 'completed',
            latestTurnStatusObservedAt: 180,
            metadata: {},
        };

        const screen = await renderInfoScreen();

        const activityStatusItem = screen.findAllByType('Item' as any)
            .find((node: any) => node.props?.title === 'sessionInfo.sessionStatus');
        expect(activityStatusItem?.props.detail).toBe('Connected');
    });

    it('updates product activity status inputs when pending freshness projection changes', async () => {
        mockSession = {
            id: 'session-1234567890abcdef',
            active: true,
            activeAt: 1,
            presence: 'online',
            accessLevel: null,
            createdAt: 100,
            updatedAt: 200,
            seq: 1,
            pendingPermissionRequestCount: 1,
            pendingUserActionRequestCount: 0,
            pendingRequestObservedAt: 10,
            latestTurnStatus: 'in_progress',
            latestTurnStatusObservedAt: 10,
            metadata: {},
        };

        const screen = await renderScreen(<Screen />);
        useSessionStatusSpy.mockClear();

        mockSession = {
            ...mockSession,
            pendingRequestObservedAt: 300,
        };

        await screen.update(<Screen />);

        expect(useSessionStatusSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                pendingRequestObservedAt: 300,
            }),
            {
                subscribeToSession: false,
                subscribeToTranscript: false,
            },
        );
    });

    it('does not rebuild the full info list when only volatile session counters change', async () => {
        mockSession = {
            id: 'session-1234567890abcdef',
            active: true,
            accessLevel: null,
            createdAt: 100,
            updatedAt: 200,
            seq: 1,
            metadata: {},
        };

        const screen = await renderScreen(<Screen />);
        expect(itemListRenderSpy).toHaveBeenCalled();
        itemListRenderSpy.mockClear();

        mockSession = {
            ...mockSession,
            updatedAt: 300,
            seq: 2,
        };

        await screen.update(<Screen />);

        expect(itemListRenderSpy).not.toHaveBeenCalled();
    });

    it('does not subscribe to execution-run session signals while the runs feature is disabled', async () => {
        mockSession = {
            id: 'session-1234567890abcdef',
            active: true,
            accessLevel: null,
            createdAt: 100,
            updatedAt: 200,
            seq: 1,
            metadata: {},
        };

        await renderInfoScreen();

        expect(useSessionExecutionRunsSupportedSpy).not.toHaveBeenCalled();
    });

    it('routes forked child session opens through the shared fork completion helper with scoped hrefs', async () => {
        mockServerId = 'server-b';
        mockSession = {
            id: 'session-1234567890abcdef',
            active: false,
            accessLevel: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 1,
            metadata: {},
        };

        await renderInfoScreen();

        const executorOptions = createDefaultActionExecutorSpy.mock.calls[0]?.[0] as any;
        expect(executorOptions?.openSession).toEqual(expect.any(Function));

        await act(async () => { await executorOptions.openSession('child-session'); });

        expect(completeSessionForkNavigationSpy).toHaveBeenCalledWith({
            childSessionId: 'child-session',
            parentSessionId: 'session-1234567890abcdef',
            serverId: 'server-b',
            navigate: expect.any(Function),
        });

        const helperParams = completeSessionForkNavigationSpy.mock.calls[0]?.[0] as any;
        await act(async () => { helperParams.navigate('next-child'); });
        expect(routerNavigateSpy).toHaveBeenCalledWith('/session/next-child?serverId=server-b', expect.any(Object));
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

    it('shows the handoff quick action when server-routed transfer is the available transport', async () => {
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
        expect(handoffItems).toHaveLength(1);
    });

    it('reacts when machine-rpc direct-peer viability becomes available for the reachable machine target after metadata goes stale', async () => {
        sessionHandoffFeatureEnabled = true;
        resolvedServerId = 'server_reactive_info';
        resolveServerIdForSessionIdFromLocalCacheSpy.mockReturnValue('server_reactive_info');
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

    it('falls back to the preferred session server when the local server cache misses and still surfaces handoff after a scoped reachability probe succeeds', async () => {
        sessionHandoffFeatureEnabled = true;
        resolvedServerId = 'server_preferred_info';
        resolveServerIdForSessionIdFromLocalCacheSpy.mockReturnValue(null);
        resolvePreferredServerIdForSessionIdSpy.mockReturnValue('server_preferred_info');
        usePreferredServerIdForSessionSpy.mockReturnValue('server_preferred_info');
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
                    providerId: 'opencode',
                    provider: {
                        backendMode: 'server',
                        vendorSessionId: 'runtime-session-1234567890',
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
                    providerId: 'opencode',
                    provider: {
                        backendMode: 'server',
                        vendorSessionId: 'runtime-session-1234567890',
                    },
                },
            },
        };

        const screen = await renderInfoScreen();
        expect(screen.findByTestId('sessionInfo.openCodeSessionId')).toBeTruthy();
        expect(mockResolveAgentIdFromFlavor).not.toHaveBeenCalled();
        const avatar = screen.findByTestId('session-info-avatar');
        if (!avatar) {
            throw new Error('expected session info avatar');
        }
        expect(avatar.props.flavor).toBe('opencode');
    });

    it('routes View Machine to the stable display target when live reachability differs', async () => {
        readMachineTargetForSessionSpy.mockReturnValue({
            machineId: 'machine-live-rpc',
            basePath: '/workspace/repo',
        });
        readDisplayMachineTargetForSessionSpy.mockReturnValue({
            machineId: 'machine-display',
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
        expect(viewMachineItem?.props.subtitleAccessory?.props.children).toBe('machine-display');
        expect(screen.findByTestId('sessionInfo.path')).toBeTruthy();

        screen.pressByTestId('sessionInfo.viewMachine');

        expect(routerPushSpy).toHaveBeenCalledWith('/machine/machine-display');
    });

    it('opens a new session seeded from the current session configuration', async () => {
        mockServerId = 'server-b';
        usePreferredServerIdForSessionSpy.mockImplementation(() => 'server-b');
        readMachineTargetForSessionSpy.mockReturnValue({
            machineId: 'machine-target',
            basePath: '/workspace/repo',
        });
        readDisplayMachineTargetForSessionSpy.mockReturnValue({
            machineId: 'machine-display',
            basePath: '/workspace/display',
        });
        mockSession = {
            id: 'session-1',
            active: true,
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
                profileId: 'profile-1',
                transcriptStorage: 'direct',
                codexBackendMode: 'appServer',
                sessionModeOverrideV1: {
                    v: 1,
                    updatedAt: 100,
                    modeId: 'plan',
                },
            },
            permissionMode: 'safe-yolo',
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
                draftId: expect.stringMatching(/^[0-9a-f-]{36}$/i),
                dataId: expect.any(String),
                machineId: 'machine-display',
                directory: '/workspace/display',
                spawnServerId: 'server-b',
            },
        });
        const tempData = peekTempData<NewSessionData>(pushArg.params.dataId);
        expect(tempData).toEqual(expect.objectContaining({
            prompt: '',
            replacePersistedDraftSelections: true,
            machineId: 'machine-display',
            directory: '/workspace/display',
            agentType: 'codex',
            backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
            selectedProfileId: 'profile-1',
            transcriptStorage: 'direct',
            permissionMode: 'safe-yolo',
            modelMode: 'gpt-5',
            codexBackendMode: 'appServer',
            acpSessionModeId: 'plan',
        }));
    });

    it('seeds a new session with the machine-visible workspace root when the display root is sandbox-local', async () => {
        readMachineTargetForSessionSpy.mockReturnValue({
            machineId: 'machine-1',
            basePath: '/Users/alice/project',
            agentBasePath: '/home/coder/project',
        });
        readDisplayMachineTargetForSessionSpy.mockReturnValue({
            machineId: 'machine-1',
            basePath: '/home/coder/project',
        });
        mockSession = {
            id: 'session-1',
            active: true,
            accessLevel: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 1,
            metadata: {
                machineId: 'machine-1',
                path: '/home/coder/project',
                flavor: 'codex',
            },
        };

        const screen = await renderInfoScreen();
        screen.pressByTestId('session-info-new-session-same-setup');

        const pushArg = routerPushSpy.mock.calls[0]?.[0] as any;
        expect(pushArg.params).toEqual(expect.objectContaining({
            machineId: 'machine-1',
            directory: '/Users/alice/project',
        }));
        const tempData = peekTempData<NewSessionData>(pushArg.params.dataId);
        expect(tempData).toEqual(expect.objectContaining({
            machineId: 'machine-1',
            directory: '/Users/alice/project',
        }));
    });

    it('always shows the View session log action even when developer mode is disabled', async () => {
        mockServerId = 'server-b';
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
        screen.pressByTestId('sessionInfo.viewSessionLogTitle');
        expect(routerPushSpy).toHaveBeenCalledWith('/session/session-1/log?serverId=server-b');
    });

    it('routes session automations through the current route scope', async () => {
        mockServerId = 'server-b';
        automationsEnabled = true;
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
        screen.pressByTestId('sessionInfo.automationsTitle');

        expect(routerPushSpy).toHaveBeenCalledWith('/session/session-1/automations?serverId=server-b');
    });

    it('forwards selected server scope when pressing mark-unread quick action', async () => {
        mockServerId = 'server-b';
        setSessionOwnerServer('server-b');
        mockSession = {
            id: 'session-1',
            active: false,
            accessLevel: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 2,
            lastViewedSessionSeq: 2,
            latestTurnStatus: 'completed',
            archivedAt: null,
            metadata: {},
        };

        const screen = await renderInfoScreen();
        await screen.pressByTestIdAsync('session-info-mark-unread');

        expect(sessionReadStateSpy).toHaveBeenCalledWith('session-1', 'unread', { serverId: 'server-b' });
    });

    it('forwards selected server scope when pressing mark-read quick action', async () => {
        mockServerId = 'server-b';
        setSessionOwnerServer('server-b');
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
        await screen.pressByTestIdAsync('session-info-mark-read');

        expect(sessionReadStateSpy).toHaveBeenCalledWith('session-1', 'read', { serverId: 'server-b' });
    });

    it('surfaces pin and tag actions from the session view quick actions', async () => {
        mockServerId = 'server-b';
        setSessionOwnerServer('server-b');
        pinnedSessionKeysV1 = ['server-b:legacy-pinned'];
        sessionTagsV1 = { 'server-b:session-1': ['legacy'] };
        resetSessionOrganizationProjection({
            tagAssignmentsBySessionId: {
                'session-1': ['existing'],
            },
        });
        mockSession = {
            id: 'session-1',
            active: false,
            accessLevel: null,
            owner: null,
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
        expect(setPinnedSessionKeysV1Spy).not.toHaveBeenCalled();
        expect(sessionOrganizationOps.setSessionPin).toHaveBeenCalledWith({
            credentials: { token: 'token' },
            serverId: 'server-b',
            serverUrl: 'https://server-b',
            sessionId: 'session-1',
            pinned: true,
        });

        await screen.pressByTestIdAsync('session-info-session-tags-edit');
        expect(modalPromptSpy).toHaveBeenCalledWith(
            'sessionsList.selectionSetTagsPromptTitle',
            'sessionsList.selectionTagsPromptMessage',
            expect.objectContaining({ defaultValue: 'existing' }),
        );
        expect(setSessionTagsV1Spy).not.toHaveBeenCalled();
        expect(sessionOrganizationOps.setSessionTagAssignments).toHaveBeenCalledWith({
            credentials: { token: 'token' },
            serverId: 'server-b',
            serverUrl: 'https://server-b',
            sessionId: 'session-1',
            tags: ['urgent', 'review'],
        });
    });

    it('surfaces the attention standing action from the session view quick actions', async () => {
        mockServerId = 'server-b';
        setSessionOwnerServer('server-b');
        sessionListAttentionPromotionMode = 'global';
        resetSessionOrganizationProjection();
        mockSession = {
            id: 'session-1',
            active: false,
            accessLevel: null,
            owner: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 2,
            lastViewedSessionSeq: 2,
            latestTurnStatus: 'completed',
            archivedAt: null,
            metadata: {},
        };

        const screen = await renderInfoScreen();

        expect(screen.findByTestId('session-info-session-clear-attention-standing')).toBeNull();
        await screen.pressByTestIdAsync('session-info-session-set-attention-standing');

        expect(sessionOrganizationOps.sessionSetAttentionStandingWithServerScope).toHaveBeenCalledWith(
            'session-1',
            true,
            { serverId: 'server-b' },
        );
    });

    it('offers to remove a stored standing session from Needs attention', async () => {
        mockServerId = 'server-b';
        setSessionOwnerServer('server-b');
        sessionListAttentionPromotionMode = 'global';
        resetSessionOrganizationProjection({
            attentionStandingsBySessionId: {
                'session-1': { sessionId: 'session-1', standing: true, updatedAt: 5 },
            },
        });
        mockSession = {
            id: 'session-1',
            active: false,
            accessLevel: null,
            owner: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 2,
            lastViewedSessionSeq: 2,
            latestTurnStatus: 'completed',
            archivedAt: null,
            metadata: {},
        };

        const screen = await renderInfoScreen();

        expect(screen.findByTestId('session-info-session-set-attention-standing')).toBeNull();
        await screen.pressByTestIdAsync('session-info-session-clear-attention-standing');

        expect(sessionOrganizationOps.sessionSetAttentionStandingWithServerScope).toHaveBeenCalledWith(
            'session-1',
            false,
            { serverId: 'server-b' },
        );
    });

    it('hides the attention standing action while the attention band is off', async () => {
        mockServerId = 'server-b';
        setSessionOwnerServer('server-b');
        sessionListAttentionPromotionMode = 'off';
        resetSessionOrganizationProjection({
            attentionStandingsBySessionId: {
                'session-1': { sessionId: 'session-1', standing: true, updatedAt: 5 },
            },
        });
        mockSession = {
            id: 'session-1',
            active: false,
            accessLevel: null,
            owner: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 2,
            lastViewedSessionSeq: 2,
            latestTurnStatus: 'completed',
            archivedAt: null,
            metadata: {},
        };

        const screen = await renderInfoScreen();

        expect(screen.findByTestId('session-info-session-set-attention-standing')).toBeNull();
        expect(screen.findByTestId('session-info-session-clear-attention-standing')).toBeNull();
    });

    it('surfaces move-to-folder from the session view when folder targets match the session workspace', async () => {
        mockServerId = 'server-1';
        setSessionOwnerServer('server-1');
        sessionFoldersFeatureEnabled = true;
        sessionFoldersV1 = { v: 1, folders: [] };
        resetSessionOrganizationProjection({
            foldersById: {
                'folder-1': {
                    folderId: 'folder-1',
                    parentFolderId: null,
                    sortKey: null,
                    display: plainDisplay({
                        name: 'Planning',
                        workspace: {
                            t: 'workspaceScope',
                            serverId: 'server-1',
                            machineId: 'machine-1',
                            rootPath: '/repo',
                        },
                    }),
                    archivedAt: null,
                    createdAt: 1,
                    updatedAt: 1,
                },
            },
        });
        sessionFoldersV1 = {
            v: 1,
            folders: [{
                id: 'legacy-folder',
                workspace: {
                    t: 'workspaceScope',
                    serverId: 'server-1',
                    machineId: 'machine-1',
                    rootPath: '/repo',
                },
                parentId: null,
                name: 'Legacy',
                createdAt: 1,
                updatedAt: 1,
            }],
        };
        mockSession = {
            id: 'session-1',
            active: false,
            accessLevel: null,
            owner: null,
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
        expect(setSessionFolderAssignmentSpy).not.toHaveBeenCalled();
        expect(sessionOrganizationOps.setSessionFolderAssignment).toHaveBeenCalledWith(expect.objectContaining({
            credentials: { token: 'token' },
            serverId: 'server-1',
            serverUrl: 'https://server-1',
            sessionId: 'session-1',
            folderId: 'folder-1',
        }));
    });

    it('hides read-state quick action for non-terminal raw session seq', async () => {
        mockSession = {
            id: 'session-1',
            active: false,
            accessLevel: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 2,
            lastViewedSessionSeq: 1,
            latestTurnStatus: 'in_progress',
            archivedAt: null,
            metadata: {},
        };

        const screen = await renderInfoScreen();

        expect(screen.findByTestId('session-info-mark-unread')).toBeNull();
        expect(screen.findByTestId('session-info-mark-read')).toBeNull();
    });

    it('hides read-state quick action for archived sessions', async () => {
        mockSession = {
            id: 'session-1',
            active: false,
            accessLevel: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 2,
            lastViewedSessionSeq: 2,
            archivedAt: 123,
            metadata: {},
        };

        const screen = await renderInfoScreen();

        expect(screen.findByTestId('session-info-mark-unread')).toBeNull();
        expect(screen.findByTestId('session-info-mark-read')).toBeNull();
    });

    it('hides pin quick action for archived sessions', async () => {
        mockServerId = 'server-b';
        setSessionOwnerServer('server-b');
        mockSession = {
            id: 'session-1',
            active: false,
            accessLevel: null,
            owner: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 2,
            lastViewedSessionSeq: 2,
            archivedAt: 123,
            metadata: {},
        };

        const screen = await renderInfoScreen();

        expect(screen.findByTestId('session-info-session-pin')).toBeNull();
        expect(screen.findByTestId('session-info-session-unpin')).toBeNull();
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

    it('wires session detail copy rows through item-local copy feedback', async () => {
        localDevModeEnabled = true;
        mockAgentCore = {
            resume: {
                vendorResumeIdField: 'claudeSessionId',
                uiVendorResumeIdLabelKey: 'sessionInfo.claudeCodeSessionId',
                uiVendorResumeIdCopiedKey: 'sessionInfo.claudeCodeSessionIdCopied',
            },
            displayNameKey: 'agentInput.agent.claude',
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
                flavor: 'claude',
                homeDir: '/Users/lee',
                host: 'mac',
                path: '/Users/lee/project',
                claudeSessionId: 'claude-session-1',
                claudeTranscriptPath: '/tmp/claude/session.jsonl',
                sessionLogPath: '/tmp/.happier/logs/session.log',
            },
        };

        const screen = await renderInfoScreen();
        const itemByTitle = (title: string) =>
            screen.findAllByType('Item' as any).find((node: any) => node.props?.title === title);

        expect(itemByTitle('sessionInfo.happySessionId')?.props.copy).toBe('session-1');
        expect(itemByTitle('sessionInfo.happySessionId')?.props.onPress).toBeUndefined();
        expect(itemByTitle('sessionInfo.claudeCodeSessionId')?.props.copy).toBe('claude-session-1');
        expect(itemByTitle('sessionInfo.claudeCodeSessionId')?.props.onPress).toBeUndefined();
        expect(itemByTitle('sessionLog.logPathCopyLabel')?.props.copy).toBe('/tmp/.happier/logs/session.log');
        expect(itemByTitle('sessionLog.logPathCopyLabel')?.props.onPress).toBeUndefined();
        expect(itemByTitle('sessionInfo.providerSessionLogs')?.props.copy).toBe('/tmp/claude/session.jsonl');
        expect(itemByTitle('sessionInfo.providerSessionLogs')?.props.onPress).toBeUndefined();
        expect(itemByTitle('sessionInfo.copyMetadata')?.props.copy).toBe(JSON.stringify(mockSession.metadata, null, 2));
        expect(itemByTitle('sessionInfo.copyMetadata')?.props.onPress).toBeUndefined();
    });

    it('offers session information copying outside developer mode and omits unknown provider artifact lines', async () => {
        localDevModeEnabled = false;
        mockAgentCore = {
            resume: {
                vendorResumeIdField: 'codexSessionId',
            },
            displayNameKey: 'agentInput.agent.codex',
            permissions: { modeGroup: 'codexLike' },
            ui: { agentPickerIconName: 'code-slash-outline' },
        };
        mockResolveAgentIdFromFlavor.mockReturnValue('codex');
        mockSession = {
            id: 'session-1',
            active: false,
            accessLevel: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 1,
            metadata: {
                flavor: 'codex',
                codexSessionId: 'codex-session-1',
                sessionLogPath: '/tmp/.happier/logs/session.log',
            },
        };

        const screen = await renderInfoScreen();
        const copyDebugItem = screen.findAllByType('Item' as any)
            .find((node: any) => node.props?.title === 'sessionInfo.copyDebugInformation');
        expect(copyDebugItem).toBeTruthy();
        expect(copyDebugItem?.props.onPress).toBeUndefined();
        expect(copyDebugItem?.props.copy).toBe([
            'Happier session ID: session-1',
            'agentInput.agent.codex session ID: codex-session-1',
            'Happier logs: /tmp/.happier/logs/session.log',
        ].join('\n'));
    });

    it('shows the provider session logs row when an artifact path is known', async () => {
        localDevModeEnabled = true;
        mockAgentCore = {
            resume: {
                vendorResumeIdField: 'claudeSessionId',
            },
            displayNameKey: 'agentInput.agent.claude',
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
                flavor: 'claude',
                claudeSessionId: 'claude-session-1',
                claudeTranscriptPath: '/tmp/claude/session.jsonl',
            },
        };

        const screen = await renderInfoScreen();
        const providerLogsItem = screen.findAllByType('Item' as any)
            .find((node: any) => node.props?.title === 'sessionInfo.providerSessionLogs');
        expect(providerLogsItem).toBeTruthy();
        expect(providerLogsItem?.props.copy).toBe('/tmp/claude/session.jsonl');
        expect(providerLogsItem?.props.onPress).toBeUndefined();
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

    it('stops without archiving even when inactive sessions are hidden and unpinned', async () => {
        mockServerId = 'server-b';
        setSessionOwnerServer('server-b');
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

    it('stops with the cached owning server id when route scope and preferred scope are unavailable', async () => {
        mockServerId = undefined;
        hideInactiveSessions = true;
        pinnedSessionKeysV1 = [];
        resolvedServerId = 'server-cache-info';
        resolveServerIdForSessionIdFromLocalCacheSpy.mockReturnValue('server-cache-info');
        usePreferredServerIdForSessionSpy.mockReturnValue(null);
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

    it('stops with the cached owning server id when the route server id is stale', async () => {
        mockServerId = 'stale-route-server';
        hideInactiveSessions = true;
        pinnedSessionKeysV1 = [];
        resolvedServerId = 'server-cache-info';
        resolveServerIdForSessionIdFromLocalCacheSpy.mockReturnValue('server-cache-info');
        usePreferredServerIdForSessionSpy.mockReturnValue('server-cache-info');
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
        setSessionOwnerServer('server-b');
        hideInactiveSessions = true;
        pinnedSessionKeysV1 = [];
        resetSessionOrganizationProjection({
            pinnedSessionIds: ['session-1'],
            pinsBySessionId: {
                'session-1': {
                    sessionId: 'session-1',
                    sortKey: null,
                    pinnedAt: 1,
                },
            },
        });
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
        setSessionOwnerServer('server-b');
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

        expect(modalConfirmSpy).not.toHaveBeenCalled();
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

    it('keeps the info screen open when configurable archive confirmation is cancelled', async () => {
        actionsSettings = ActionsSettingsV1Schema.parse({ v: 1, actions: {
            'session.archive': { approvalRequiredSurfaces: ['ui_button'] },
        } });
        modalConfirmSpy.mockResolvedValueOnce(false);
        mockSession = {
            id: 'session-1', active: false, accessLevel: null,
            createdAt: 1, updatedAt: 1, seq: 1, metadata: {}, archivedAt: null,
        };
        const screen = await renderInfoScreen();
        await screen.pressByTestIdAsync('sessionInfo.archiveSession');
        expect(sessionArchiveSpy).not.toHaveBeenCalled();
        expect(safeRouterBackSpy).not.toHaveBeenCalled();
    });

    it('stops and retries archiving when an inactive session is still active server-side', async () => {
        mockServerId = 'server-b';
        setSessionOwnerServer('server-b');
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

    it('deletes a session and exits via the safe back helper', async () => {
        mockServerId = 'server-b';
        setSessionOwnerServer('server-b');
        sessionIsConnected = false;
        const session = createSessionFixture({ id: 'session-1', serverId: 'server-b', active: false, presence: 0 });
        mockSession = session;
        storage.setState({ sessionListViewDataByServerId: {
            'server-b': [{ type: 'session', serverId: 'server-b', session: buildSessionListRenderableFromSession(session) }],
        } });
        const token = 'header.eyJzdWIiOiJtZSJ9.signature';
        deleteBoundarySpies.push(vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token }));
        const activeRequest = vi.spyOn(apiSocket, 'request').mockResolvedValue(Response.json({ success: true }));
        deleteBoundarySpies.push(activeRequest);
        const transport = createServerFetchWithReachabilityProbe(
            async () => Response.json({ success: true }),
        );
        const fetch = vi.spyOn(runtimeFetch, 'runtimeFetch').mockImplementation(async (input, init) => {
            const response = await transport(input, init);
            if (!(response instanceof Response)) throw new Error('Expected an HTTP response from the transport fixture');
            return response;
        });
        deleteBoundarySpies.push(fetch);

        const screen = await renderInfoScreen();
        screen.pressByTestId('sessionInfo.deleteSession');

        expect(modalAlertSpy).toHaveBeenCalledWith(
            'sessionInfo.deleteSession',
            'sessionInfo.deleteSessionWarning',
            expect.arrayContaining([
                expect.objectContaining({ text: 'common.cancel', style: 'cancel' }),
                expect.objectContaining({ text: 'sessionInfo.deleteSession', style: 'destructive' }),
            ]),
        );

        const alertButtons = modalAlertSpy.mock.calls[0]?.[2];
        const deleteButton = alertButtons?.find((button: { text?: string }) => button.text === 'sessionInfo.deleteSession');
        if (!deleteButton?.onPress) {
            throw new Error('expected delete confirmation button to expose onPress');
        }
        expect(fetch.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
        expect(activeRequest).not.toHaveBeenCalled();

        await act(async () => {
            await deleteButton.onPress();
        });

        const request = fetch.mock.calls.find(([, init]) => init?.method === 'DELETE');
        expect(request?.[0]).toEqual(matchServerFetchUrl('https://server-b/v1/sessions/session-1'));
        expect(new Headers(request?.[1]?.headers).get('Authorization')).toBe(`Bearer ${token}`);
        expect(activeRequest).not.toHaveBeenCalled();
        expect(storage.getState().sessionListViewDataByServerId['server-b']).toEqual([]);
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

    it('keeps the session when it becomes active while delete confirmation is open', async () => {
        mockServerId = 'server-b';
        setSessionOwnerServer('server-b');
        sessionIsConnected = false;
        const session = createSessionFixture({ id: 'session-1', serverId: 'server-b', active: false, presence: 0 });
        mockSession = session;
        const renderable = buildSessionListRenderableFromSession(session);
        storage.setState({ sessionListViewDataByServerId: {
            'server-b': [{ type: 'session', serverId: 'server-b', session: renderable }],
        } });
        deleteBoundarySpies.push(vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({
            token: 'header.eyJzdWIiOiJtZSJ9.signature',
        }));
        const activeRequest = vi.spyOn(apiSocket, 'request').mockResolvedValue(Response.json({ success: true }));
        const fetch = vi.spyOn(runtimeFetch, 'runtimeFetch').mockResolvedValue(Response.json({ success: true }));
        deleteBoundarySpies.push(activeRequest, fetch);
        const screen = await renderInfoScreen();
        screen.pressByTestId('sessionInfo.deleteSession');
        const deleteButton = modalAlertSpy.mock.calls[0]?.[2]?.find((button: { style?: string }) => button.style === 'destructive');
        if (!deleteButton?.onPress) throw new Error('Expected delete confirmation');
        storage.setState({ sessionListViewDataByServerId: {
            'server-b': [{ type: 'session', serverId: 'server-b', session: { ...renderable, active: true } }],
        } });

        await act(async () => {
            await expect(deleteButton.onPress()).rejects.toBeInstanceOf(HappyError);
        });

        expect(fetch.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
        expect(activeRequest).not.toHaveBeenCalled();
        expect(storage.getState().sessionListViewDataByServerId['server-b']?.some((row) => row.type === 'session' && row.session.id === session.id)).toBe(true);
        expect(safeRouterBackSpy).not.toHaveBeenCalled();
    });

    it('archives an active session by stopping it first and then archiving it', async () => {
        mockServerId = 'server-b';
        setSessionOwnerServer('server-b');
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
        expect(sessionArchiveSpy).toHaveBeenCalledWith('session-1', { serverId: 'server-b', signal: expect.any(AbortSignal) });
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

    it('reflects an archive started elsewhere and prevents another stop or archive', async () => {
        mockServerId = 'server-b';
        setSessionOwnerServer('server-b');
        mockSession = {
            id: 'session-1', active: true, accessLevel: null,
            createdAt: 1, updatedAt: 1, seq: 1, metadata: {}, archivedAt: null,
        };
        const operation = storage.getState().beginSessionArchive('session-1', 'server-b');
        if (!operation) throw new Error('Expected archive admission');
        try {
            const screen = await renderInfoScreen();
            expect(screen.findByTestId('sessionInfo.stopSession')?.props.disabled).toBe(true);
            expect(screen.findByTestId('sessionInfo.archiveSession')?.props.loading).toBe(true);
            await screen.pressByTestIdAsync('sessionInfo.archiveSession');
            expect(sessionStopSpy).not.toHaveBeenCalled();
            expect(sessionArchiveSpy).not.toHaveBeenCalled();
            expect(safeRouterBackSpy).not.toHaveBeenCalled();
        } finally {
            await act(async () => { storage.getState().finishSessionArchive(operation); });
        }
    });

    it('does not offer archive for active shared sessions even when the viewer has admin access', async () => {
        mockServerId = 'server-b';
        mockSession = {
            id: 'session-1',
            active: true,
            accessLevel: 'admin',
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 1,
            metadata: {},
            archivedAt: null,
        };

        const screen = await renderInfoScreen();

        expect(screen.findByTestId('sessionInfo.archiveSession')).toBeNull();
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
