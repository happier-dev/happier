import * as React from 'react';
import { createReactNavigationNativeMock } from '@/dev/testkit/mocks/reactNavigation';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    type PluginProjectedComposerAttachmentEntryV1,
} from '@happier-dev/protocol';

import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { findTestInstanceByTypeWithProps } from '@/dev/testkit/render/renderScreen';
import type { createModalModuleMock } from '@/dev/testkit/mocks/modal';
import type { ResumeSessionResult } from '@/sync/ops/sessions';
import type { LocalSettings } from '@/sync/domains/settings/localSettings';
import type { Settings } from '@/sync/domains/settings/settings';
import type { Project } from '@/sync/runtime/orchestration/projectManager';
import type { PendingMessage } from '@/sync/domains/state/storageTypes';
import type { StorageState } from '@/sync/store/types';
import {
    clearSessionDraftValuesForSession,
    readSessionDraftValue,
    writeSessionDraftValue,
} from '@/dev/testkit/sessionDraftRepositoryTestkit';
import { emitSessionResumeRequest } from '@/components/sessions/model/sessionResumeRequests';
import { createSessionAccessFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { activateSessionShellStorageBoundary, installSessionShellCommonModuleMocks } from './sessionShellTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const previousDev = (globalThis as { __DEV__?: boolean }).__DEV__;
const TEST_SCOPE = { serverId: 'server-cache', accountId: 'legacy-test' };
const enqueuePendingMessageSpy = vi.hoisted(() => vi.fn(async (
    ..._args: any[]
): Promise<void | { localId: string; accepted: boolean }> => undefined));
const submitMessageSpy = vi.hoisted(() => vi.fn(async (..._args: any[]) => {}));
const sendMessageSpy = vi.hoisted(() => vi.fn(async (..._args: any[]) => {}));
const sendPendingMessageNowSpy = vi.hoisted(() => vi.fn(async (..._args: any[]) => {}));
const updatePendingRequestedActionSpy = vi.hoisted(() => vi.fn(async (..._args: any[]) => {}));
const resumeSessionSpy = vi.hoisted(() =>
    vi.fn<(..._args: any[]) => Promise<ResumeSessionResult>>(async (..._args: any[]) => ({
        type: 'error' as const,
        errorCode: 'DAEMON_RPC_UNAVAILABLE' as const,
        errorMessage: 'Daemon RPC is not available',
    })),
);
const routerPushSpy = vi.hoisted(() => vi.fn());
const sessionSwitchSpy = vi.hoisted(() => vi.fn(async () => true));
const canResumeSessionWithOptionsSpy = vi.hoisted(() =>
    vi.fn((_metadata: unknown, options: { machineId?: string | null } | null | undefined) => options?.machineId === 'm-target'),
);
const resumeCapabilityMachineIds = vi.hoisted(() => [] as string[]);
const resumeCapabilityServerIds = vi.hoisted(() => [] as string[]);
const ensureAgentInstallablesBackgroundSpy = vi.hoisted(
    () => vi.fn<(params: unknown) => Promise<void>>(async () => {}),
);
const modalMockState = vi.hoisted(() => ({
    current: null as ReturnType<typeof createModalModuleMock> | null,
}));
const settingsState = vi.hoisted(() => ({
    current: { experiments: true, featureToggles: {}, codexBackendMode: 'acp' } as Record<string, unknown>,
}));
const sessionMetadataOverrides = vi.hoisted(() => ({
    current: {} as Record<string, unknown>,
}));
const sessionStateOverrides = vi.hoisted(() => ({
    current: {} as Record<string, unknown>,
}));
const pendingMessagesState = vi.hoisted(() => ({
    current: { messages: [], discarded: [], isLoaded: true } as {
        messages: PendingMessage[];
        discarded: [];
        isLoaded: boolean;
    },
    listeners: new Set<() => void>(),
}));
const machineEncryptionAvailable = vi.hoisted(() => ({
    current: false,
}));
const inactiveSessionUiState = vi.hoisted(() => ({
    current: { noticeKind: 'none', inactiveStatusTextKey: null, shouldShowInput: true } as {
        noticeKind: 'none' | 'not-resumable' | 'machine-offline';
        inactiveStatusTextKey: 'session.inactiveResumable' | 'session.inactiveMachineOffline' | 'session.inactiveNotResumable' | null;
        shouldShowInput: boolean;
    },
}));
const sessionOptimisticThinkingAt = vi.hoisted(() => ({
    current: null as number | null,
}));
const sessionResumingAt = vi.hoisted(() => ({
    current: null as number | null,
}));
const sessionMachineReachability = vi.hoisted(() => ({
    current: {
        machineReachable: true,
        machineOnline: true,
        machineRpcTargetAvailable: true,
        machineReachability: 'reachable' as 'reachable' | 'unreachable' | 'unknown',
    },
}));
const storageStoreRef = vi.hoisted(() => ({
    current: null as any,
}));
const sessionFixtureRef = vi.hoisted(() => ({
    current: null as any,
}));
const inputComposerPersistenceSpies = vi.hoisted(() => ({
    clearTransientInputState: vi.fn(),
    captureTransientInputState: vi.fn(() => ({ v: 1, expanded: true, scrollY: 12, updatedAt: 1 })),
    restoreTransientInputState: vi.fn(),
    setExpanded: vi.fn(),
    onScrollYChange: vi.fn(),
    onSelectionChangePersist: vi.fn(),
    onStructuredInputMentionsChange: vi.fn(),
}));
const inputComposerExpandedState = vi.hoisted(() => ({
    current: false,
}));
const daemonMergedProjectionState = vi.hoisted(() => ({
    current: { phase: 'idle', inputs: null } as unknown,
    listeners: new Set<() => void>(),
}));
const resolveSessionComposerSendMock = vi.hoisted(() =>
    vi.fn((...args: any[]) => {
        const first = args[0] as { input?: unknown } | undefined;
        return { kind: 'send' as const, text: String(first?.input ?? '') };
    }),
);
const themeColors = vi.hoisted(() => ({
    text: '#000',
    textSecondary: '#666',
    textLink: '#00f',
    surface: '#fff',
    surfaceHigh: '#f5f5f5',
    divider: '#ddd',
    border: '#ddd',
    indigo: '#5856D6',
    accent: {
        blue: '#007AFF',
        green: '#34C759',
        orange: '#FF9500',
        yellow: '#FFCC00',
        red: '#FF3B30',
        indigo: '#5856D6',
        purple: '#AF52DE',
    },
    modal: { border: '#ddd' },
    input: { background: '#f5f5f5' },
    header: { tint: '#000' },
    status: { error: '#f00' },
    radio: { active: '#007AFF' },
    shadow: { color: '#000', opacity: 0.2 },
    box: {
        warning: {
            background: '#fffbe6',
            border: '#ffe58f',
            text: '#8c6d1f',
        },
    },
    groupped: { background: '#F5F5F5', chevron: '#C7C7CC', sectionTitle: '#8E8E93' },
}));

let authCredentials: any = { token: 't', secret: 's' };
const pendingFireAndForget: Promise<unknown>[] = [];
const pendingFireAndForgetTags: Array<string | undefined> = [];

const issueAttachmentCatalogEntry = {
    id: 'acme.issues/issue',
    pluginId: 'acme.issues',
    identity: { pluginId: 'acme.issues', localId: 'issue' },
    occurrenceId: 'issues-generation-1',
    definition: {
        id: 'issue',
        title: 'Issue',
        icon: 'file',
        cardinality: 'many',
        valueSchema: {
            type: 'object',
            required: ['issueId'],
            properties: { issueId: { type: 'integer' } },
            additionalProperties: false,
        },
    },
} satisfies PluginProjectedComposerAttachmentEntryV1;

function setComposerAttachmentProjection(
    entriesById: Readonly<Record<string, PluginProjectedComposerAttachmentEntryV1>>,
    generation = 1,
) {
    daemonMergedProjectionState.current = {
        phase: 'ready',
        inputs: {
            pluginProjectionById: {},
            pluginProjectionV2: {
                v: 2,
                generation,
                agentsById: {},
                installedPackagesById: {},
                familiesById: {
                    composerAttachments: {
                        family: 'composerAttachments',
                        entriesById,
                    },
                },
            },
        },
    };
    for (const listener of daemonMergedProjectionState.listeners) {
        listener();
    }
}

vi.mock('expo-linear-gradient', () => ({
    LinearGradient: 'LinearGradient',
}));
vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));
vi.mock('react-native-safe-area-context', () => ({
    initialWindowMetrics: null,
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('@react-navigation/native', () => ({
    ...createReactNavigationNativeMock(),
    useFocusEffect: () => {},
    useIsFocused: () => true,
}));
vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ credentials: authCredentials }),
}));

installSessionShellCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: 'View',
            Text: 'Text',
            Pressable: 'Pressable',
            ActivityIndicator: 'ActivityIndicator',
            Easing: {
                bezier: vi.fn(() => ({})),
                linear: {},
            },
            Animated: {
                View: 'Animated.View',
                Value: class {
                    private _value: number;

                    constructor(value: number) {
                        this._value = value;
                    }

                    interpolate() {
                        return this;
                    }
                },
                timing: () => ({
                    start: (callback?: any) => callback?.({ finished: true }),
                }),
            },
            AccessibilityInfo: {
                isReduceMotionEnabled: vi.fn(async () => false),
                addEventListener: vi.fn(() => ({ remove: vi.fn() })),
            },
            Dimensions: {
                get: () => ({ width: 800, height: 600, scale: 2, fontScale: 1 }),
            },
            useWindowDimensions: () => ({ width: 1200, height: 800 }),
            Platform: {
                OS: 'ios',
                select: (spec: Record<string, unknown>) =>
                    spec && Object.prototype.hasOwnProperty.call(spec, 'ios')
                        ? (spec as any).ios
                        : (spec as any).default,
            },
        });
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
            theme: themeColors,
        });
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({
            pathname: '/',
            router: {
                push: (...args: any[]) => routerPushSpy(...args),
                back: vi.fn(),
                replace: vi.fn(),
                setParams: vi.fn(),
            },
        }).module;
    },
    text: async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock({
        translate: (key: string) => key,
    }),
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        const modalMock = createModalModuleMock({ confirmResult: true });
        modalMockState.current = modalMock;
        return modalMock.module;
    },
    storage: async (importOriginal) => {
        const { createStorageModuleStub, createStorageStoreMock } = await import('@/dev/testkit/mocks/storage');
        const { create } = await import('zustand');
        const { settingsDefaults } = await import('@/sync/domains/settings/settings');
        const session: any = {
            id: 's1',
            serverId: 'server-cache',
            encryptionMode: 'plain',
            seq: 0,
            accessLevel: 'edit',
            access: createSessionAccessFixture('edit'),
            pendingVersion: 2,
            get presence() {
                return sessionStateOverrides.current.presence ?? 0;
            },
            get active() {
                return sessionStateOverrides.current.active ?? false;
            },
            get agentStateVersion() {
                return sessionStateOverrides.current.agentStateVersion ?? 0;
            },
            get activeAt() {
                return sessionStateOverrides.current.activeAt ?? 100;
            },
            get pendingActivationAuthorization() {
                return sessionStateOverrides.current.pendingActivationAuthorization ?? null;
            },
            get metadata() {
                return {
                    machineId: 'm-stale',
                    flavor: 'codex',
                    version: '999.0.0',
                    path: '/tmp/target',
                    homeDir: '/tmp',
                    codexSessionId: 'codex-session-1',
                    ...sessionMetadataOverrides.current,
                };
            },
            get agentState() {
                return sessionStateOverrides.current.agentState ?? {};
            },
            get optimisticThinkingAt() {
                return sessionOptimisticThinkingAt.current;
            },
            resumingAt: null,
        };

        const localSettingsFixture: Partial<LocalSettings> = {
            acknowledgedCliVersions: {},
            uiMultiPanePanelsEnabled: false,
            detailsPaneTabsBehavior: 'preview',
            rightPaneWidthPx: 360,
            rightPaneWidthBasisPx: 1200,
            detailsPaneWidthPx: 520,
            detailsPaneWidthBasisPx: 1200,
        };

        const settingsFixture: Partial<Settings> = {
            experiments: true,
            featureToggles: {},
            sessionMessageSendMode: 'server_pending',
            sessionBusySteerSendPolicy: 'steer_immediately',
            sessionInactiveResumePolicy: 'when_available',
        };
        const projectFixture: Project = {
            id: 'project-1',
            key: {
                serverId: 'server-cache',
                machineId: 'm-target',
                rootPath: '/tmp/target',
            },
            sessionIds: ['s1'],
            createdAt: 1,
            updatedAt: 1,
        };

        const initialStorage = createStorageStoreMock({
                    sessions: { s1: session },
                    machines: {
                        'm-target': {
                            id: 'm-target',
                            seq: 1,
                            createdAt: 1,
                            updatedAt: 1,
                            active: true,
                            activeAt: 10,
                            metadata: {
                                host: 'workstation.local',
                                platform: 'darwin',
                                happyCliVersion: '0.0.0',
                                happyHomeDir: '/tmp/.happy-dev',
                                homeDir: '/tmp',
                            },
                            metadataVersion: 1,
                            daemonState: null,
                            daemonStateVersion: 0,
                        },
                    },
                    getProjectForSession: (sessionId: string) =>
                        sessionId === 's1' ? projectFixture : null,
                    settings: {
                        ...settingsDefaults,
                        ...settingsFixture,
                        ...settingsState.current,
                        experiments: true,
                        featureToggles: {},
                    },
                    sessionListIndexByServerId: {},
        });
        // Resume and Pending producers publish immutable snapshots to real subscribers.
        const storage = create<StorageState>(() => initialStorage.getState());
        storageStoreRef.current = storage;
        sessionFixtureRef.current = session;

        return createStorageModuleStub({
            storage,
            useActiveServerAccountScope: () => ({ serverId: 'legacy-test', accountId: 'legacy-test' }),
            useSession: (sessionId: string) => storage((state) => state.sessions[sessionId] ?? null),
            useSessionMachineId: () => 'm-target',
            useIsDataReady: () => true,
            useRealtimeStatus: () => 'connected',
            useSessionMessages: () => ({ messages: [], isLoaded: true }),
            useSessionTranscriptIds: () => ({ ids: [], isLoaded: true }),
            useSessionSubagentSourceMessages: () => [],
            useSessionPendingMessages: () => React.useSyncExternalStore(
                (listener) => {
                    pendingMessagesState.listeners.add(listener);
                    return () => pendingMessagesState.listeners.delete(listener);
                },
                () => pendingMessagesState.current,
            ),
            useSessionReviewCommentsDrafts: () => [],
            useSessionUsage: () => null,
            useProfile: () => ({ id: 'account-profile', providerUsage: null }),
            useLocalSetting: (key: keyof LocalSettings) => (localSettingsFixture as any)[key],
            useLocalSettingMutable: (key: keyof LocalSettings) => [(localSettingsFixture as any)[key], vi.fn()],
            useSetting: (key: keyof Settings) => (
                (settingsState.current as any)[key]
                ?? (settingsFixture as any)[key]
                ?? (settingsDefaults as any)[key]
            ),
            useSettings: () => ({
                ...settingsFixture,
                ...settingsState.current,
                experiments: true,
                featureToggles: {},
                codexBackendMode: 'acp',
            }) as any,
            useAutomations: () => [],
            useMachine: () => null,
        });
    },
});

// Composer custody now clears through the synchronized draft repository. Keep
// this integration suite on that canonical owner instead of the shell helper's
// lightweight draft stub.
vi.doUnmock('@/hooks/session/useDraft');
vi.doMock('@/sync/store/hooks', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/sync/store/hooks')>(),
    useActiveServerAccountScope: () => ({ serverId: 'legacy-test', accountId: 'legacy-test' }),
}));

vi.mock('@/components/sessions/transcript/AgentContentView', () => ({
    AgentContentView: (props: any) => React.createElement('AgentContentView', props, props.input ?? null),
}));
vi.mock('@/components/sessions/transcript/ChatHeaderView', () => ({
    ChatHeaderView: () => null,
}));
vi.mock('@/components/sessions/transcript/ChatList', () => ({
    ChatList: () => null,
}));
vi.mock('@/components/ui/empty/EmptyMessages', () => ({
    EmptyMessages: () => null,
}));
vi.mock('@/components/ui/forms/Deferred', () => ({
    Deferred: (props: any) => React.createElement(React.Fragment, null, props.children),
}));
vi.mock('@/components/sessions/actions/SessionHeaderActionMenu', () => ({
    SessionHeaderActionMenu: () => null,
}));
vi.mock('@/components/voice/surface/VoiceSurface', () => ({
    VoiceSurface: () => null,
}));
vi.mock('@/components/sessions/agentInput', () => ({
    AgentInput: (props: any) => React.createElement('AgentInput', props),
}));
vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => false,
}));
vi.mock('@/utils/platform/responsive', () => ({
    getDeviceType: () => 'phone',
    useDeviceType: () => 'phone',
    useHeaderHeight: () => 0,
    useIsLandscape: () => false,
    useIsTablet: () => false,
}));
// Draft custody and restoration use the real hook and repository beneath the text-store boundary.
vi.mock('@/hooks/session/useSessionAgentInputComposerPersistence', () => ({
    useSessionAgentInputComposerPersistence: () => ({
        expanded: inputComposerExpandedState.current,
        setExpanded: inputComposerPersistenceSpies.setExpanded,
        clearTransientInputState: inputComposerPersistenceSpies.clearTransientInputState,
        captureTransientInputState: inputComposerPersistenceSpies.captureTransientInputState,
        restoreTransientInputState: inputComposerPersistenceSpies.restoreTransientInputState,
        inputPersistence: {
            initialScrollY: 12,
            initialSelection: { start: 1, end: 1 },
            restoreToken: 'session:s1:token',
            onScrollYChange: inputComposerPersistenceSpies.onScrollYChange,
            onSelectionChangePersist: inputComposerPersistenceSpies.onSelectionChangePersist,
        },
        structuredInputPersistence: {
            mentions: [],
            onMentionsChange: inputComposerPersistenceSpies.onStructuredInputMentionsChange,
        },
    }),
}));
vi.mock('@/components/sessions/model/inactiveSessionUi', () => ({
    getInactiveSessionUiState: () => inactiveSessionUiState.current,
}));
vi.mock('@/components/sessions/model/resolveSessionMachineReachability', () => ({
    resolveSessionMachineReachability: () => true,
}));
vi.mock(
    '@/components/sessions/model/useSessionMachineReachability',
    async (importOriginal) => {
        const { createSessionMachineReachabilityModuleMock } = await import('@/dev/testkit/mocks/sessionMachineReachability');
        return createSessionMachineReachabilityModuleMock({
            importOriginal,
            overrides: {
                useSessionMachineReachability: () => sessionMachineReachability.current,
                useSessionReachableMachineTarget: () => ({ machineId: 'm-target', basePath: '/tmp/target' }),
            },
        });
    },
);
vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => ({ serverId: 'server-1' }),
    subscribeActiveServer: (listener: any) => {
        listener({ serverId: 'server-1' });
        return () => {};
    },
}));
vi.mock('@/voice/session/voiceSession', () => ({
    useVoiceSessionSnapshot: () => ({ status: 'disconnected' }),
    voiceSessionManager: {},
}));
vi.mock('@/sync/sync', () => ({
    sync: {
        getSessionAttachmentTransferContext: () => undefined,
        markSessionViewed: async () => {},
        fetchPendingMessages: async () => {},
        publishSessionPermissionModeToMetadata: async () => {},
        publishSessionAcpSessionModeOverrideToMetadata: async () => {},
        publishSessionAcpConfigOptionOverrideToMetadata: async () => {},
        publishSessionModelOverrideToMetadata: async () => {},
        refreshSessions: async () => {},
        onSessionVisible: () => {},
        markSessionLiveTailIntent: () => {},
        materializeExistingSessionDraft: async () => {},
        patchSessionMetadataWithRetry: async () => {},
        getAcceptedExternalSessionTailCursor: () => null,
        subscribeAcceptedExternalSessionTailCursor: () => () => {},
        sendMessage: (...args: any[]) => sendMessageSpy(...args),
        enqueuePendingMessage: (...args: any[]) => enqueuePendingMessageSpy(...args),
        sendPendingMessageNow: (...args: any[]) => sendPendingMessageNowSpy(...args),
        updatePendingRequestedAction: (...args: any[]) => updatePendingRequestedActionSpy(...args),
        submitMessage: (...args: any[]) => submitMessageSpy(...args),
        encryption: {
            getMachineEncryption: () => (machineEncryptionAvailable.current ? { keyId: 'machine-key' } : null),
        },
    },
}));
vi.mock('@/sync/ops', async (importOriginal) => {
    const { createSyncOpsModuleMock } = await import('@/dev/testkit/mocks/syncOps');
    return createSyncOpsModuleMock({
        importOriginal,
        overrides: {
            sessionAbort: vi.fn(),
            sessionSwitch: sessionSwitchSpy,
            resumeSession: (...args: any[]) => resumeSessionSpy(...args),
            ensureSessionRuntimeForPendingInput: (...args: any[]) => resumeSessionSpy(...args),
            sessionAttachmentsUploadFile: vi.fn(),
        },
    });
});
vi.mock('@/sync/ops/sessionMachineTarget', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/ops/sessionMachineTarget')>();
    return {
        ...actual,
        readMachineTargetForSession: () => ({
            machineId: 'm-target',
            basePath: '/tmp/target',
        }),
        readMachineControlTargetForSession: () => ({
            machineId: 'm-target',
            basePath: '/tmp/target',
            confidence: 'reachable',
        }),
    };
});
vi.mock('@/agents/hooks/useResumeCapabilityOptions', () => ({
    useResumeCapabilityOptions: (input: { machineId?: string | null; serverId?: string | null }) => {
        resumeCapabilityMachineIds.push(typeof input?.machineId === 'string' ? input.machineId : '');
        resumeCapabilityServerIds.push(typeof input?.serverId === 'string' ? input.serverId : '');
        return {
            resumeCapabilityOptions: {
                machineId: typeof input?.machineId === 'string' ? input.machineId : null,
            },
        };
    },
}));
vi.mock('@/agents/runtime/resumeCapabilities', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/agents/runtime/resumeCapabilities')>(),
    canResumeSessionWithOptions: (metadata: unknown, options: { machineId?: string | null } | null | undefined) =>
        canResumeSessionWithOptionsSpy(metadata, options),
    canContinueSessionWithFreshSpawn: () => false,
    canResumeOrContinueSessionWithOptions: (metadata: unknown, options: { machineId?: string | null } | null | undefined) =>
        canResumeSessionWithOptionsSpy(metadata, options),
    getAgentVendorResumeId: () => null,
}));
vi.mock('@/sync/domains/input/slashCommands/resolveSessionComposerSend', () => ({
    resolveSessionComposerSend: (...args: any[]) => resolveSessionComposerSendMock(...args),
}));
vi.mock('@/agents/backendCatalog/getResolvedBackendCatalogEntries', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/agents/backendCatalog/getResolvedBackendCatalogEntries')>(),
    getResolvedBackendCatalogEntries: () => [],
}));
vi.mock('@/agents/backendCatalog/useDaemonMergedProjectionInputs', () => ({
    useDaemonMergedProjectionInputs: () => React.useSyncExternalStore(
        (listener) => {
            daemonMergedProjectionState.listeners.add(listener);
            return () => daemonMergedProjectionState.listeners.delete(listener);
        },
        () => daemonMergedProjectionState.current,
    ),
}));
vi.mock('@/sync/domains/permissions/permissionModeApply', () => ({
    applyPermissionModeSelection: async () => {},
}));
vi.mock('@/sync/acp/sessionModeControl', () => ({
    supportsSessionModeOverrides: () => false,
}));
vi.mock('@/sync/domains/session/control/localControlSwitch', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/sync/domains/session/control/localControlSwitch')>(),
    shouldRenderChatTimelineForSession: () => true,
    shouldRequestRemoteControl: () => false,
}));
vi.mock('@/sync/runtime/time', () => ({
    nowServerMs: () => 0,
}));
vi.mock('@/capabilities/ensureAgentInstallablesBackground', () => ({
    ensureAgentInstallablesBackground: (params: any) => ensureAgentInstallablesBackgroundSpy(params),
}));
vi.mock('@/utils/system/fireAndForget', () => ({
    fireAndForget: (promise: Promise<unknown>, options?: Readonly<{ tag?: string }>) => {
        pendingFireAndForgetTags.length = pendingFireAndForget.length;
        pendingFireAndForget.push(promise);
        pendingFireAndForgetTags.push(options?.tag);
        return promise;
    },
}));
vi.mock('@/utils/timing/runAfterInteractionsWithFallback', () => ({
    runAfterInteractionsWithFallback: () => () => {},
}));

const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
const { DestinationInstanceHost } = await import('@/components/appShell/workspace/DestinationInstanceHost');
const { SessionView } = await import('./SessionView');

describe('SessionView (sendMessage resumeInactive pendingQueue)', () => {
    const AppPaneProviderWrapper = ({ children }: { children?: React.ReactNode }) => (
        <AppPaneProvider>{children ?? null}</AppPaneProvider>
    );

    async function renderSessionView(props: { routeServerId?: string } = {}) {
        return renderScreen(
            <DestinationInstanceHost tabId="queue-session" ref={{ kind: 'session', params: {
                id: 's1', ...(props.routeServerId ? { serverId: props.routeServerId } : {}),
            } }} pathname="/session/s1" focused visible navigation={{
                push: routerPushSpy, pushRetainingCurrent: routerPushSpy, replace: vi.fn(), back: vi.fn(),
            }}>
                <SessionView id="s1" routeServerId={props.routeServerId} />
            </DestinationInstanceHost>,
            {
                wrapper: AppPaneProviderWrapper,
            },
        );
    }

    function findAgentInput(screen: Awaited<ReturnType<typeof renderSessionView>>) {
        const agentInputs = screen.tree.findAllByType('AgentInput' as any);
        return agentInputs[agentInputs.length - 1] ?? findTestInstanceByTypeWithProps(screen.tree, 'AgentInput' as any, {}) as any;
    }

    function notifyLocalPendingProjection(args: readonly unknown[], localId = 'direct-local-id') {
        const options = args[4] as
            | { onLocalPendingProjectionCreated?: (event: Readonly<{ localId: string }>) => void }
            | undefined;
        options?.onLocalPendingProjectionCreated?.({ localId });
    }

    async function waitForComposerDispatch() {
        const index = pendingFireAndForgetTags.lastIndexOf('SessionView.composer.dispatch');
        expect(index).toBeGreaterThanOrEqual(0);
        expect(pendingFireAndForget[index]).toBeDefined();
        await pendingFireAndForget[index];
    }

    function durablePendingRow(
        localId: string,
        action: 'send_now' | 'enqueue' = 'send_now',
    ): PendingMessage {
        return {
            id: `pending-${localId}`,
            localId,
            createdAt: 200,
            updatedAt: 200,
            source: 'server_pending',
            messageRole: 'user',
            pendingDeliveryStatus: 'server_queued',
            pendingRequestedAction: { v: 1, kind: action },
            text: 'parked input',
            rawRecord: { role: 'user', content: { type: 'text', text: 'parked input' } },
        };
    }

    async function publishDurablePendingState(input: Readonly<{
        row: PendingMessage;
        authorization?: Record<string, unknown> | null;
    }>) {
        sessionStateOverrides.current = {
            ...sessionStateOverrides.current,
            active: false,
            activeAt: 100,
            presence: 0,
            pendingActivationAuthorization: input.authorization ?? null,
        };
        pendingMessagesState.current = {
            messages: [input.row],
            discarded: [],
            isLoaded: true,
        };
        await act(async () => {
            storageStoreRef.current?.setState((state: any) => ({
                sessions: {
                    ...state.sessions,
                    s1: {
                        ...sessionFixtureRef.current,
                        active: false,
                        activeAt: 100,
                        presence: 0,
                        pendingActivationAuthorization: input.authorization ?? null,
                    },
                },
            }));
            for (const listener of pendingMessagesState.listeners) listener();
        });
    }

    beforeEach(() => {
        // The real wake owner receives the Home's current protocol projection through HTTP.
        setRuntimeFetch(async (input) => {
            const path = new URL(String(input)).pathname;
            if (path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
            if (path === '/health' || path === '/v1/auth/ping') return Response.json({ ok: true });
            return Response.json({ error: 'fixture_endpoint_unavailable' }, { status: 404 });
        });
        (globalThis as { __DEV__?: boolean }).__DEV__ = false;
        daemonMergedProjectionState.listeners.clear();
        daemonMergedProjectionState.current = { phase: 'idle', inputs: null };
        authCredentials = { token: 't', secret: 's' };
        enqueuePendingMessageSpy.mockReset().mockImplementation(async (...args: unknown[]) => {
            notifyLocalPendingProjection(args, 'pending-local-id');
            return { localId: 'pending-local-id', accepted: true };
        });
        sendPendingMessageNowSpy.mockClear();
        updatePendingRequestedActionSpy.mockClear();
        submitMessageSpy.mockClear();
        sendMessageSpy.mockClear();
        sendMessageSpy.mockImplementation(async (...args: unknown[]) => {
            notifyLocalPendingProjection(args);
        });
        resumeCapabilityMachineIds.length = 0;
        resumeCapabilityServerIds.length = 0;
        settingsState.current = {
            experiments: true,
            featureToggles: {},
            codexBackendMode: 'acp',
        };
        sessionMetadataOverrides.current = {};
        sessionStateOverrides.current = {};
        pendingMessagesState.listeners.clear();
        pendingMessagesState.current = { messages: [], discarded: [], isLoaded: true };
        machineEncryptionAvailable.current = false;
        sessionOptimisticThinkingAt.current = null;
        sessionResumingAt.current = null;
        sessionMachineReachability.current = {
            machineReachable: true,
            machineOnline: true,
            machineRpcTargetAvailable: true,
            machineReachability: 'reachable',
        };
        if (storageStoreRef.current && sessionFixtureRef.current) {
            storageStoreRef.current.setState((state: any) => ({
                sessions: { ...state.sessions, s1: sessionFixtureRef.current },
            }));
        }
        inactiveSessionUiState.current = { noticeKind: 'none', inactiveStatusTextKey: null, shouldShowInput: true };
        canResumeSessionWithOptionsSpy.mockReset();
        canResumeSessionWithOptionsSpy.mockImplementation(
            (_metadata: unknown, options: { machineId?: string | null } | null | undefined) => options?.machineId === 'm-target',
        );
        resumeSessionSpy.mockReset();
        resumeSessionSpy.mockImplementation(async () => ({
            type: 'error' as const,
            errorCode: 'DAEMON_RPC_UNAVAILABLE' as const,
            errorMessage: 'Daemon RPC is not available',
        }));
        routerPushSpy.mockReset();
        sessionSwitchSpy.mockClear();
        ensureAgentInstallablesBackgroundSpy.mockClear();
        modalMockState.current?.spies.alert.mockReset();
        modalMockState.current?.spies.confirm.mockReset();
        modalMockState.current?.spies.confirm.mockResolvedValue(true);
        resolveSessionComposerSendMock.mockReset().mockImplementation((input: { input?: unknown }) => ({
            kind: 'send', text: String(input?.input ?? ''),
        }));
        inputComposerPersistenceSpies.clearTransientInputState.mockClear();
        inputComposerPersistenceSpies.captureTransientInputState.mockClear();
        inputComposerPersistenceSpies.restoreTransientInputState.mockClear();
        inputComposerPersistenceSpies.setExpanded.mockClear();
        inputComposerPersistenceSpies.onScrollYChange.mockClear();
        inputComposerPersistenceSpies.onSelectionChangePersist.mockClear();
        inputComposerPersistenceSpies.onStructuredInputMentionsChange.mockClear();
        inputComposerExpandedState.current = false;
        pendingFireAndForget.length = 0;
        pendingFireAndForgetTags.length = 0;
    });

    afterEach(() => {
        standardCleanup();
        resetRuntimeFetch();
        pendingFireAndForget.length = 0;
        pendingFireAndForgetTags.length = 0;
        vi.clearAllMocks();
        (globalThis as { __DEV__?: boolean }).__DEV__ = previousDev;
    });

    beforeEach(activateSessionShellStorageBoundary);

    it('passes persisted composer UI state and expansion controls to AgentInput', async () => {
        const screen = await renderSessionView();

        const agentInput = findAgentInput(screen);

        expect(agentInput.props.inputPersistence).toEqual(expect.objectContaining({
            initialScrollY: 12,
            initialSelection: { start: 1, end: 1 },
            restoreToken: 'session:s1:token',
        }));
        expect(agentInput.props.inputExpansion).toEqual(expect.objectContaining({
            expanded: false,
            collapsedMaxHeight: expect.any(Number),
        }));

        await act(async () => {
            agentInput.props.inputExpansion.onToggle();
        });

        expect(inputComposerPersistenceSpies.setExpanded).toHaveBeenCalledTimes(1);
    });

    it('submits an attachment-only contentless composer draft through the structured-input envelope', async () => {
        const composerAttachments = [{
            v: 1 as const,
            instanceId: 'issue-42',
            attachment: { pluginId: 'acme.issues', localId: 'issue' },
            key: '42',
            value: { issueId: 42 },
            presentation: { label: 'Issue #42', typeLabel: 'Issue' },
        }];
        setComposerAttachmentProjection({
            [issueAttachmentCatalogEntry.id]: issueAttachmentCatalogEntry,
        });
        writeSessionDraftValue(
            TEST_SCOPE,
            's1',
            'structuredInput.composerAttachments',
            composerAttachments,
        );

        let screen: Awaited<ReturnType<typeof renderSessionView>> | undefined;
        try {
            screen = await renderSessionView();
            const agentInput = findAgentInput(screen);
            expect(agentInput.props.hasSendableAttachments).toBe(true);

            pendingFireAndForget.length = 0;
            await act(async () => {
                agentInput.props.onSend();
            });
            const coordinatorInvocation = pendingFireAndForgetTags.lastIndexOf('SessionView.composer.dispatch');
            expect(coordinatorInvocation).toBeGreaterThanOrEqual(0);
            await act(async () => {
                await pendingFireAndForget[coordinatorInvocation];
            });

            expect(enqueuePendingMessageSpy).toHaveBeenCalledTimes(1);
            expect(enqueuePendingMessageSpy.mock.calls[0]?.[3]).toMatchObject({
                happierStructuredInputV1: {
                    v: 1,
                    composerAttachments,
                },
            });
            expect(readSessionDraftValue(
                TEST_SCOPE,
                's1',
                'structuredInput.composerAttachments',
            )).toBeUndefined();
        } finally {
            await screen?.unmount();
            clearSessionDraftValuesForSession(TEST_SCOPE, 's1', { reason: 'composerClear' });
        }
    });

    it('keeps an uninstalled or incompatible persisted attachment visible, refuses its text send, and retains the draft until the exact current generation returns', async () => {
        const composerAttachments = [{
            v: 1 as const,
            instanceId: 'issue-42',
            attachment: { pluginId: 'acme.issues', localId: 'issue' },
            key: '42',
            value: { issueId: 42 },
            presentation: { label: 'Issue #42', typeLabel: 'Issue' },
        }];
        setComposerAttachmentProjection({
            [issueAttachmentCatalogEntry.id]: issueAttachmentCatalogEntry,
        });
        writeSessionDraftValue(
            TEST_SCOPE,
            's1',
            'structuredInput.composerAttachments',
            composerAttachments,
        );

        let screen: Awaited<ReturnType<typeof renderSessionView>> | undefined;
        try {
            screen = await renderSessionView();
            let agentInput = findAgentInput(screen);
            expect(agentInput.props.hasSendableAttachments).toBe(true);

            await act(async () => {
                setComposerAttachmentProjection({}, 2);
            });

            agentInput = findAgentInput(screen);
            expect(agentInput.props.hasSendableAttachments).toBe(false);
            expect(agentInput.props.attachmentRowItems).toEqual(expect.arrayContaining([
                expect.objectContaining({
                    availability: 'unavailable',
                    onRemove: expect.any(Function),
                }),
            ]));
            await act(async () => {
                agentInput.props.onChangeText('Keep this unavailable Session draft');
            });
            agentInput = findAgentInput(screen);
            pendingFireAndForget.length = 0;
            pendingFireAndForgetTags.length = 0;
            await act(async () => {
                agentInput.props.onSend();
            });
            const coordinatorInvocation = pendingFireAndForgetTags.lastIndexOf('SessionView.composer.dispatch');
            expect(coordinatorInvocation).toBeGreaterThanOrEqual(0);
            await act(async () => {
                await pendingFireAndForget[coordinatorInvocation];
            });
            expect(enqueuePendingMessageSpy).not.toHaveBeenCalled();
            expect(sendMessageSpy).not.toHaveBeenCalled();
            expect(submitMessageSpy).not.toHaveBeenCalled();
            expect(modalMockState.current?.spies.alert).toHaveBeenCalledWith('common.error', 'common.unavailable');
            expect(findAgentInput(screen).props.value).toBe('Keep this unavailable Session draft');
            expect(readSessionDraftValue(
                TEST_SCOPE,
                's1',
                'structuredInput.composerAttachments',
            )).toEqual(composerAttachments);

            const reinstalled = {
                ...issueAttachmentCatalogEntry,
                occurrenceId: 'issues-generation-2',
            };
            await act(async () => {
                setComposerAttachmentProjection({ [reinstalled.id]: reinstalled }, 3);
            });
            expect(findAgentInput(screen).props.hasSendableAttachments).toBe(true);

            const incompatible = {
                ...issueAttachmentCatalogEntry,
                occurrenceId: 'issues-generation-3',
            definition: {
                ...issueAttachmentCatalogEntry.definition,
                valueSchema: {
                        type: 'object',
                        required: ['slug'],
                        properties: { slug: { type: 'string' } },
                    additionalProperties: false,
                },
            },
        } satisfies PluginProjectedComposerAttachmentEntryV1;
            await act(async () => {
                setComposerAttachmentProjection({ [incompatible.id]: incompatible }, 4);
            });
            agentInput = findAgentInput(screen);
            expect(agentInput.props.hasSendableAttachments).toBe(false);
            expect(agentInput.props.attachmentRowItems).toEqual(expect.arrayContaining([
                expect.objectContaining({
                    availability: 'invalid',
                    onRemove: expect.any(Function),
                }),
            ]));
            await act(async () => {
                agentInput.props.onChangeText('Keep this invalid Session draft');
            });
            agentInput = findAgentInput(screen);
            modalMockState.current?.spies.alert.mockClear();
            pendingFireAndForget.length = 0;
            pendingFireAndForgetTags.length = 0;
            await act(async () => {
                agentInput.props.onSend();
            });
            const invalidCoordinatorInvocation = pendingFireAndForgetTags.lastIndexOf('SessionView.composer.dispatch');
            expect(invalidCoordinatorInvocation).toBeGreaterThanOrEqual(0);
            await act(async () => {
                await pendingFireAndForget[invalidCoordinatorInvocation];
            });
            expect(enqueuePendingMessageSpy).not.toHaveBeenCalled();
            expect(sendMessageSpy).not.toHaveBeenCalled();
            expect(submitMessageSpy).not.toHaveBeenCalled();
            expect(modalMockState.current?.spies.alert).toHaveBeenCalledWith('common.error', 'common.unavailable');
            expect(findAgentInput(screen).props.value).toBe('Keep this invalid Session draft');
            expect(readSessionDraftValue(
                TEST_SCOPE,
                's1',
                'structuredInput.composerAttachments',
            )).toEqual(composerAttachments);
        } finally {
            await screen?.unmount();
            clearSessionDraftValuesForSession(TEST_SCOPE, 's1', { reason: 'composerClear' });
        }
    });

    it('retries the durable failed-activation banner through the canonical resume action', async () => {
        machineEncryptionAvailable.current = true;
        const screen = await renderSessionView();

        pendingFireAndForget.length = 0;

        const agentInput = findAgentInput(screen);

        await act(async () => {
            agentInput.props.onChangeText('hello');
        });
        await act(async () => {
            agentInput.props.onSend();
        });

        expect(pendingFireAndForget.length).toBeGreaterThan(0);
        await act(async () => {
            await waitForComposerDispatch();
        });

        expect(enqueuePendingMessageSpy).toHaveBeenCalledTimes(1);
        expect(enqueuePendingMessageSpy.mock.calls[0]?.[0]).toBe('s1');
        expect(enqueuePendingMessageSpy.mock.calls[0]?.[1]).toBe('hello');
        expect(resumeCapabilityMachineIds).toContain('m-target');
        expect(resumeSessionSpy).toHaveBeenCalledTimes(1);
        expect(resumeSessionSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                machineId: 'm-target',
                directory: '/tmp/target',
                initialTranscriptAfterSeq: 0,
            }),
        );
        expect(modalMockState.current?.spies.alert).not.toHaveBeenCalled();
        await publishDurablePendingState({
            row: durablePendingRow('pending-1', 'enqueue'),
            authorization: {
                requestId: 'pending-1',
                requestedAt: 200,
                status: 'failed',
                failureCode: 'runtime_start_failed',
            },
        });

        const queuedWarning = screen.findByTestId('session-pendingActivation');
        expect(queuedWarning).toBeTruthy();
        expect(screen.getTextContent()).toContain('session.pendingActivation.failed.title');
        expect(screen.findByTestId('session-pendingActivation-retry')).toBeTruthy();

        resumeSessionSpy.mockImplementationOnce(async () => {
            sessionResumingAt.current = Date.now();
            storageStoreRef.current?.setState((state: any) => ({
                sessions: {
                    ...state.sessions,
                    s1: { ...sessionFixtureRef.current, resumingAt: sessionResumingAt.current },
                },
            }));
            return { type: 'success' as const };
        });

        await screen.pressByTestIdAsync('session-pendingActivation-retry');

        expect(resumeSessionSpy).toHaveBeenCalledTimes(2);
        expect(updatePendingRequestedActionSpy).not.toHaveBeenCalled();
        expect(sendPendingMessageNowSpy).not.toHaveBeenCalled();
        expect(findAgentInput(screen).props.connectionStatus?.text).toBe('session.resuming');
        expect(screen.findAllByTestId('session-pendingActivation')).toHaveLength(0);

        await screen.unmount();
    });

    it('renders the canonical resuming lifecycle through pending-queue wake acceptance', async () => {
        sessionMetadataOverrides.current = { version: '0.1.0' };
        sessionStateOverrides.current = { presence: 'online' };
        machineEncryptionAvailable.current = true;
        inactiveSessionUiState.current = {
            noticeKind: 'none',
            inactiveStatusTextKey: 'session.inactiveResumable',
            shouldShowInput: true,
        };
        let resolveResume: ((value: ResumeSessionResult) => void) | null = null;
        resumeSessionSpy.mockImplementationOnce(() => {
            sessionResumingAt.current = Date.now();
            storageStoreRef.current?.setState((state: any) => ({
                sessions: {
                    ...state.sessions,
                    s1: { ...sessionFixtureRef.current, resumingAt: sessionResumingAt.current },
                },
            }));
            return new Promise<ResumeSessionResult>((resolve) => {
                resolveResume = resolve;
            });
        });

        const screen = await renderSessionView();
        pendingFireAndForget.length = 0;

        const agentInput = findAgentInput(screen);
        expect(agentInput.props.connectionStatus?.text).not.toBe('session.resuming');

        await act(async () => {
            agentInput.props.onChangeText('hello');
        });
        await act(async () => {
            agentInput.props.onSend();
            await Promise.resolve();
            await Promise.resolve();
        });
        await flushHookEffects({ cycles: 1, turns: 2 });

        expect(resumeSessionSpy).toHaveBeenCalledTimes(1);
        expect(findAgentInput(screen).props.value).toBe('');
        expect(findAgentInput(screen).props.isSending).toBe(false);
        expect(findAgentInput(screen).props.connectionStatus?.text).toBe('session.resuming');
        expect(findAgentInput(screen).props.connectionStatus?.isPulsing).toBe(true);
        expect(screen.findAllByTestId('session-pendingActivation')).toHaveLength(0);

        await act(async () => {
            sessionOptimisticThinkingAt.current = Date.now();
            sessionResumingAt.current = null;
            storageStoreRef.current?.setState((state: any) => ({
                sessions: {
                    ...state.sessions,
                    s1: { ...sessionFixtureRef.current, resumingAt: null },
                },
            }));
            resolveResume?.({ type: 'success' });
            await waitForComposerDispatch();
        });

        // RPC acceptance is not provider attachment. Preserve the honest transitional state until
        // authoritative session activity replaces the local resume lifecycle.
        expect(findAgentInput(screen).props.connectionStatus?.text).toBe('session.resuming');
        expect(findAgentInput(screen).props.connectionStatus?.isPulsing).toBe(true);

        await screen.unmount();
    });

    it('wakes a server-pending inactive session through the cached owning server when the route server id is absent', async () => {
        sessionMetadataOverrides.current = { version: '0.1.0' };
        machineEncryptionAvailable.current = true;

        const screen = await renderSessionView();

        pendingFireAndForget.length = 0;

        const agentInput = findAgentInput(screen);

        await act(async () => {
            agentInput.props.onChangeText('hello');
        });
        await act(async () => {
            agentInput.props.onSend();
        });

        expect(pendingFireAndForget.length).toBeGreaterThan(0);
        await act(async () => {
            await waitForComposerDispatch();
        });

        expect(enqueuePendingMessageSpy).toHaveBeenCalledTimes(1);
        expect(resumeSessionSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                serverId: 'server-cache',
                machineId: 'm-target',
                directory: '/tmp/target',
            }),
        );
        await screen.unmount();
    });

    it('persists a send_now Pending action when the send action is forced immediate', async () => {
        sessionMetadataOverrides.current = { version: '0.1.0' };
        sessionStateOverrides.current = {
            active: true,
            presence: 'online',
            agentStateVersion: 1,
        };
        inactiveSessionUiState.current = {
            noticeKind: 'none',
            inactiveStatusTextKey: null,
            shouldShowInput: true,
        };

        const screen = await renderSessionView({ routeServerId: 'server-cache' });
        pendingFireAndForget.length = 0;
        let resolveEnqueue: (() => void) | null = null;
        enqueuePendingMessageSpy.mockImplementationOnce(async (...args: unknown[]) => new Promise<void>((resolve) => {
            notifyLocalPendingProjection(args);
            resolveEnqueue = resolve;
        }));

        const agentInput = findAgentInput(screen);

        await act(async () => {
            agentInput.props.onChangeText('hello now');
        });
        await act(async () => {
            agentInput.props.onSend({ forceImmediate: true });
        });
        await vi.waitFor(() => expect(enqueuePendingMessageSpy).toHaveBeenCalledTimes(1));

        expect(pendingFireAndForget.length).toBeGreaterThan(0);
        expect(findAgentInput(screen).props.value).toBe('hello now');
        expect(inputComposerPersistenceSpies.clearTransientInputState).not.toHaveBeenCalled();
        await act(async () => {
            resolveEnqueue?.();
            await waitForComposerDispatch();
        });

        expect(enqueuePendingMessageSpy).toHaveBeenCalledWith(
            's1',
            'hello now',
            undefined,
            expect.objectContaining({ happierDeliveryIntentV1: 'explicit_immediate' }),
            expect.objectContaining({
                localId: undefined,
                requestedAction: { v: 1, kind: 'send_now' },
                onLocalPendingProjectionCreated: expect.any(Function),
            }),
        );
        expect(submitMessageSpy).not.toHaveBeenCalled();
        expect(sendMessageSpy).not.toHaveBeenCalled();
        expect(resumeSessionSpy).not.toHaveBeenCalled();
        expect(inputComposerPersistenceSpies.clearTransientInputState).toHaveBeenCalledTimes(1);
        expect(findAgentInput(screen).props.value).toBe('');

        await screen.unmount();
    });

    it('keeps the submitted draft clear while an ambiguous enqueue retains Pending custody', async () => {
        sessionMetadataOverrides.current = { version: '0.1.0' };
        sessionStateOverrides.current = {
            active: true,
            presence: 'online',
            agentStateVersion: 1,
        };
        inactiveSessionUiState.current = {
            noticeKind: 'none',
            inactiveStatusTextKey: null,
            shouldShowInput: true,
        };
        enqueuePendingMessageSpy.mockImplementationOnce(async (...args: unknown[]) => {
            notifyLocalPendingProjection(args, 'ambiguous-local-id');
            return { localId: 'ambiguous-local-id', accepted: false };
        });

        const screen = await renderSessionView({ routeServerId: 'server-cache' });
        pendingFireAndForget.length = 0;

        const agentInput = findAgentInput(screen);
        await act(async () => {
            agentInput.props.onChangeText('owned by pending');
        });
        await act(async () => {
            agentInput.props.onSend({ forceImmediate: true });
        });
        await vi.waitFor(() => expect(enqueuePendingMessageSpy).toHaveBeenCalledTimes(1));

        expect(pendingFireAndForget.length).toBeGreaterThan(0);
        await act(async () => {
            await waitForComposerDispatch();
        });

        expect(enqueuePendingMessageSpy).toHaveBeenCalledTimes(1);
        expect(inputComposerPersistenceSpies.clearTransientInputState).toHaveBeenCalledTimes(1);
        expect(inputComposerPersistenceSpies.restoreTransientInputState).not.toHaveBeenCalled();
        expect(findAgentInput(screen).props.value).toBe('');

        await screen.unmount();
    });

    it('keeps the submitted draft when send_now enqueue fails before durable acceptance', async () => {
        sessionMetadataOverrides.current = { version: '0.1.0' };
        sessionStateOverrides.current = {
            active: true,
            presence: 'online',
            agentStateVersion: 1,
        };
        inactiveSessionUiState.current = {
            noticeKind: 'none',
            inactiveStatusTextKey: null,
            shouldShowInput: true,
        };
        enqueuePendingMessageSpy.mockImplementationOnce(async (...args: unknown[]) => {
            notifyLocalPendingProjection(args);
            throw new Error('enqueue rejected');
        });

        const screen = await renderSessionView({ routeServerId: 'server-cache' });
        pendingFireAndForget.length = 0;

        const agentInput = findAgentInput(screen);
        await act(async () => {
            agentInput.props.onChangeText('retry me');
        });
        await act(async () => {
            agentInput.props.onSend({ forceImmediate: true });
        });

        expect(pendingFireAndForget.length).toBeGreaterThan(0);
        await act(async () => {
            await waitForComposerDispatch();
        });

        expect(enqueuePendingMessageSpy).toHaveBeenCalledTimes(1);
        expect(sendMessageSpy).not.toHaveBeenCalled();
        expect(inputComposerPersistenceSpies.clearTransientInputState).not.toHaveBeenCalled();
        expect(inputComposerPersistenceSpies.restoreTransientInputState).not.toHaveBeenCalled();
        expect(findAgentInput(screen).props.value).toBe('retry me');

        await screen.unmount();
    });

    it('enqueues signed-in locally attached input when the send action explicitly requests the server pending queue', async () => {
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const { upsertServerProfile } = await import('@/sync/domains/server/serverProfiles');
        const { serverAccountScopedResourceKey } = await import('@/sync/domains/scope/serverAccountScope');
        const { machineAgentInventoryStore } = await import('@/agents/machineAgents/machineAgentInventoryStore');
        const { useMachineAgent } = await import('@/agents/machineAgents/useMachineAgents');
        const { renderHook } = await import('@/dev/testkit/hooks/renderHook');
        const profile = await upsertServerProfile({ serverUrl: 'https://server-cache' });
        const accountId = 'pending-local-control-account';
        const inventoryKey = serverAccountScopedResourceKey({ serverId: profile.id, accountId }, 'machine-agents', 'm-target');
        // Secure credential storage is the boundary; the Account binding and machine-agent hook stay real.
        const credentialsRead = vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({
            token: `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64')}.signature`,
            secret: 's',
        });
        machineAgentInventoryStore.publish(inventoryKey, {
            status: 'ready',
            lastCheckedAt: Date.now(),
            items: [{
                agentId: 'codex', title: 'Codex', installed: true, version: '1', latestVersion: '1',
                update: { supported: false, command: null },
                signIn: { status: 'signedIn', loginSupport: 'status_only' },
                platform: { supported: true },
                install: { available: false, mode: 'manual', sizeBytes: null, guideUrl: null },
                dependencies: [],
            }],
        });
        settingsState.current = {
            experiments: true,
            featureToggles: {},
            codexBackendMode: 'acp',
            sessionMessageSendMode: 'agent_queue',
            sessionBusySteerSendPolicy: 'steer_immediately',
        };
        sessionStateOverrides.current = {
            active: true,
            presence: 'online',
            agentStateVersion: 1,
            agentState: {
                controlledByUser: true,
                capabilities: {
                    inFlightSteer: true,
                    inFlightSteerSupported: true,
                    inFlightSteerAvailable: true,
                },
            },
        };

        const auth = await renderHook(() => useMachineAgent({ serverId: profile.id, machineId: 'm-target', agentId: 'codex', load: false }));
        try {
            await vi.waitFor(() => expect(auth.getCurrent()?.signIn.status).toBe('signedIn'));
            const screen = await renderSessionView({ routeServerId: profile.id });
            try {
                pendingFireAndForget.length = 0;
                pendingFireAndForgetTags.length = 0;

                const agentInput = findAgentInput(screen);

                await act(async () => {
                    agentInput.props.onChangeText('queue me');
                });
                await act(async () => {
                    agentInput.props.onSend({ deliveryIntent: 'server_pending' });
                });

                const dispatchIndex = pendingFireAndForgetTags.lastIndexOf('SessionView.composer.dispatch');
                expect(dispatchIndex).toBeGreaterThanOrEqual(0);
                await act(async () => {
                    await pendingFireAndForget[dispatchIndex];
                });

                expect(enqueuePendingMessageSpy).toHaveBeenCalledTimes(1);
                expect(enqueuePendingMessageSpy.mock.calls[0]?.[0]).toBe('s1');
                expect(enqueuePendingMessageSpy.mock.calls[0]?.[1]).toBe('queue me');
                expect(submitMessageSpy).not.toHaveBeenCalled();
                expect(sessionSwitchSpy).not.toHaveBeenCalled();
                expect(modalMockState.current?.spies.alert).not.toHaveBeenCalled();
            } finally {
                await screen.unmount();
            }
        } finally {
            await auth.unmount();
            credentialsRead.mockRestore();
            machineAgentInventoryStore.publish(inventoryKey, { status: 'ready', items: [], descriptors: [], lastCheckedAt: null });
        }
    });

    it('shows an offline queued banner and authorizes the exact durable row for processing when online', async () => {
        const row = durablePendingRow('queued-row', 'enqueue');
        pendingMessagesState.current = { messages: [row], discarded: [], isLoaded: true };
        sessionStateOverrides.current = { active: false, activeAt: 100, presence: 0 };
        sessionMachineReachability.current = {
            machineReachable: false,
            machineOnline: false,
            machineRpcTargetAvailable: true,
            machineReachability: 'unreachable',
        };

        const screen = await renderSessionView();
        const banner = screen.findByTestId('session-pendingActivation');

        expect(banner).toBeTruthy();
        expect(screen.getTextContent()).toContain('session.pendingActivation.queued_offline.title');
        expect(screen.findByTestId('session-pendingActivation-process_when_online')).toBeTruthy();
        expect(screen.findByTestId('session-pendingActivation-settings')).toBeTruthy();

        await screen.pressByTestIdAsync('session-pendingActivation-process_when_online');

        expect(updatePendingRequestedActionSpy).toHaveBeenCalledWith(
            's1',
            'queued-row',
            { v: 1, kind: 'enqueue' },
            { resumeWhenAvailable: true },
        );
        expect(sendPendingMessageNowSpy).not.toHaveBeenCalled();

        await screen.unmount();
    });

    it('resumes through the canonical session action from the online queued banner', async () => {
        const row = durablePendingRow('queued-row', 'enqueue');
        pendingMessagesState.current = { messages: [row], discarded: [], isLoaded: true };
        sessionStateOverrides.current = { active: false, activeAt: 100, presence: 0 };
        resumeSessionSpy.mockImplementationOnce(async () => {
            sessionResumingAt.current = Date.now();
            storageStoreRef.current?.setState((state: any) => ({
                sessions: {
                    ...state.sessions,
                    s1: { ...sessionFixtureRef.current, resumingAt: sessionResumingAt.current },
                },
            }));
            return { type: 'success' as const };
        });

        const screen = await renderSessionView();

        expect(screen.findByTestId('session-pendingActivation-resume')).toBeTruthy();
        await screen.pressByTestIdAsync('session-pendingActivation-resume');

        expect(resumeSessionSpy).toHaveBeenCalledTimes(1);
        expect(sendPendingMessageNowSpy).not.toHaveBeenCalled();
        expect(findAgentInput(screen).props.connectionStatus?.text).toBe('session.resuming');
        expect(screen.findAllByTestId('session-pendingActivation')).toHaveLength(0);

        await screen.unmount();
    });

    it('shows waiting while offline and keeps the exact durable row queued', async () => {
        const row = durablePendingRow('waiting-row');
        pendingMessagesState.current = { messages: [row], discarded: [], isLoaded: true };
        sessionMachineReachability.current = {
            machineReachable: false,
            machineOnline: false,
            machineRpcTargetAvailable: true,
            machineReachability: 'unreachable',
        };
        sessionStateOverrides.current = {
            active: false,
            activeAt: 100,
            presence: 0,
            pendingActivationAuthorization: {
                requestId: 'waiting-row',
                requestedAt: 200,
                status: 'waiting',
            },
        };

        const screen = await renderSessionView();
        const banner = screen.findByTestId('session-pendingActivation');

        expect(banner).toBeTruthy();
        expect(screen.getTextContent()).toContain('session.pendingActivation.waiting_offline.title');
        expect(screen.findByTestId('session-pendingActivation-keepQueued')).toBeTruthy();

        await screen.pressByTestIdAsync('session-pendingActivation-keepQueued');

        expect(updatePendingRequestedActionSpy).toHaveBeenCalledWith(
            's1',
            'waiting-row',
            { v: 1, kind: 'enqueue' },
            { resumeWhenAvailable: false },
        );

        await screen.unmount();
    });

    it('authors a replay continuation through New Session with source context instead of the legacy creator', async () => {
        settingsState.current = {
            experiments: true,
            featureToggles: {},
            codexBackendMode: 'acp',
            sessionReplayEnabled: true,
            sessionReplayStrategy: 'recent_messages',
            sessionReplayRecentMessagesCount: 100,
            sessionReplayMaxSeedChars: 120000,
            sessionReplaySummaryRunnerV1: null,
        };
        canResumeSessionWithOptionsSpy.mockReturnValue(false);
        modalMockState.current?.spies.confirm.mockResolvedValue(true);
        modalMockState.current?.spies.alert.mockClear();

        const screen = await renderSessionView();

        await act(async () => {
            await emitSessionResumeRequest('s1');
        });

        expect(resumeCapabilityMachineIds).toContain('m-target');
        expect(modalMockState.current?.spies.confirm).toHaveBeenCalledTimes(1);
        expect(modalMockState.current?.spies.alert).not.toHaveBeenCalled();
        expect(routerPushSpy).toHaveBeenCalledWith(expect.objectContaining({
            pathname: '/new',
            params: expect.objectContaining({ dataId: expect.any(String) }),
        }));

        await screen.unmount();
    });

    it('uses the cached owning server scope for auth, resume capabilities, installables, and resume when the route serverId is missing', async () => {
        const screen = await renderSessionView();

        await act(async () => {
            await emitSessionResumeRequest('s1');
        });

        const { resolveServerCredentialAccountScope } = await import('@/sync/domains/scope/serverCredentialAccountScope');
        expect(await resolveServerCredentialAccountScope('server-cache')).toMatchObject({
            kind: 'bound', scope: TEST_SCOPE,
        });
        expect(resumeCapabilityServerIds).toContain('server-cache');
        expect(ensureAgentInstallablesBackgroundSpy).toHaveBeenCalledWith(
            expect.objectContaining({ serverId: 'server-cache' }),
        );
        expect(resumeSessionSpy).toHaveBeenCalledWith(
            expect.objectContaining({ serverId: 'server-cache' }),
        );

        await screen.unmount();
    });

    it('keeps the queued message accepted while exposing missing-folder recovery after an automatic wake', async () => {
        machineEncryptionAvailable.current = true;
        sessionMetadataOverrides.current = { sessionDirectoryV1: { v: 1, kind: 'managed' } };
        resumeSessionSpy.mockResolvedValueOnce({ type: 'error', errorCode: 'SESSION_DIRECTORY_MISSING', errorMessage: 'missing' });
        const screen = await renderSessionView();
        const input = findAgentInput(screen);
        await act(async () => { input.props.onChangeText('keep this prompt'); });
        await act(async () => { input.props.onSend(); });
        await act(async () => { await Promise.all(pendingFireAndForget); });
        expect(enqueuePendingMessageSpy).toHaveBeenCalledTimes(1);
        expect(screen.findByTestId('session-directory-missing')).toBeTruthy();
        expect(modalMockState.current?.spies.alert).not.toHaveBeenCalled();
        expect(updatePendingRequestedActionSpy).not.toHaveBeenCalled();
        await screen.unmount();
    });

    it('offers fresh-folder recovery inline and requests recreation only after explicit consent', async () => {
        sessionMetadataOverrides.current = { sessionDirectoryV1: { v: 1, kind: 'managed' } };
        resumeSessionSpy.mockResolvedValueOnce({
            type: 'error', errorCode: 'SESSION_DIRECTORY_MISSING', errorMessage: 'Session folder is missing',
        }).mockResolvedValueOnce({ type: 'success', sessionId: 's1' });
        const screen = await renderSessionView();
        await act(async () => { await emitSessionResumeRequest('s1'); });
        expect(resumeSessionSpy).toHaveBeenCalledTimes(1);
        expect(resumeSessionSpy.mock.calls[0]?.[0]).not.toMatchObject({ approvedNewDirectoryCreation: true });
        const notice = screen.findByTestId('session-directory-missing');
        expect(notice).toBeTruthy();
        expect(modalMockState.current?.spies.alert).not.toHaveBeenCalled();
        await screen.pressByTestIdAsync('session-directory-missing-continue');
        expect(resumeSessionSpy).toHaveBeenCalledTimes(2);
        expect(resumeSessionSpy.mock.calls[1]?.[0]).toMatchObject({ approvedNewDirectoryCreation: true });
        await screen.unmount();
    });
});
