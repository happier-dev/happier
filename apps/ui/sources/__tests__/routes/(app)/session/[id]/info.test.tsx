import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';
import { createStorageModuleMock } from '@/dev/testkit/mocks/storage';
import type { LocalSettings } from '@/sync/domains/settings/localSettings';
import type { Settings } from '@/sync/domains/settings/settings';
import { clearTempData, peekTempData, type NewSessionData } from '@/utils/sessions/tempDataStore';
import { installSessionRouteCommonModuleMocks } from './sessionRouteTestHelpers';
import type { SessionRouteHydrationState } from '@/sync/domains/session/sessionRouteHydrationState';
import type {
    SessionOrganizationProjection,
    UiSessionOrganizationFolder,
    UiSessionOrganizationTag,
} from '@/sync/domains/session/organization';
import { createUseSettingMock } from '@/dev/testkit/mocks/storage';
import { withPopoverWebGlobals } from '@/dev/testkit/harness/popoverHarness';
import { buildQualifiedPluginContributionKey, deriveSessionCreationTagV1, PluginProjectionV2Schema, SessionCreationCorrespondenceV1Schema, SessionOrganizationContentEnvelopeSchema } from '@happier-dev/protocol';
import { profileDefaults } from '@/sync/domains/profiles/profile';
import { evaluatePluginUiPolicy } from '@/sync/domains/plugins/ui/policy';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { buildServerFeaturesResponse } from '@/hooks/server/serverFeaturesTestUtils';
import { getServerFeaturesSnapshot, resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { normalizeSessionId } from '@/sync/domains/session/normalizeSessionId';
import { createSessionAccessFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { sessionAddressKey } from '@/sync/domains/session/sessionAddress';
import { AUTHORING_MEMORY_ROUTE_V1 } from '@happier-dev/protocol';
import { MMKV } from 'react-native-mmkv';

installDisconnectedServerSocketBoundary();

vi.mock('@/sync/domains/state/browserRecordStorage', async () => {
    const { createBrowserRecordStorageModuleMock } = await import('@/dev/testkit/mocks/browserRecordStorage');
    return createBrowserRecordStorageModuleMock();
});

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let mockSessionId = 'session-1';
let mockServerId: string | undefined;
let mockSession: any = null;
let mockProfile = { ...profileDefaults };
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
const machineListByServerIdState = vi.hoisted(() => ({
    current: {} as Record<string, any[]>,
}));
const machinePoolListByServerIdState = vi.hoisted(() => ({
    current: {} as Record<string, any[] | null>,
}));
const routerPushSpy = vi.fn();
const routerBackSpy = vi.fn();
const safeRouterBackSpy = vi.hoisted(() => vi.fn());
const readMachineTargetForSessionSpy = vi.hoisted(() => vi.fn());
const resolveSessionTargetServerIdSpy = vi.hoisted(() => vi.fn());
const resolveServerIdForSessionIdFromLocalCacheSpy = vi.hoisted(() => vi.fn());
const machineRpcWithServerScopeSpy = vi.hoisted(() => vi.fn());
const machineContributionRegistryProjectionDescribeMock = vi.hoisted(() => vi.fn(async (..._args: unknown[]): Promise<any> => ({ supported: false, reason: 'not-supported' })));
const useSessionExecutionRunsSupportedSpy = vi.fn<(sessionId: string, sessionServerId?: string | null) => boolean>(() => false);
type CreateDefaultActionExecutorConfig = Readonly<{
    resolveServerIdForSessionId?: (sessionId: string) => string | null;
    openSession?: (
        sessionId: string,
        options?: Readonly<{ serverId?: string | null }>,
    ) => void | Promise<void>;
}>;
const createDefaultActionExecutorSpy = vi.hoisted(() => vi.fn((_config: CreateDefaultActionExecutorConfig) => ({})));
// `vi.mock('@/sync/ops', …)` below closes over these spies, and mock factories are
// hoisted above ordinary `const` declarations. Once any import chain pulls
// `@/sync/ops` in eagerly the factory runs first and a plain `const` is still in
// its temporal dead zone, which fails the whole suite at load. `vi.hoisted` is the
// canonical fix and matches the hoisted state this file already uses above.
const sessionStopSpy = vi.hoisted(() => vi.fn(async () => ({ success: true })));
type ArchiveSpyResult = Readonly<{
    success: boolean;
    archivedAt?: number | null;
    message?: string;
    code?: string;
}>;
const sessionArchiveSpy = vi.hoisted(() => vi.fn(async (): Promise<Readonly<{
    success: boolean;
    archivedAt?: number | null;
    message?: string;
    code?: string;
}>> => ({ success: true, archivedAt: 1 })));
const sessionDeleteSpy = vi.hoisted(() => vi.fn(async () => ({ success: true })));
const sessionSetManualReadStateSpy = vi.hoisted(() => vi.fn(async () => ({ success: true, readState: 'unread', lastViewedSessionSeq: 0, didChange: true })));
const modalAlertSpy = vi.fn();
const modalConfirmSpy = vi.fn(async () => true);
const modalPromptSpy = vi.fn(async () => 'urgent, review');
const modalShowSpy = vi.hoisted(() => vi.fn<typeof import('@/modal').Modal.show>());
const setSessionFolderAssignmentSpy = vi.hoisted(() => vi.fn<typeof import('@/sync/api/session/sessionOrganizationApi').setSessionFolderAssignment>());
const setSessionPinSpy = vi.hoisted(() => vi.fn<typeof import('@/sync/api/session/sessionOrganizationApi').setSessionPin>());
const setSessionTagAssignmentsSpy = vi.hoisted(() => vi.fn<typeof import('@/sync/api/session/sessionOrganizationApi').setSessionTagAssignments>());
vi.mock('@/sync/api/session/sessionOrganizationApi', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/sync/api/session/sessionOrganizationApi')>(),
    setSessionFolderAssignment: setSessionFolderAssignmentSpy,
    setSessionPin: setSessionPinSpy,
    setSessionTagAssignments: setSessionTagAssignmentsSpy,
}));
let hideInactiveSessions = false;
let organizationPinnedSessionKeys: unknown = null;
let organizationTagsBySessionKey: unknown = null;
let organizationFolders: unknown = null;
let acpCatalogSettingsV1: Settings['acpCatalogSettingsV1'] | null = null;
let backendEnabledByTargetKey: Settings['backendEnabledByTargetKey'] | null = null;
let resolvedServerId = 'server-1';
let sessionHandoffFeatureEnabled = false;
let sessionFoldersFeatureEnabled = false;
const folderFeatureScopes = vi.hoisted(() => [] as unknown[]);
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
const mockGetSessionName = vi.hoisted(() => vi.fn(() => 'name'));
const useSessionSpy = vi.fn<(sessionId: string) => any>(() => mockSession);
let mockPluginUiProjection: any = null;
let mockPluginUiPlatform: 'web' | 'desktop' | 'ios' | 'android' = 'web';

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

function buildSessionOrganizationProjectionFromFixtures(serverIdRaw: unknown): SessionOrganizationProjection {
    const serverId = typeof serverIdRaw === 'string' && serverIdRaw.trim()
        ? serverIdRaw.trim()
        : 'server-1';
    const pinnedSessionIds = Array.isArray(organizationPinnedSessionKeys)
        ? organizationPinnedSessionKeys
            .map((key) => stripServerSessionKey(serverId, key))
            .filter((sessionId): sessionId is string => sessionId != null)
        : [];
    const tagIdByLabel = new Map<string, string>();
    const tagsById: Record<string, UiSessionOrganizationTag> = {};
    const tagAssignmentsBySessionId: Record<string, string[]> = {};
    if (isPlainRecord(organizationTagsBySessionKey)) {
        for (const [key, tags] of Object.entries(organizationTagsBySessionKey)) {
            const sessionId = stripServerSessionKey(serverId, key);
            if (!sessionId || !Array.isArray(tags)) continue;
            const tagIds: string[] = [];
            for (const tag of tags) {
                if (typeof tag !== 'string') continue;
                let tagId = tagIdByLabel.get(tag);
                if (!tagId) {
                    tagId = `fixture-tag-${tagIdByLabel.size + 1}`;
                    tagIdByLabel.set(tag, tagId);
                    tagsById[tagId] = {
                        tagId,
                        tagKey: tagId,
                        sortKey: null,
                        display: { t: 'plain', v: { label: tag } },
                        displayState: { status: 'available', value: { label: tag } },
                        archivedAt: null,
                        createdAt: 1,
                        updatedAt: 1,
                    };
                }
                tagIds.push(tagId);
            }
            tagAssignmentsBySessionId[sessionId] = tagIds;
        }
    }
    const folders = isPlainRecord(organizationFolders) && Array.isArray(organizationFolders.folders)
        ? organizationFolders.folders
        : [];
    const folderEntries: Array<[string, UiSessionOrganizationFolder]> = [];
    for (const folder of folders) {
        if (!isPlainRecord(folder)) continue;
        const folderId = typeof folder.id === 'string' ? folder.id.trim() : '';
        if (!folderId) continue;
        const parsedWorkspace = SessionOrganizationContentEnvelopeSchema.safeParse({
            t: 'plain',
            v: folder.workspace,
        });
        const workspace = parsedWorkspace.success && parsedWorkspace.data.t === 'plain'
            ? parsedWorkspace.data.v
            : null;
        folderEntries.push([folderId, {
            folderId,
            folderKey: folderId,
            parentFolderId: typeof folder.parentId === 'string' ? folder.parentId : null,
            parentFolderKey: typeof folder.parentId === 'string' ? folder.parentId : null,
            display: {
                t: 'plain',
                v: {
                    name: typeof folder.name === 'string' ? folder.name : folderId,
                    workspace,
                },
            },
            displayState: {
                status: 'available',
                value: {
                    name: typeof folder.name === 'string'
                        ? folder.name
                        : null,
                    workspace,
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
        attentionStandingsBySessionId: {},
        folderAssignmentsBySessionId: {},
        tagsById,
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
                show: modalShowSpy,
            },
        }).module;
    },
    storageModule: async (importOriginal) =>
        createStorageModuleMock({
            importOriginal,
            overrides: {
                useSession: (sessionId: string) => useSessionSpy(sessionId),
                useProfile: () => mockProfile,
                useIsDataReady: () => isDataReady,
                useAllSessions: () => allSessionsState.current,
                useAllMachines: () => allMachinesState.current,
                useWorkspaceRefs: () => [],
                useWorkspaceSyncRelationships: () => [],
                useMachineListByServerId: () => machineListByServerIdState.current,
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
                    if (key === 'acpCatalogSettingsV1') {
                        return acpCatalogSettingsV1;
                    }
                    if (key === 'backendEnabledByTargetKey') {
                        return backendEnabledByTargetKey;
                    }
                    return null;
                } }),
                useSessionOrganizationProjection: (serverId: string | null | undefined) =>
                    buildSessionOrganizationProjectionFromFixtures(serverId),
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
vi.mock('@/sync/engine/machines/useMachinePoolOriginName', () => ({
    useMachinePoolOriginName: ({ serverId, poolId }: { serverId?: string | null; poolId?: string | null }) => {
        if (!serverId || !poolId) return null;
        return machinePoolListByServerIdState.current[serverId]
            ?.find((entry) => entry.pool.id === poolId)
            ?.pool.name.trim() || null;
    },
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
vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: any) => {
        const trigger = typeof props.trigger === 'function'
            ? props.trigger({
                open: props.open,
                toggle: () => props.onOpenChange(!props.open),
                openMenu: () => props.onOpenChange(true),
                closeMenu: () => props.onOpenChange(false),
                selectedItem: null,
            })
            : props.trigger ?? null;
        const items = props.open
            ? props.items.map((item: any) => React.createElement(
                'DropdownMenuItem',
                {
                    key: item.id,
                    testID: item.testID,
                    accessibilityRole: 'button',
                    accessibilityLabel: item.title,
                    disabled: item.disabled,
                    onPress: () => {
                        if (!item.disabled) props.onSelect(item.id);
                    },
                },
                item.title,
            ))
            : null;
        return React.createElement('DropdownMenu', { open: props.open }, trigger, items);
    },
}));
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
vi.mock('@/components/sessions/plugins/useSessionPluginRuntime', () => ({
    useSessionAddressForSessionId: () => ({ serverId: 'server-1', sessionId: 'session-1' }),
    useSessionPluginRuntime: () => ({
        pluginUiProjection: mockPluginUiProjection,
        pluginBrowserProjection: null,
        phase: 'current',
        interactionEnabled: true,
        machineId: 'machine-1',
        serverId: 'server-1',
        platform: mockPluginUiPlatform,
    }),
}));
vi.mock('@/components/plugins/surfaces', () => ({ PluginInlineSurfaceHost: 'PluginInlineSurfaceHost' }));
vi.mock('@/components/plugins/surfaces/PluginSurfaceHost', () => ({
    PluginInlineSurfaceHost: 'PluginInlineSurfaceHost',
}));
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
    machinePluginSettingsGet: vi.fn(async () => ({ supported: false, reason: 'not-supported' })),
    machinePluginSettingsSet: vi.fn(async () => ({ supported: false, reason: 'not-supported' })),
    machinePluginSecretStatus: vi.fn(async () => ({ supported: false, reason: 'not-supported' })),
    machinePluginSecretSet: vi.fn(async () => ({ supported: false, reason: 'not-supported' })),
    machinePluginSecretDelete: vi.fn(async () => ({ supported: false, reason: 'not-supported' })),
}));
vi.mock('@/agents/catalog/catalog', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/agents/catalog/catalog')>();
    return {
        ...actual,
        DEFAULT_AGENT_ID: 'claude',
        // Only a bundled Agent has catalog presentation. A stub that answers for
        // every id would hand this screen a brand it cannot actually have.
        getAgentCore: (agentId: string) => (actual.isBundledAgentId(agentId)
            ? { availability: { experimental: false }, ...mockAgentCore }
            : null),
        resolveAgentIdFromFlavor: (flavor: string | null | undefined) => mockResolveAgentIdFromFlavor(flavor),
    };
});
vi.mock('@/hooks/server/useAutomationsSupport', () => ({ useAutomationsSupport: () => ({ enabled: false }) }));
vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (featureId: string, scope?: unknown) => {
        if (featureId === 'sessions.handoff') {
            return sessionHandoffFeatureEnabled;
        }
        if (featureId === 'sessions.folders') {
            folderFeatureScopes.push(scope);
            return sessionFoldersFeatureEnabled;
        }
        return false;
    },
}));
vi.mock('@/auth/storage/tokenStorage', async (importOriginal) => {
    const { createTokenStorageModuleMock } = await import('@/dev/testkit/mocks/tokenStorage');
    return createTokenStorageModuleMock({
        importOriginal,
        tokenStorage: {
            getCredentialsForServerUrl: vi.fn(async () => ({ token: 'token' })),
        },
    });
});
vi.mock('@/hooks/server/useSessionExecutionRunsSupported', () => ({
    useSessionExecutionRunsSupported: (sessionId: string, sessionServerId?: string | null) =>
        useSessionExecutionRunsSupportedSpy(sessionId, sessionServerId),
}));
vi.mock('@/sync/ops/actions/defaultActionExecutor', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/ops/actions/defaultActionExecutor')>();
    return {
        ...actual,
        createDefaultActionExecutor: (config: Parameters<typeof actual.createDefaultActionExecutor>[0]) => (
            config && 'machinePoolAction' in config
                ? actual.createDefaultActionExecutor(config)
                : createDefaultActionExecutorSpy(config ?? {})
        ),
    };
});
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId', () => ({
    resolvePreferredServerIdForSessionId: (sessionId: string) => resolveSessionTargetServerIdSpy(sessionId),
}));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/resolveServerIdForSessionIdFromLocalCache', () => ({
    resolveServerIdForSessionIdFromLocalCache: (sessionId: string) => resolveServerIdForSessionIdFromLocalCacheSpy(sessionId),
}));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: (...args: unknown[]) => machineRpcWithServerScopeSpy(...args),
}));
vi.mock('@/sync/domains/features/featureDecisionRuntime', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/sync/domains/features/featureDecisionRuntime')>(),
    useServerFeaturesSnapshotForServerId: () => serverFeaturesSnapshot,
}));
vi.mock('@/sync/domains/settings/actionsSettings', () => ({ isActionEnabledInState: () => true }));
vi.mock('@/sync/domains/sessionFork/forkUiSupport', () => ({ canForkConversation: () => true }));
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
            const runtimeDescriptor = metadata?.runtimeDescriptorV1 as any;
            if (typeof runtimeDescriptor?.agentId === 'string') return runtimeDescriptor.agentId;
            const flavor = typeof metadata?.flavor === 'string' ? metadata.flavor : null;
            return mockResolveAgentIdFromFlavor(flavor) ?? null;
        },
    };
});
vi.mock('@/utils/sessions/sessionUtils', () => ({
    getSessionName: mockGetSessionName,
    resolveLockedSessionTitle: (title: string) => title === 'session.untitled' ? 'session.access.lockedTitleFallback' : title,
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
vi.mock('@/components/ui/layout/layout', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/components/ui/layout/layout')>()),
    layout: { screenPaddingHorizontal: 16 },
}));

describe('/session/[id]/info', () => {
    beforeEach(async () => {
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token: 'token' });
        mockSessionId = 'session-1';
        mockServerId = undefined;
        mockSession = null;
        mockProfile = { ...profileDefaults };
        isDataReady = true;
        routeHydrationState = { kind: 'available', sessionId: 'session-1' };
        sessionIsConnected = true;
        localDevModeEnabled = false;
        mockPluginUiProjection = null;
        mockPluginUiPlatform = 'web';
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
        modalShowSpy.mockReset();
        modalShowSpy.mockReturnValue('modal-id');
        setSessionFolderAssignmentSpy.mockClear();
        setSessionFolderAssignmentSpy.mockImplementation(async ({ sessionId, request }) => ({ sessionId, folderId: request.folderId }));
        setSessionPinSpy.mockClear();
        setSessionPinSpy.mockImplementation(async ({ sessionId, request }) => ({ sessionId, pin: request.pinned ? { sessionId, sortKey: null, pinnedAt: 1 } : null }));
        setSessionTagAssignmentsSpy.mockClear();
        setSessionTagAssignmentsSpy.mockImplementation(async ({ sessionId, request }) => ({ sessionId, tagIds: request.tagIds }));
        resolveSessionTargetServerIdSpy.mockClear();
        resolveServerIdForSessionIdFromLocalCacheSpy.mockClear();
        machineRpcWithServerScopeSpy.mockClear();
        useSessionExecutionRunsSupportedSpy.mockClear();
        resolveSessionTargetServerIdSpy.mockImplementation(() => resolvedServerId);
        resolveServerIdForSessionIdFromLocalCacheSpy.mockImplementation(() => null);
        machineRpcWithServerScopeSpy.mockRejectedValue(new Error('unreachable'));
        hideInactiveSessions = false;
        organizationPinnedSessionKeys = null;
        organizationTagsBySessionKey = null;
        organizationFolders = null;
        acpCatalogSettingsV1 = null;
        backendEnabledByTargetKey = null;
        resolvedServerId = 'server-1';
        sessionHandoffFeatureEnabled = false;
        sessionFoldersFeatureEnabled = false;
        folderFeatureScopes.length = 0;
        allSessionsState.current = [];
        allMachinesState.current = [];
        machineListByServerIdState.current = {};
        machinePoolListByServerIdState.current = {};
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
        mockGetSessionName.mockReset();
        mockGetSessionName.mockReturnValue('name');
        vi.clearAllMocks();
        useHappyActionMock.mockReset();
        useHappyActionMock.mockImplementation((fn: any) => [false, fn] as const);
        useSessionExecutionRunsSupportedSpy.mockReturnValue(false);
        machineContributionRegistryProjectionDescribeMock.mockReset();
        machineContributionRegistryProjectionDescribeMock.mockResolvedValue({ supported: false, reason: 'not-supported' });
        clearTempData();
        // Seed device persistence at the existing MMKV boundary; profile resolution stays real.
        new MMKV().set('server-state-v1', JSON.stringify({
            activeServerId: 'server-1',
            servers: Object.fromEntries([
                ['server-1', 'https://server.example.test'],
                ['server-b', 'https://server-b.example.test'],
                ['server-session-info', 'https://session-info.example.test'],
            ].map(([id, serverUrl]) => [id, {
                id, serverUrl, name: id, createdAt: 1, updatedAt: 1, lastUsedAt: 1,
            }])),
        }));
        const { setActiveServerId } = await import('@/sync/domains/server/serverProfiles');
        await setActiveServerId('server-1');
    });

    afterEach(async () => {
        // Retire pending custom-modal choices even when an assertion fails.
        // This settles the handler's async act before the next renderer mounts.
        try {
            await act(async () => {
                for (const [config] of modalShowSpy.mock.calls) config.onRequestClose?.();
            });
        } finally {
            clearTempData();
            standardCleanup();
            resetRuntimeFetch();
            resetServerFeaturesClientForTests();
            vi.unstubAllGlobals();
        }
    });

    async function applyInfoSessionFixture() {
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        const sessionFixture = mockSession ? { encryptionMode: 'plain', ...mockSession } : null;
        const serverScopedSession = sessionFixture && mockServerId && !sessionFixture.serverId
            ? { ...sessionFixture, serverId: mockServerId } : sessionFixture;
        const session = serverScopedSession && !serverScopedSession.access
            ? { ...serverScopedSession, access: createSessionAccessFixture(serverScopedSession.accessLevel ?? 'owner') }
            : serverScopedSession;
        getStorage().setState({ sessions: session ? { [normalizeSessionId(mockSessionId)]: session } : {} });
    }

    async function renderInfoScreen() {
        await applyInfoSessionFixture();
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

    it('uses the encrypted title and hides private detail/actions for a locked recipient', async () => {
        mockGetSessionName.mockReturnValue('session.untitled');
        mockSession = {
            id: 'session-locked-recipient',
            serverId: 'server-1',
            active: false,
            accessLevel: 'view',
            access: createSessionAccessFixture('view'),
            encryptionMode: 'e2ee',
            encryptedContentAvailability: 'encrypted_access_pending',
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 1,
            metadata: {
                name: 'private name',
                host: 'private machine',
                path: '/private/workspace',
            },
        };

        const screen = await renderInfoScreen();

        expect(screen.findHostByTestId('session-info-header')).not.toBeNull();
        expect(screen.getTextContent()).toContain('session.access.lockedTitleFallback');
        expect(screen.findByTestId('session-info-menu')).toBeNull();
        expect(screen.getTextContent()).not.toContain('private machine');
        expect(screen.getTextContent()).not.toContain('/private/workspace');
        expect(screen.findByTestId('session-info-new-session-same-setup')).toBeNull();
        expect(screen.findByTestId('session-info-collaboration')).toBeNull();
    });

    it('shows the current exact Machine and an independently readable creation pool after handoff', async () => {
        const token = `header.${Buffer.from(JSON.stringify({ sub: 'viewer-account' })).toString('base64')}.signature`;
        vi.mocked(TokenStorage.getCredentialsForServerUrl).mockResolvedValue({ token });
        const features = buildServerFeaturesResponse();
        vi.stubGlobal('fetch', vi.fn(async () => Response.json({
            ...features,
            features: {
                ...features.features,
                machines: { ...features.features.machines, pools: { enabled: true } },
            },
        })));
        await getServerFeaturesSnapshot({ serverId: 'server-1', force: true });
        const poolId = '0191f11b-4ab2-7ef2-8dd2-268abc9c191f';
        mockSession = {
            id: 'session-1',
            serverId: 'server-1',
            active: true,
            accessLevel: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 1,
            metadata: {
                machineId: 'machine-before-handoff',
                placementOrigin: { kind: 'machine_pool', poolId },
            },
        };
        readMachineTargetForSessionSpy.mockReturnValue({
            machineId: 'machine-after-handoff',
            basePath: '/workspace',
        });
        machineListByServerIdState.current = {
            'server-1': [{
                id: 'machine-after-handoff',
                metadata: { displayName: 'Mac Studio' },
            }],
            'server-2': [{
                id: 'machine-after-handoff',
                metadata: { displayName: 'Wrong Home machine' },
            }],
        };
        machinePoolListByServerIdState.current = {
            'server-1': [{
                pool: { id: poolId, name: 'Development', description: null, revision: 1, createdAt: 1, updatedAt: 1, members: [] },
                availability: { state: 'unknown' },
            }],
        };
        setRuntimeFetch(async (url) => String(url).endsWith('/v1/account/encryption')
            ? Response.json({ mode: 'plain', updatedAt: 1 })
            : Response.json({ pools: machinePoolListByServerIdState.current['server-1'] }));

        const screen = await renderInfoScreen();

        expect(screen.findByTestId('session-info-execution-machine')?.props).toMatchObject({
            subtitle: 'Mac Studio',
        });
        await vi.waitFor(() => expect(screen.findByTestId('session-info-placement-origin')?.props).toMatchObject({
            subtitle: 'Development',
        }));
    });

    it('does not disclose a stale or unreadable pool name from Session metadata', async () => {
        mockSession = {
            id: 'session-1',
            serverId: 'server-1',
            active: false,
            accessLevel: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 1,
            metadata: {
                machineId: 'machine-1',
                placementOrigin: {
                    kind: 'machine_pool',
                    poolId: '0191f11b-4ab2-7ef2-8dd2-268abc9c191f',
                },
            },
        };
        readMachineTargetForSessionSpy.mockReturnValue({ machineId: 'machine-1', basePath: '/workspace' });
        machinePoolListByServerIdState.current = { 'server-1': [] };

        const screen = await renderInfoScreen();

        expect(screen.findByTestId('session-info-placement-origin')?.props).toMatchObject({
            subtitle: 'machinePools.aMachinePool',
        });
    });

    it('mounts projected Session-info sections through the shared semantic inline host', async () => {
        mockSession = {
            id: 'session-1',
            active: false,
            accessLevel: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 1,
            metadata: {},
        };
        const placement = { id: 'session-info-placement' };
        mockPluginUiProjection = {
            sessionInfoSectionsById: {
                'sessionInfoSection:acme.preview:overview': {
                    id: 'sessionInfoSection:acme.preview:overview',
                    order: 10,
                    placement,
                },
            },
        };

        const screen = await renderInfoScreen();
        const mounts = screen.findAllByType('PluginInlineSurfaceHost' as never);
        expect(mounts).toHaveLength(1);
        expect(mounts[0]?.props).toMatchObject({
            placement,
            inlineMount: { role: 'sessionInfoSection', presentation: 'content' },
            sessionId: 'session-1',
            machineId: 'machine-1',
            serverId: 'server-1',
            projectionInteractionEnabled: true,
        });
    });

    it('projects declared session-info section availability through the canonical policy owner', async () => {
        mockSession = {
            id: 'session-1',
            active: false,
            accessLevel: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 1,
            metadata: {},
        };
        const placement = { id: 'session-info-placement' };
        const sectionBase = {
            pluginId: 'acme.preview',
            descriptorId: 'overview',
            order: 10,
            placement,
            renderer: { kind: 'declarative' },
            resource: { pluginId: 'acme.preview', localId: 'overview' },
            actions: [],
        };
        const hiddenPlacement = { id: 'session-info-placement-hidden' };
        const disabledPlacement = { id: 'session-info-placement-disabled' };
        const enabledPlacement = { id: 'session-info-placement-enabled' };
        mockPluginUiProjection = {
            sessionInfoSectionsById: {
                'sessionInfoSection:acme.preview:hidden': {
                    ...sectionBase,
                    id: 'sessionInfoSection:acme.preview:hidden',
                    placement: hiddenPlacement,
                    availability: {
                        when: { fact: 'host.platform', operator: 'equals', value: 'ios' },
                    },
                },
                'sessionInfoSection:acme.preview:disabled': {
                    ...sectionBase,
                    id: 'sessionInfoSection:acme.preview:disabled',
                    order: 20,
                    placement: disabledPlacement,
                    availability: {
                        disabledWhen: { fact: 'host.platform', operator: 'equals', value: 'web' },
                        disabledReason: 'Disabled on web',
                    },
                },
                'sessionInfoSection:acme.preview:enabled': {
                    ...sectionBase,
                    id: 'sessionInfoSection:acme.preview:enabled',
                    order: 30,
                    placement: enabledPlacement,
                    availability: {
                        when: { fact: 'session.exists', operator: 'equals', value: true },
                    },
                },
            },
        };

        const screen = await renderInfoScreen();
        const mounts = screen.findAllByType('PluginInlineSurfaceHost' as never);
        expect(mounts).toHaveLength(2);
        const byPlacementId = new Map(mounts.map((mount) => [
            String(mount.props.placement.id),
            mount.props,
        ] as const));
        expect(byPlacementId.has('session-info-placement-hidden')).toBe(false);
        expect(byPlacementId.get('session-info-placement-disabled')).toMatchObject({
            inlineMount: { role: 'sessionInfoSection' },
            projectionInteractionEnabled: false,
        });
        expect(byPlacementId.get('session-info-placement-enabled')).toMatchObject({
            inlineMount: { role: 'sessionInfoSection' },
            projectionInteractionEnabled: true,
        });
        const mountedPolicyContext = byPlacementId.get('session-info-placement-enabled')?.policyContext;
        expect(evaluatePluginUiPolicy({
            availability: {
                when: { fact: 'session.exists', operator: 'equals', value: true },
            },
        }, mountedPolicyContext ?? {})).toMatchObject({
            visible: true,
            enabled: true,
        });
    });

    it('uses the mounted plugin runtime platform for Session-info policy facts', async () => {
        mockSession = {
            id: 'session-1',
            active: false,
            accessLevel: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 1,
            metadata: {},
        };
        mockPluginUiPlatform = 'desktop';
        mockPluginUiProjection = {
            sessionInfoSectionsById: {
                'sessionInfoSection:acme.preview:desktop': {
                    id: 'sessionInfoSection:acme.preview:desktop',
                    pluginId: 'acme.preview',
                    descriptorId: 'desktop',
                    order: 10,
                    placement: { id: 'session-info-placement-desktop' },
                    renderer: { kind: 'declarative' },
                    resource: { pluginId: 'acme.preview', localId: 'desktop' },
                    actions: [],
                    availability: {
                        when: { fact: 'host.platform', operator: 'equals', value: 'desktop' },
                    },
                },
            },
        };

        const screen = await renderInfoScreen();
        const mount = screen.findAllByType('PluginInlineSurfaceHost' as never)[0];
        expect(mount?.props).toMatchObject({
            placement: { id: 'session-info-placement-desktop' },
            platform: 'desktop',
            policyContext: { platform: 'desktop' },
        });
    });

    it('normalizes the route id before looking up the session', async () => {
        mockSessionId = ['session-2 '] as any;
        mockSession = {
            id: 'session-2',
            active: false,
            accessLevel: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 1,
            metadata: {},
        };
        const screen = await renderInfoScreen();
        expect(screen.getTextContent()).toContain('name');
        expect(screen.getTextContent()).not.toContain('errors.sessionDeleted');
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
        mockServerId = 'server-session-info';
        vi.mocked(TokenStorage.getCredentialsForServerUrl).mockResolvedValue({ token: createAccountTokenForTests('viewer-account') });
        // V2 projects Agent titles, not the retired backend registry. An installed
        // Agent exercises the daemon title without replacing a bundled Agent's brand.
        const agentIdentity = { pluginId: 'acme.review', localId: 'claude' };
        const agentId = buildQualifiedPluginContributionKey(agentIdentity);
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
                runtimeDescriptorV1: { v: 1, agentId, provider: {} },
                sessionCreationCorrespondenceV1: SessionCreationCorrespondenceV1Schema.parse({
                    v: 1,
                    sessionCreationTag: deriveSessionCreationTagV1({ callerCreationNamespace: 'info-test', creationKey: 'projected-agent' }),
                    recipe: {
                        execution: { machineId: 'machine-projection-1', directory: { kind: 'path', path: '/tmp/session' } },
                        organization: { folderId: null, tagIds: [] },
                        agentTarget: { kind: 'agent', identity: agentIdentity },
                        modelSelection: null,
                        profileId: null,
                        requestedPermissionMode: null,
                        agentModeId: null,
                        configuration: null,
                        connectedServices: null,
                        mcpSelection: null,
                        transcriptStorage: null,
                        terminal: null,
                        agentSessionStartupInstructionsMarkerV1: null,
                        checkout: null,
                    },
                }),
                host: 'host-a',
                path: '/tmp/session',
                homeDir: '/home/me',
            },
        };

        machineContributionRegistryProjectionDescribeMock.mockResolvedValue({
            supported: true,
            projection: PluginProjectionV2Schema.parse({
                v: 2,
                generation: 1,
                agentsById: {
                    [agentId]: {
                        id: agentId,
                        identity: agentIdentity,
                        title: 'Claude (daemon)',
                        channel: 'plugin',
                        isBuiltIn: false,
                        catalogAgentId: 'claude',
                        iconAgentId: 'claude',
                    },
                },
            }),
        });

        const screen = await renderInfoScreen();
        await flushHookEffects({ cycles: 10 });
        expect(machineContributionRegistryProjectionDescribeMock).toHaveBeenCalledWith('machine-projection-1', expect.objectContaining({ serverId: 'server-session-info' }));

        const aiProviderItems = screen
            .findAllByType('Item' as any)
            .filter((node: any) => node.props?.title === 'sessionInfo.aiProvider');
        expect(aiProviderItems).toHaveLength(1);
        expect(aiProviderItems[0]?.props?.subtitle).toBe('Claude (daemon)');
    });

    it('shows no substituted Agent brand for a session whose Agent is unreadable', async () => {
        // Nothing in this session names its Agent, so the screen has no brand to
        // show. Presenting the product default would tell the user the session
        // belongs to Claude.
        mockResolveAgentIdFromFlavor.mockReturnValue(undefined);
        mockSession = {
            id: 'session-unknown-agent',
            serverId: 'server-session-info',
            active: false,
            accessLevel: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 1,
            metadata: {
                machineId: 'machine-projection-1',
                host: 'host-a',
                path: '/tmp/session',
                homeDir: '/home/me',
            },
        };

        const screen = await renderInfoScreen();
        await flushHookEffects({ cycles: 10 });

        const avatars = screen.root.findAllByProps({ testID: 'session-info-avatar' });
        expect(avatars.length).toBeGreaterThan(0);
        for (const avatar of avatars) {
            expect(avatar.props.flavor ?? null).toBeNull();
        }

        const aiProviderItems = screen
            .findAllByType('Item' as any)
            .filter((node: any) => node.props?.title === 'sessionInfo.aiProvider');
        expect(aiProviderItems).toHaveLength(1);
        expect(aiProviderItems[0]?.props?.subtitle).not.toBe('agentInput.agent.claude');
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
        await act(async () => { await applyInfoSessionFixture(); });
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
            { serverId: 'server-1' },
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
        organizationPinnedSessionKeys = [];
        organizationTagsBySessionKey = { 'server-b:session-1': ['existing'] };
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

        await withPopoverWebGlobals(async () => {
            const screen = await renderInfoScreen();

        await screen.pressByTestIdAsync('session-info-session-pin');
        expect(setSessionPinSpy).toHaveBeenCalledWith(expect.objectContaining({
            credentials: { token: 'token' },
            serverUrl: 'https://server-b.example.test',
            sessionId: 'session-1',
            request: expect.objectContaining({ pinned: true }),
        }));

        await screen.pressByTestIdAsync('session-info-session-tags-edit');
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
        await screen.pressByTestIdAsync('session-tags-menu-item:fixture-tag-1');
        expect(setSessionTagAssignmentsSpy).toHaveBeenCalledWith(expect.objectContaining({
            credentials: { token: 'token' },
            serverUrl: 'https://server-b.example.test',
            sessionId: 'session-1',
            request: { tagIds: [] },
        }));
        });
    });

    it('surfaces the existing info-screen error when organization mutation scope is unavailable', async () => {
        mockServerId = 'server-b';
        organizationPinnedSessionKeys = [];
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
        vi.mocked(TokenStorage.getCredentialsForServerUrl).mockResolvedValue(null);

        const screen = await renderInfoScreen();

        await expect(
            screen.pressByTestIdAsync('session-info-session-pin'),
        ).rejects.toThrow('server-b');
        expect(setSessionPinSpy).not.toHaveBeenCalled();
    });

    it.each(['select', 'cancel'] as const)('surfaces move-to-folder from the session view when folder targets match the session workspace (%s)', async (choice) => {
        await loadSyncSingletonForTests();
        const credentials = { token: createAccountTokenForTests('viewer-account') };
        const account = await restoreServerAccountForTest({
            serverUrl: 'https://server.example.test',
            credentials,
            request: async (url) => {
                const path = new URL(String(url)).pathname;
                if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
                if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
                if (path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
                if (path === '/v1/account/profile') return Response.json({ ...profileDefaults, id: 'viewer-account' });
                if (path === AUTHORING_MEMORY_ROUTE_V1) return Response.json({ rows: [] });
                if (path === '/v1/artifacts') return Response.json([]);
                return Response.json({});
            },
        });
        try {
            mockServerId = 'server-1';
            sessionFoldersFeatureEnabled = true;
            organizationFolders = {
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
            modalShowSpy.mockImplementation((config) => {
                const props = config.props as Readonly<{
                    sourceLabel: string;
                    targets: readonly import('@/sync/domains/session/folders').SessionFolderMoveTarget[];
                    onSelect: (target: import('@/sync/domains/session/folders').SessionFolderMoveTarget) => void;
                }>;
                expect(props.sourceLabel).toBe('name');
                const target = props.targets.find((candidate) => candidate.folderId === 'folder-1');
                expect(target).toMatchObject({ id: 'session-info-move-folder:folder-1', title: 'Planning', disabled: false });
                if (!target) throw new Error('Matching folder target is missing');
                queueMicrotask(() => {
                    if (choice === 'select') props.onSelect(target);
                    else config.onRequestClose?.();
                });
                return 'modal-id';
            });

            const { getStorage } = await import('@/sync/domains/state/storageStore');
            getStorage().getState().applySessionFolderAssignments('server-1', [{ sessionId: 'session-1', folderId: 'folder-existing' }]);
            const screen = await renderInfoScreen();
            try {
                expect(folderFeatureScopes).toContainEqual({ scopeKind: 'spawn', serverId: 'server-1' });
                await screen.pressByTestIdAsync('session-info-session-move-to-folder');

                const assignment = getStorage().getState().sessionOrganizationFolderAssignmentsBySessionKey[
                    sessionAddressKey({ serverId: 'server-1', sessionId: 'session-1' })
                ];
                if (choice === 'select') {
                    expect(setSessionFolderAssignmentSpy).toHaveBeenCalledWith(expect.objectContaining({
                        credentials,
                        serverUrl: 'https://server.example.test',
                        sessionId: 'session-1',
                        request: { folderId: 'folder-1' },
                    }));
                    expect(assignment).toEqual({ sessionId: 'session-1', folderId: 'folder-1' });
                    expect(TokenStorage.getCredentialsForServerUrl).toHaveBeenCalledWith('https://server.example.test', { serverId: 'server-1' });
                } else {
                    expect(setSessionFolderAssignmentSpy).not.toHaveBeenCalled();
                    expect(assignment).toEqual({ sessionId: 'session-1', folderId: 'folder-existing' });
                }
                expect(getStorage().getState().sessionOrganizationOptimisticRecords).toEqual({});
            } finally {
                await screen.unmount();
            }
        } finally {
            await account.dispose();
        }
    });

    it('shows the handoff quick action when server-routed transfer is the only transport the selected server advertises', async () => {
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

    it('shows the provider resume surfaces from the current runtime and native resume identities', async () => {
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
                runtimeDescriptorV1: {
                    v: 1,
                    agentId: 'opencode',
                    agent: { backendMode: 'server' },
                },
                nativeResumeIdentityV1: { v: 1, vendorResumeId: 'runtime-session-1234567890' },
            },
        };

        const screen = await renderInfoScreen();
        expect(screen.findByTestId('sessionInfo.openCodeSessionId')).toBeTruthy();
        expect(screen.findByTestId('sessionInfo.copyResumeCommand')).toBeTruthy();
    });

    it('infers the provider from the current runtime descriptor when flavor is missing', async () => {
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
                runtimeDescriptorV1: {
                    v: 1,
                    agentId: 'opencode',
                    agent: { backendMode: 'server' },
                },
                nativeResumeIdentityV1: { v: 1, vendorResumeId: 'runtime-session-1234567890' },
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
                runtimeDescriptorV1: {
                    v: 1,
                    agentId: 'codex',
                    agent: { backendMode: 'appServer' },
                },
                placementOrigin: {
                    kind: 'machine_pool',
                    poolId: '0191f11b-4ab2-7ef2-8dd2-268abc9c191f',
                },
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
                draftId: expect.any(String),
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
            backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
            selectedProfileId: 'profile-1',
            transcriptStorage: 'direct',
            permissionMode: 'safe-yolo',
            modelSelection: {
                v: 1,
                ref: {
                    agentTargetKey: 'agent:happier.agent.codex/codex',
                    modelId: 'gpt-5',
                    providerConnectionId: null,
                },
                updatedAt: 102,
            },
            runtimeDescriptorV1: {
                v: 1,
                agentId: 'codex',
                agent: { backendMode: 'appServer' },
            },
            acpSessionModeId: 'plan',
        }));
        expect(tempData).not.toHaveProperty('placementOrigin');
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
                    agent: { backendMode: 'appServer' },
                },
                nativeResumeIdentityV1: { v: 1, vendorResumeId: 'codex-session-1' },
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
        organizationPinnedSessionKeys = [];
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
        organizationPinnedSessionKeys = [];
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

    it('uses the explicit route Home for actions instead of a bare same-id cache', async () => {
        mockServerId = 'server-b';
        hideInactiveSessions = true;
        organizationPinnedSessionKeys = [];
        resolvedServerId = 'server-preferred';
        resolveServerIdForSessionIdFromLocalCacheSpy.mockReturnValue('server-a');
        mockSession = {
            id: 'session-1',
            serverId: 'server-b',
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
        expect(resolveServerIdForSessionIdFromLocalCacheSpy).not.toHaveBeenCalled();
    });

    it('does not render a cached same-id Session from another Home while the explicit route is pending', async () => {
        mockServerId = 'server-b';
        routeHydrationState = {
            kind: 'loading',
            sessionId: 'session-1',
            serverId: 'server-b',
            reason: 'store-miss',
        };
        mockSession = {
            id: 'session-1',
            serverId: 'server-a',
            active: true,
            accessLevel: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 1,
            metadata: {},
        };

        const screen = await renderInfoScreen();

        expect(screen.getTextContent()).toContain('common.loading');
        expect(screen.findByTestId('sessionInfo.stopSession')).toBeNull();
    });

    it('does not render a cached same-id Session from another Home when the explicit route is missing', async () => {
        mockServerId = 'server-b';
        routeHydrationState = {
            kind: 'missing',
            sessionId: 'session-1',
            serverId: 'server-b',
            cause: 'not_found',
        };
        mockSession = {
            id: 'session-1',
            serverId: 'server-a',
            active: true,
            accessLevel: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 1,
            metadata: {},
        };

        const screen = await renderInfoScreen();

        expect(screen.getTextContent()).toContain('errors.sessionDeleted');
        expect(screen.findByTestId('sessionInfo.stopSession')).toBeNull();
    });

    it('stops without prompting to archive when the session is pinned', async () => {
        mockServerId = 'server-b';
        hideInactiveSessions = true;
        organizationPinnedSessionKeys = ['server-b:session-1'];
        resolvedServerId = 'server-b';
        mockSession = {
            id: 'session-1',
            serverId: 'server-b',
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

    it('shows loading on the stop and archive buttons while their mutations are running', async () => {
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

        // The leave actions are buttons; the pressable host under each carries only the busy state.
        const control = (testID: string) => screen.root.findAllByProps({ testID })
            .find((node: any) => 'loading' in (node.props ?? {}));
        expect(control('sessionInfo.stopSession')?.props.loading).toBe(true);
        expect(control('sessionInfo.archiveSession')?.props.loading).toBe(true);
    });

    it('offers rename from the page header menu to a session owner', async () => {
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
        await screen.pressByTestIdAsync('session-info-menu.trigger');
        await screen.pressByTestIdAsync('session-info-rename');

        expect(modalPromptSpy).toHaveBeenCalledWith(
            'sessionInfo.renameSession',
            'sessionInfo.renameSessionSubtitle',
            expect.objectContaining({ confirmText: 'common.save' }),
        );
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
        // Rename lives in the page header's ⋯ menu for those who may rename.
        expect(screen.findByTestId('session-info-menu.trigger')).toBeNull();
    });

    it('routes a session owner to remote permission grant management with the current server scope', async () => {
        mockServerId = 'server-owner';
        mockProfile = { ...profileDefaults, id: 'current-account' };
        mockSession = {
            id: 'session-1',
            owner: 'current-account',
            active: false,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 1,
            metadata: {},
            archivedAt: null,
        };

        const screen = await renderInfoScreen();

        expect(screen.findByTestId('session-info-remote-permission-grants')).toBeTruthy();
        await act(async () => {
            screen.pressByTestId('session-info-remote-permission-grants');
        });
        expect(routerPushSpy).toHaveBeenCalledWith('/session/session-1/permissions?serverId=server-owner');
    });

    it('does not expose remote permission grant management to a shared admin approver', async () => {
        mockServerId = 'server-shared';
        mockProfile = { ...profileDefaults, id: 'current-account' };
        mockSession = {
            id: 'session-1',
            owner: 'other-account',
            accessLevel: 'admin',
            canApprovePermissions: true,
            active: false,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 1,
            metadata: {},
            archivedAt: null,
        };

        const screen = await renderInfoScreen();

        expect(screen.findByTestId('session-info-remote-permission-grants')).toBeNull();
    });
});
