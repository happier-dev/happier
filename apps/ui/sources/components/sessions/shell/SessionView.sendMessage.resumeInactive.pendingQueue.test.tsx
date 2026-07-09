import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SPAWN_SESSION_ERROR_CODES } from '@happier-dev/protocol';

import { flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { findTestInstanceByTypeWithProps } from '@/dev/testkit/render/renderScreen';
import type { createModalModuleMock } from '@/dev/testkit/mocks/modal';
import type { ResumeSessionResult } from '@/sync/ops/sessions';
import type { LocalSettings } from '@/sync/domains/settings/localSettings';
import type { Settings } from '@/sync/domains/settings/settings';
import type { Project } from '@/sync/runtime/orchestration/projectManager';
import { emitSessionResumeRequest } from '@/components/sessions/model/sessionResumeRequests';
import { installSessionShellCommonModuleMocks } from './sessionShellTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const previousDev = (globalThis as { __DEV__?: boolean }).__DEV__;
const enqueuePendingMessageSpy = vi.hoisted(() => vi.fn(async (..._args: any[]) => {}));
const submitMessageSpy = vi.hoisted(() => vi.fn(async (..._args: any[]) => {}));
const sendMessageSpy = vi.hoisted(() => vi.fn(async (..._args: any[]) => {}));
const resumeSessionSpy = vi.hoisted(() =>
    vi.fn<(..._args: any[]) => Promise<ResumeSessionResult>>(async (..._args: any[]) => ({
        type: 'error' as const,
        errorCode: 'DAEMON_RPC_UNAVAILABLE' as const,
        errorMessage: 'Daemon RPC is not available',
    })),
);
const continueSessionWithReplaySpy = vi.hoisted(() =>
    vi.fn(async (..._args: any[]) => ({
        type: 'success' as const,
        sessionId: 's2',
    })),
);
const canResumeSessionWithOptionsSpy = vi.hoisted(() =>
    vi.fn((_metadata: unknown, options: { machineId?: string | null } | null | undefined) => options?.machineId === 'm-target'),
);
const resumeCapabilityMachineIds = vi.hoisted(() => [] as string[]);
const resumeCapabilityServerIds = vi.hoisted(() => [] as string[]);
const cliDetectionServerIds = vi.hoisted(() => [] as string[]);
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
const draftHookSpies = vi.hoisted(() => ({
    clearDraft: vi.fn(),
    clearDraftIfCurrentValueMatches: vi.fn(),
    clearDraftForSessionIfCurrentValueMatches: vi.fn(),
    setDraftValue: vi.fn(),
    restoreDraftForSessionIfCurrentValueMatches: vi.fn(),
    restoreDraft: vi.fn(),
    restoreComposerSnapshot: vi.fn(),
    valuesBySessionId: new Map<string, string>(),
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

vi.mock('react-native-reanimated', () => ({}));
vi.mock('expo-linear-gradient', () => ({
    LinearGradient: 'LinearGradient',
}));
vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));
vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('@react-navigation/native', () => ({
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
                push: vi.fn(),
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
        const { settingsDefaults } = await import('@/sync/domains/settings/settings');
        const session: any = {
            id: 's1',
            serverId: 'server-cache',
            seq: 0,
            accessLevel: 'edit',
            pendingVersion: 2,
            get presence() {
                return sessionStateOverrides.current.presence ?? Date.now() - 60_000;
            },
            get active() {
                return sessionStateOverrides.current.active ?? false;
            },
            get agentStateVersion() {
                return sessionStateOverrides.current.agentStateVersion ?? 0;
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
            codexBackendMode: 'acp',
            sessionMessageSendMode: 'server_pending',
            sessionBusySteerSendPolicy: 'steer_immediately',
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

        return createStorageModuleStub({
            storage: createStorageStoreMock({
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
                        codexBackendMode: 'acp',
                    },
                    sessionListIndexByServerId: {},
            }),
            useSession: () => session,
            useIsDataReady: () => true,
            useRealtimeStatus: () => 'connected',
            useSessionMessages: () => ({ messages: [], isLoaded: true }),
            useSessionTranscriptIds: () => ({ ids: [], isLoaded: true }),
            useSessionSubagentSourceMessages: () => [],
            useSessionPendingMessages: () => ({ messages: [], discarded: [], isLoaded: true }),
            useSessionReviewCommentsDrafts: () => [],
            useSessionUsage: () => null,
            useProfile: () => ({ id: 'account-profile', providerUsage: null }),
            useLocalSetting: (key: keyof LocalSettings) => (localSettingsFixture as any)[key],
            useLocalSettingMutable: (key: keyof LocalSettings) => [(localSettingsFixture as any)[key], vi.fn()],
            useSetting: (key: keyof Settings) => ((settingsState.current as any)[key] ?? (settingsFixture as any)[key]),
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
vi.mock('@/hooks/auth/useCLIDetection', () => ({
    useCLIDetection: (_machineId: string | null, options?: { serverId?: string | null }) => {
        cliDetectionServerIds.push(typeof options?.serverId === 'string' ? options.serverId : '');
        return {
            available: {},
            login: {},
            authStatus: {},
            resolvedPath: {},
            resolutionSource: {},
            tmux: null,
            isDetecting: false,
            timestamp: 1,
            refresh: vi.fn(),
        };
    },
}));
vi.mock('@/utils/platform/responsive', () => ({
    getDeviceType: () => 'phone',
    useDeviceType: () => 'phone',
    useHeaderHeight: () => 0,
    useIsLandscape: () => false,
    useIsTablet: () => false,
}));
vi.mock('@/hooks/session/useDraft', () => ({
    useDraft: (_sessionId: string, value: string, onChange: (text: string) => void) => {
        draftHookSpies.valuesBySessionId.set(_sessionId, value);
        const update = (text: string) => {
            draftHookSpies.valuesBySessionId.set(_sessionId, text);
            onChange(text);
        };
        return {
            clearDraft: () => {
                draftHookSpies.clearDraft();
                update('');
            },
            clearDraftIfCurrentValueMatches: (expectedValue: string) => {
                draftHookSpies.clearDraftIfCurrentValueMatches(expectedValue);
                const currentValue = draftHookSpies.valuesBySessionId.get(_sessionId) ?? '';
                if (currentValue !== expectedValue) return false;
                update('');
                return true;
            },
            clearDraftForSessionIfCurrentValueMatches: (snapshot: Readonly<{ sessionId: string; text: string }>) => {
                draftHookSpies.clearDraftForSessionIfCurrentValueMatches(snapshot);
                const currentValue = draftHookSpies.valuesBySessionId.get(_sessionId) ?? '';
                if (currentValue !== snapshot.text) return false;
                update('');
                return true;
            },
            setDraftValue: (nextValueOrUpdater: string | ((currentValue: string) => string)) => {
                const currentValue = draftHookSpies.valuesBySessionId.get(_sessionId) ?? '';
                const nextValue = typeof nextValueOrUpdater === 'function'
                    ? nextValueOrUpdater(currentValue)
                    : nextValueOrUpdater;
                draftHookSpies.setDraftValue(nextValue);
                update(nextValue);
            },
            restoreDraft: (text: string) => {
                draftHookSpies.restoreDraft(text);
                update(text);
            },
            restoreDraftForSessionIfCurrentValueMatches: (
                snapshot: Readonly<{ sessionId: string; text: string }>,
                expectedCurrentValue: string,
            ) => {
                draftHookSpies.restoreDraftForSessionIfCurrentValueMatches(snapshot, expectedCurrentValue);
                const currentValue = draftHookSpies.valuesBySessionId.get(_sessionId) ?? '';
                if (currentValue !== expectedCurrentValue) return false;
                update(snapshot.text);
                return true;
            },
            restoreComposerSnapshot: (snapshot: Readonly<{ sessionId: string; text: string }>) => {
                draftHookSpies.restoreComposerSnapshot(snapshot);
                update(snapshot.text);
            },
        };
    },
}));
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
                useSessionMachineReachability: () => ({ machineReachable: true, machineOnline: true, machineRpcTargetAvailable: true }),
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
        markSessionViewed: async () => {},
        fetchPendingMessages: async () => {},
        publishSessionPermissionModeToMetadata: async () => {},
        publishSessionAcpSessionModeOverrideToMetadata: async () => {},
        publishSessionAcpConfigOptionOverrideToMetadata: async () => {},
        publishSessionModelOverrideToMetadata: async () => {},
        refreshSessions: async () => {},
        onSessionVisible: () => {},
        markSessionLiveTailIntent: () => {},
        sendMessage: (...args: any[]) => sendMessageSpy(...args),
        enqueuePendingMessage: (...args: any[]) => enqueuePendingMessageSpy(...args),
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
            continueSessionWithReplay: (...args: any[]) => continueSessionWithReplaySpy(...args),
            sessionAbort: vi.fn(),
            resumeSession: (...args: any[]) => resumeSessionSpy(...args),
            sessionAttachmentsUploadFile: vi.fn(),
        },
    });
});
vi.mock('@/sync/ops/actions/defaultActionExecutor', () => ({
    createDefaultActionExecutor: () => ({ execute: vi.fn() }),
}));
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
vi.mock('@/agents/runtime/resumeCapabilities', () => ({
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
vi.mock('@/agents/backendCatalog/getResolvedBackendCatalogEntries', () => ({
    getResolvedBackendCatalogEntries: () => [],
}));
vi.mock('@/agents/backendCatalog/useDaemonMergedProjectionInputs', () => ({
    useDaemonMergedProjectionInputs: () => ({ inputs: null }),
}));
vi.mock('@/sync/domains/permissions/permissionModeApply', () => ({
    applyPermissionModeSelection: async () => {},
}));
vi.mock('@/sync/acp/sessionModeControl', () => ({
    supportsSessionModeOverrides: () => false,
}));
vi.mock('@/sync/domains/session/control/localControlSwitch', () => ({
    shouldRenderChatTimelineForSession: () => true,
    shouldRequestRemoteControl: () => false,
    shouldRequestRemoteControlAfterPendingEnqueue: () => false,
}));
vi.mock('@/sync/runtime/time', () => ({
    nowServerMs: () => 0,
}));
vi.mock('@/capabilities/ensureAgentInstallablesBackground', () => ({
    ensureAgentInstallablesBackground: (params: any) => ensureAgentInstallablesBackgroundSpy(params),
}));
vi.mock('@/utils/system/fireAndForget', () => ({
    fireAndForget: (promise: Promise<unknown>) => {
        pendingFireAndForget.push(promise);
        return promise;
    },
}));
vi.mock('@/utils/timing/runAfterInteractionsWithFallback', () => ({
    runAfterInteractionsWithFallback: () => () => {},
}));

const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
const { SessionView } = await import('./SessionView');

describe('SessionView (sendMessage resumeInactive pendingQueue)', () => {
    const AppPaneProviderWrapper = ({ children }: { children?: React.ReactNode }) => (
        <AppPaneProvider>{children ?? null}</AppPaneProvider>
    );

    async function renderSessionView(props: { routeServerId?: string } = {}) {
        return renderScreen(
            <SessionView id="s1" routeServerId={props.routeServerId} />,
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

    function expectDirectSendProjectionOptions() {
        return expect.objectContaining({
            localId: undefined,
            onLocalPendingProjectionCreated: expect.any(Function),
            profileId: undefined,
        });
    }

    beforeEach(() => {
        (globalThis as { __DEV__?: boolean }).__DEV__ = false;
        authCredentials = { token: 't', secret: 's' };
        enqueuePendingMessageSpy.mockClear();
        submitMessageSpy.mockClear();
        sendMessageSpy.mockClear();
        sendMessageSpy.mockImplementation(async (...args: unknown[]) => {
            notifyLocalPendingProjection(args);
        });
        resumeCapabilityMachineIds.length = 0;
        resumeCapabilityServerIds.length = 0;
        cliDetectionServerIds.length = 0;
        settingsState.current = { experiments: true, featureToggles: {}, codexBackendMode: 'acp' };
        sessionMetadataOverrides.current = {};
        sessionStateOverrides.current = {};
        machineEncryptionAvailable.current = false;
        sessionOptimisticThinkingAt.current = null;
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
        continueSessionWithReplaySpy.mockReset();
        continueSessionWithReplaySpy.mockResolvedValue({
            type: 'success',
            sessionId: 's2',
        });
        ensureAgentInstallablesBackgroundSpy.mockClear();
        modalMockState.current?.spies.alert.mockReset();
        modalMockState.current?.spies.confirm.mockReset();
        modalMockState.current?.spies.confirm.mockResolvedValue(true);
        resolveSessionComposerSendMock.mockReset();
        draftHookSpies.clearDraft.mockClear();
        draftHookSpies.clearDraftIfCurrentValueMatches.mockClear();
        draftHookSpies.clearDraftForSessionIfCurrentValueMatches.mockClear();
        draftHookSpies.setDraftValue.mockClear();
        draftHookSpies.restoreDraftForSessionIfCurrentValueMatches.mockClear();
        draftHookSpies.restoreDraft.mockClear();
        draftHookSpies.restoreComposerSnapshot.mockClear();
        draftHookSpies.valuesBySessionId.clear();
        inputComposerPersistenceSpies.clearTransientInputState.mockClear();
        inputComposerPersistenceSpies.captureTransientInputState.mockClear();
        inputComposerPersistenceSpies.restoreTransientInputState.mockClear();
        inputComposerPersistenceSpies.setExpanded.mockClear();
        inputComposerPersistenceSpies.onScrollYChange.mockClear();
        inputComposerPersistenceSpies.onSelectionChangePersist.mockClear();
        inputComposerPersistenceSpies.onStructuredInputMentionsChange.mockClear();
        inputComposerExpandedState.current = false;
        pendingFireAndForget.length = 0;
    });

    afterEach(() => {
        standardCleanup();
        pendingFireAndForget.length = 0;
        vi.clearAllMocks();
        (globalThis as { __DEV__?: boolean }).__DEV__ = previousDev;
    });

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

    it('shows a non-blocking warning (no modal) when resume fails after enqueueing a pending message', async () => {
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
            await pendingFireAndForget[0];
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
        expect(findAgentInput(screen).props.value).toBe('');
        expect(screen.findByTestId('session-pendingQueue-resumeFailed')).toBeTruthy();

        await screen.unmount();
    });

    it('toggles resuming connection status around pending-queue wake', async () => {
        sessionMetadataOverrides.current = { version: '0.1.0' };
        machineEncryptionAvailable.current = true;
        inactiveSessionUiState.current = {
            noticeKind: 'none',
            inactiveStatusTextKey: 'session.inactiveResumable',
            shouldShowInput: true,
        };
        let resolveResume: ((value: ResumeSessionResult) => void) | null = null;
        resumeSessionSpy.mockImplementationOnce(() => {
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
        expect(findAgentInput(screen).props.connectionStatus?.text).toBe('session.resuming');
        expect(findAgentInput(screen).props.connectionStatus?.isPulsing).toBe(true);

        await act(async () => {
            sessionOptimisticThinkingAt.current = Date.now();
            resolveResume?.({ type: 'success' });
            await pendingFireAndForget[0];
        });

        expect(findAgentInput(screen).props.connectionStatus?.text).not.toBe('session.resuming');
        expect(findAgentInput(screen).props.connectionStatus?.isPulsing).not.toBe(true);

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
            await pendingFireAndForget[0];
        });

        expect(enqueuePendingMessageSpy).toHaveBeenCalledTimes(1);
        expect(resumeSessionSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                serverId: 'server-cache',
                machineId: 'm-target',
                directory: '/tmp/target',
            }),
        );
        expect(screen.findByTestId('session-pendingQueue-resumeFailed')).toBeTruthy();

        await screen.unmount();
    });

    it('bypasses server-pending enqueue when the send action is forced immediate', async () => {
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
        let resolveSend: (() => void) | null = null;
        sendMessageSpy.mockImplementationOnce(async (...args: unknown[]) => new Promise<void>((resolve) => {
            notifyLocalPendingProjection(args);
            resolveSend = resolve;
        }));

        const agentInput = findAgentInput(screen);

        await act(async () => {
            agentInput.props.onChangeText('hello now');
        });
        await act(async () => {
            agentInput.props.onSend({ forceImmediate: true });
        });

        expect(pendingFireAndForget.length).toBeGreaterThan(0);
        expect(findAgentInput(screen).props.value).toBe('');
        await act(async () => {
            resolveSend?.();
            await pendingFireAndForget[0];
        });

        expect(enqueuePendingMessageSpy).not.toHaveBeenCalled();
        expect(submitMessageSpy).not.toHaveBeenCalled();
        expect(sendMessageSpy).toHaveBeenCalledTimes(1);
        expect(sendMessageSpy).toHaveBeenCalledWith(
            's1',
            'hello now',
            undefined,
            undefined,
            expectDirectSendProjectionOptions(),
        );
        expect(resumeSessionSpy).not.toHaveBeenCalled();
        expect(inputComposerPersistenceSpies.clearTransientInputState).toHaveBeenCalledTimes(1);
        expect(findAgentInput(screen).props.value).toBe('');

        await screen.unmount();
    });

    it('restores the submitted draft when a direct handoff fails before durable acceptance', async () => {
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
        sendMessageSpy.mockImplementationOnce(async (...args: unknown[]) => {
            notifyLocalPendingProjection(args);
            throw new Error('send rejected');
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
            await pendingFireAndForget[0];
        });

        expect(sendMessageSpy).toHaveBeenCalledTimes(1);
        expect(inputComposerPersistenceSpies.restoreTransientInputState).toHaveBeenCalledTimes(1);
        expect(findAgentInput(screen).props.value).toBe('retry me');

        await screen.unmount();
    });

    it('enqueues when the send action explicitly requests the server pending queue', async () => {
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
                controlledByUser: false,
                capabilities: {
                    inFlightSteer: true,
                    inFlightSteerSupported: true,
                    inFlightSteerAvailable: true,
                },
            },
        };

        const screen = await renderSessionView({ routeServerId: 'server-cache' });
        pendingFireAndForget.length = 0;

        const agentInput = findAgentInput(screen);

        await act(async () => {
            agentInput.props.onChangeText('queue me');
        });
        await act(async () => {
            agentInput.props.onSend({ deliveryIntent: 'server_pending' });
        });

        expect(pendingFireAndForget.length).toBeGreaterThan(0);
        await act(async () => {
            await pendingFireAndForget[0];
        });

        expect(enqueuePendingMessageSpy).toHaveBeenCalledTimes(1);
        expect(enqueuePendingMessageSpy.mock.calls[0]?.[0]).toBe('s1');
        expect(enqueuePendingMessageSpy.mock.calls[0]?.[1]).toBe('queue me');
        expect(submitMessageSpy).not.toHaveBeenCalled();

        await screen.unmount();
    });

    it('retries resume from the warning banner and clears it on success', async () => {
        machineEncryptionAvailable.current = true;
        resumeSessionSpy
            .mockImplementationOnce(async () => ({
                type: 'error' as const,
                errorCode: 'DAEMON_RPC_UNAVAILABLE' as const,
                errorMessage: 'Daemon RPC is not available',
            }))
            .mockImplementationOnce(async () => ({ type: 'success' as const }));

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
            await pendingFireAndForget[0];
        });

        expect(resumeSessionSpy).toHaveBeenCalledTimes(1);
        expect(resumeCapabilityMachineIds).toContain('m-target');
        expect(modalMockState.current?.spies.alert).not.toHaveBeenCalled();

        await act(async () => {
            await screen.pressByTestIdAsync('session-pendingQueue-resumeFailed-retry');
        });

        expect(resumeSessionSpy).toHaveBeenCalledTimes(2);
        expect(modalMockState.current?.spies.alert).not.toHaveBeenCalled();
        expect(screen.findAllByTestId('session-pendingQueue-resumeFailed').length).toBe(0);

        await screen.unmount();
    });

    it('shows a retry error when the user explicitly retries resume from the banner', async () => {
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

        await act(async () => {
            await pendingFireAndForget[0];
        });

        expect(resumeCapabilityMachineIds).toContain('m-target');

        modalMockState.current?.spies.alert.mockClear();

        await act(async () => {
            await screen.pressByTestIdAsync('session-pendingQueue-resumeFailed-retry');
        });

        expect(modalMockState.current?.spies.alert).toHaveBeenCalledWith('common.error', 'Daemon RPC is not available');

        await screen.unmount();
    });

    it('redacts internal spawn validation details when explicit retry cannot resume the queued message', async () => {
        machineEncryptionAvailable.current = true;
        resumeSessionSpy
            .mockImplementationOnce(async () => ({
                type: 'error' as const,
                errorCode: 'DAEMON_RPC_UNAVAILABLE' as const,
                errorMessage: 'Daemon RPC is not available',
            }))
            .mockImplementationOnce(async () => ({
                type: 'error' as const,
                errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
                errorMessage: 'connected_service_materialization_identity_missing',
            }));

        const screen = await renderSessionView();

        pendingFireAndForget.length = 0;

        const agentInput = findAgentInput(screen);
        await act(async () => {
            agentInput.props.onChangeText('hello');
        });
        await act(async () => {
            agentInput.props.onSend();
        });

        await act(async () => {
            await pendingFireAndForget[0];
        });

        modalMockState.current?.spies.alert.mockClear();

        await act(async () => {
            await screen.pressByTestIdAsync('session-pendingQueue-resumeFailed-retry');
        });

        expect(modalMockState.current?.spies.alert).toHaveBeenCalledWith('common.error', 'session.resumeFailed');

        await screen.unmount();
    });

    it('uses the reachable machine target for replay resume when direct resume is unavailable', async () => {
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
        continueSessionWithReplaySpy.mockResolvedValue({
            type: 'success',
            sessionId: 's-replayed',
        });
        modalMockState.current?.spies.confirm.mockResolvedValue(true);
        modalMockState.current?.spies.alert.mockClear();

        const screen = await renderSessionView();

        await act(async () => {
            emitSessionResumeRequest('s1');
        });

        expect(resumeCapabilityMachineIds).toContain('m-target');
        expect(modalMockState.current?.spies.confirm).toHaveBeenCalledTimes(1);
        expect(continueSessionWithReplaySpy).toHaveBeenCalledTimes(1);
        expect(continueSessionWithReplaySpy).toHaveBeenCalledWith(
            expect.objectContaining({
                machineId: 'm-target',
                directory: '/tmp/target',
            }),
        );
        expect(modalMockState.current?.spies.alert).not.toHaveBeenCalled();

        await screen.unmount();
    });

    it('uses the cached owning server scope for auth, resume capabilities, installables, and resume when the route serverId is missing', async () => {
        const screen = await renderSessionView();

        await act(async () => {
            emitSessionResumeRequest('s1');
        });

        expect(cliDetectionServerIds).toContain('server-cache');
        expect(resumeCapabilityServerIds).toContain('server-cache');
        expect(ensureAgentInstallablesBackgroundSpy).toHaveBeenCalledWith(
            expect.objectContaining({ serverId: 'server-cache' }),
        );
        expect(resumeSessionSpy).toHaveBeenCalledWith(
            expect.objectContaining({ serverId: 'server-cache' }),
        );

        await screen.unmount();
    });
});
