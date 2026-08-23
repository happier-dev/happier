import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PluginProjectionV2Schema } from '@happier-dev/protocol';
import { findTestInstanceByTypeWithProps, invokeTestInstanceHandler, renderScreen } from '@/dev/testkit';
import {
    installSessionShellCommonModuleMocks,
    readSessionShellDraftTextForTest,
    resetSessionShellDraftStateForTest,
} from './sessionShellTestHelpers';
import { clearSessionAttachmentDrafts } from '@/components/sessions/attachments/sessionAttachmentDraftStore';
import {
    clearSessionDraftValuesForSession,
    readSessionDraftValue,
    writeSessionDraftValue,
} from '@/sync/domains/input/draftValues/sessionDraftValueStore';
import type { PendingMessage } from '@/sync/domains/state/storageTypes';
import type { SessionPending } from '@/sync/store/domains/pending';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).__DEV__ = false;
let authCredentials: any = { token: 't', secret: 's' };
const sessionState = vi.hoisted(() => ({
    session: {
        id: 's1',
        seq: 0,
        presence: 'offline',
        active: false,
        accessLevel: 'edit',
        metadata: {
            machineId: 'm1',
            flavor: 'codex',
            codexSessionId: 'codex-session-1',
            version: '0.0.0',
            path: '/tmp',
            homeDir: '/tmp',
        },
        agentState: {},
    } as any,
}));
const featureEnabledState = vi.hoisted(() => ({
    reviewComments: false,
}));
// The in-session Agent picker's armed intent, injected as a PRECONDITION. The
// picker's own arming logic has its own owner test; what these tests exercise is
// what `SessionView` does with an arm that already exists — specifically whether
// the send destination is resolved before anything starts an Agent.
const armedContinuationState = vi.hoisted(() => ({
    intent: null as any,
    localId: null as string | null,
    submission: null as any,
    submissionIntent: null as any,
}));
const clearArmedContinuationSpy = vi.hoisted(() => vi.fn());
const clearPersistedArmedContinuationSubmissionSpy = vi.hoisted(() => vi.fn(() => true));
const useFeatureEnabledSpy = vi.hoisted(() => vi.fn());
const useFeatureDecisionSpy = vi.hoisted(() => vi.fn());
const recordArmedContinuationSubmissionSpy = vi.hoisted(() => vi.fn((_submission: unknown) => true));
const runSessionAgentTransitionSpy = vi.hoisted(() => vi.fn(async (..._args: any[]) => ({
    type: 'accepted' as const,
    localId: 'agent-transition:armed-local-id',
})));
const daemonMergedProjectionState = vi.hoisted(() => ({
    value: { phase: 'idle', inputs: null } as any,
}));
const machinePluginComposerAttachmentPrepareMock = vi.hoisted(() => vi.fn());
const chooseSubmitModeState = vi.hoisted(() => ({
    mode: 'agent_queue',
}));
const reviewCommentDraftsState = vi.hoisted(() => ({
    current: [] as any[],
}));
// The canonical pending slice the transition's custody reader walks. Held as one
// stable object so a test can seed `s1` and the store mock still sees it.
const canonicalSessionPendingState = vi.hoisted(() => ({} as Record<string, SessionPending>));
const sessionPendingMessagesState = vi.hoisted(() => ({
    current: [] as any[],
    // Lets a case model the real ordering: the transition RPC answers first, and
    // the canonical pending row syncs afterwards, publishing a re-render.
    listeners: new Set<() => void>(),
}));
const deleteWorkspaceReviewCommentDraftSpy = vi.hoisted(() => vi.fn());

const pendingFireAndForget: Promise<unknown>[] = [];
const TEST_SERVER_ACCOUNT_SCOPE = null;

const resolveSessionComposerSendMock = vi.fn((..._args: any[]) => ({ kind: 'send', text: 'hello' }));
const chatListPropsSpy = vi.hoisted(() => vi.fn());

vi.mock('expo-linear-gradient', () => ({
    LinearGradient: 'LinearGradient',
}));
vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

const reactNativeRuntime = vi.hoisted(() => {
    class MockAnimatedValue {
        private value: number;
        constructor(value: number) {
            this.value = value;
        }
        setValue(value: number) {
            this.value = value;
        }
        interpolate(_config: unknown) {
            return 0;
        }
    }

    return { MockAnimatedValue };
});

vi.mock('react-native-safe-area-context', () => ({
    SafeAreaInsetsContext: React.createContext(null),
    SafeAreaProvider: ({ children }: { children?: React.ReactNode }) => children ?? null,
    initialWindowMetrics: null,
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('@react-navigation/native', () => ({
    useFocusEffect: () => {},
  useIsFocused: () => true,
}));

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ credentials: authCredentials }),
}));

vi.mock('@/components/sessions/transcript/AgentContentView', () => ({
    AgentContentView: (props: any) => React.createElement('AgentContentView', props, props.content ?? null, props.input ?? null),
}));
vi.mock('@/components/sessions/transcript/ChatHeaderView', () => ({
    ChatHeaderView: () => null,
}));
vi.mock('@/components/sessions/transcript/ChatList', () => ({
    ChatList: (props: any) => {
        chatListPropsSpy(props);
        return React.createElement('ChatList', props);
    },
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
vi.mock('@/components/sessions/attachments/AttachmentFilePicker', () => ({
    AttachmentFilePicker: () => null,
}));

vi.mock('@/components/sessions/files/useSessionFileUploadAvailability', () => ({
    useSessionFileUploadAvailability: () => true,
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (featureId: string, scope?: unknown) => {
        useFeatureEnabledSpy(featureId, scope);
        return featureId === 'attachments.uploads'
            || (featureId === 'files.reviewComments' && featureEnabledState.reviewComments);
    },
}));
vi.mock('@/hooks/server/useFeatureDecision', () => ({
    useFeatureDecision: (featureId: string, scope?: unknown) => {
        useFeatureDecisionSpy(featureId, scope);
        return { state: 'enabled' };
    },
}));

vi.mock('@/utils/platform/responsive', () => ({
    getDeviceType: () => 'phone',
    useDeviceType: () => 'phone',
    useHeaderHeight: () => 0,
    useIsLandscape: () => false,
    useIsTablet: () => false,
}));
vi.mock('@/components/sessions/model/inactiveSessionUi', () => ({
    getInactiveSessionUiState: () => ({ noticeKind: 'none', inactiveStatusTextKey: null, shouldShowInput: true }),
}));
vi.mock('@/components/sessions/model/resolveSessionMachineReachability', () => ({
    resolveSessionMachineReachability: () => true,
}));
vi.mock(
    '@/components/sessions/model/useSessionMachineReachability',
    async (importOriginal) => {
        const {
            createReachableSessionMachineReachability,
            createSessionMachineReachabilityModuleMock,
        } = await import('@/dev/testkit/mocks/sessionMachineReachability');
        return createSessionMachineReachabilityModuleMock({
            importOriginal,
            overrides: {
                useSessionMachineReachability: createReachableSessionMachineReachability,
                useSessionReachableMachineTarget: () => ({ machineId: 'm1', basePath: '/tmp' }),
            },
        });
    },
);

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => ({ serverId: 'server-1' }),
    subscribeActiveServer: () => () => {},
}));
vi.mock('@/agents/backendCatalog/useDaemonMergedProjectionInputs', () => ({
    useDaemonMergedProjectionInputs: () => daemonMergedProjectionState.value,
}));
vi.mock('@/sync/ops/machineContributionRegistryProjection', async (importOriginal) => {
    const actual = await importOriginal<any>();
    return {
        ...actual,
        machinePluginComposerAttachmentPrepare: (...args: unknown[]) => (
            machinePluginComposerAttachmentPrepareMock(...args)
        ),
    };
});
vi.mock('@/voice/session/voiceSession', () => ({
    useVoiceSessionSnapshot: () => ({ status: 'disconnected' }),
    voiceSessionManager: {},
}));

const sendMessageSpy = vi.fn(async (..._args: any[]) => {});
const enqueuePendingMessageSpy = vi.fn(async (..._args: any[]) => ({ localId: 'pending-local-id' }));
const updatePendingMessageSpy = vi.fn(async (..._args: any[]) => {});
const patchSessionMetadataWithRetrySpy = vi.fn(async (..._args: any[]) => {});

function setCurrentComposerAttachmentProjection(input: Readonly<{
    generation?: number;
    immutableGenerationId?: string;
}> = {}): void {
    const generation = input.generation ?? 7;
    const immutableGenerationId = input.immutableGenerationId ?? 'issue-generation-a';
    daemonMergedProjectionState.value = {
        phase: 'ready',
        inputs: {
            pluginProjectionById: {},
            pluginProjectionV2: PluginProjectionV2Schema.parse({
                v: 2,
                generation,
                installedPackagesById: {},
                agentsById: {},
                backendsById: {},
                actionsById: {},
                toolsById: {},
                commandsById: {},
                resourcesById: {},
                settingsById: {},
                familiesById: {
                    composerAttachments: {
                        family: 'composerAttachments',
                        entriesById: {
                            'acme.issues/issue': {
                                id: 'acme.issues/issue',
                                pluginId: 'acme.issues',
                                identity: { pluginId: 'acme.issues', localId: 'issue' },
                                immutableGenerationId,
                                definition: {
                                    id: 'issue',
                                    title: 'Issue',
                                    icon: 'warning',
                                    cardinality: 'many',
                                    valueSchema: { type: 'object' },
                                    preparedValueSchema: { type: 'object' },
                                    runtime: { prepareForSend: true },
                                },
                            },
                        },
                    },
                },
                diagnostics: [],
            }),
        },
    };
}

const ensureSessionVisibleSpy = vi.hoisted(() => vi.fn(async (..._args: any[]) => ({ kind: 'available' })));
const refreshSessionMessagesSpy = vi.hoisted(() => vi.fn(async (..._args: any[]) => {}));
vi.mock('@/sync/sync', () => ({
    sync: {
        markSessionViewed: async () => {},
        markSessionLiveTailIntent: () => {},
        fetchPendingMessages: async () => {},
        publishSessionPermissionModeToMetadata: async () => {},
        publishSessionAcpSessionModeOverrideToMetadata: async () => {},
        publishSessionAcpConfigOptionOverrideToMetadata: async () => {},
        publishSessionModelOverrideToMetadata: async () => {},
        refreshSessions: async () => {},
        // The canonical readers an indeterminate transition outcome reconciles
        // against. Both are real sync methods; the spies let a test observe that
        // reconciliation asks the canonical owners rather than inventing a status
        // operation of its own.
        ensureSessionVisibleForMessageRoute: (...args: any[]) => ensureSessionVisibleSpy(...args),
        refreshSessionMessages: (...args: any[]) => refreshSessionMessagesSpy(...args),
        onSessionVisible: () => {},
        getAcceptedExternalSessionTailCursor: () => null,
        subscribeAcceptedExternalSessionTailCursor: () => () => {},
        sendMessage: (...args: any[]) => sendMessageSpy(...args),
        enqueuePendingMessage: (...args: any[]) => enqueuePendingMessageSpy(...args),
        updatePendingMessage: (...args: any[]) => updatePendingMessageSpy(...args),
        patchSessionMetadataWithRetry: (...args: any[]) => patchSessionMetadataWithRetrySpy(...args),
        submitMessage: async () => {},
        encryption: {
            getMachineEncryption: () => null,
        },
    },
}));

const resumeSessionSpy = vi.fn(async (..._args: any[]) => ({ type: 'success' }));
const uploadSpy = vi.fn(async (..._args: any[]) => ({ success: true, path: 'p1', sizeBytes: 1, sha256: 'h1' }));

vi.mock('@/sync/ops', async (importOriginal) => {
    const actual = await importOriginal<any>();
    return {
        ...actual,
        sessionAbort: vi.fn(),
        resumeSession: (...args: any[]) => resumeSessionSpy(...args),
        sessionAttachmentsUploadFile: (...args: any[]) => uploadSpy(...args),
        machineCapabilitiesInvoke: vi.fn(async () => ({ type: 'success' })),
    };
});

vi.mock('@/sync/domains/transfers/ops/uploadSessionAttachment', () => ({
    sessionAttachmentsUploadFile: (...args: any[]) => uploadSpy(...args),
}));

vi.mock('@/sync/ops/actions/defaultActionExecutor', () => ({
    createDefaultActionExecutor: () => ({ execute: vi.fn() }),
}));

vi.mock('@/components/sessions/agentPicker/useInSessionAgentPickerControls', () => ({
    useInSessionAgentPickerControls: () => ({
        composeAgentPickerOptions: (options: unknown) => options,
        agentPickerSelectedOptionId: null,
        armedContinuation: armedContinuationState.intent,
        armedContinuationLocalId: armedContinuationState.localId,
        armedContinuationSubmission: armedContinuationState.submission,
        armedContinuationSubmissionIntent: armedContinuationState.submissionIntent,
        clearArmedContinuation: clearArmedContinuationSpy,
        clearArmedContinuationSubmissionIfCurrent: clearPersistedArmedContinuationSubmissionSpy,
        recordArmedContinuationSubmission: (...args: unknown[]) => {
            const recorded = recordArmedContinuationSubmissionSpy(args[0]);
            if (recorded) armedContinuationState.submission = args[0];
            return recorded;
        },
        onAgentPickerVisibilityChange: () => {},
    }),
}));
vi.mock('@/sync/ops/sessionAgentTransition', () => ({
    runSessionAgentTransitionOnMachine: (...args: any[]) => runSessionAgentTransitionSpy(...args),
}));

vi.mock('@/components/sessions/agentInput', () => ({
    AgentInput: (props: any) => React.createElement('AgentInput', props),
}));
vi.mock('@/components/appShell/panes/AppPaneScopeHost', () => ({
    AppPaneScopeHost: (props: any) => React.createElement('AppPaneScopeHost', props, props.main ?? null),
}));

const modalAlertSpy = vi.fn();

installSessionShellCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: 'View',
            Text: 'Text',
            Pressable: 'Pressable',
            ActivityIndicator: 'ActivityIndicator',
            AccessibilityInfo: {
                isReduceMotionEnabled: async () => false,
                addEventListener: () => ({ remove: () => {} }),
            },
            Animated: {
                View: 'Animated.View',
                Value: reactNativeRuntime.MockAnimatedValue,
                timing: (_value: unknown, _config: unknown) => ({ start: (cb?: () => void) => cb?.() }),
            },
            Easing: {
                bezier: (..._args: any[]) => (t: number) => t,
                linear: (t: number) => t,
            },
            Dimensions: {
                get: () => ({ width: 800, height: 600, scale: 2, fontScale: 1 }),
            },
            useWindowDimensions: () => ({ width: 1200, height: 800 }),
            Platform: {
                OS: 'ios',
                select: (spec: Record<string, unknown>) =>
                    spec && Object.prototype.hasOwnProperty.call(spec, 'ios') ? (spec as any).ios : (spec as any).default,
            },
        });
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
            theme: {
                dark: false,
                colors: {
                    text: '#000',
                    textSecondary: '#666',
                    textLink: '#00f',
                    surface: '#fff',
                    surfaceHigh: '#f5f5f5',
                    divider: '#ddd',
                    accent: {
                        blue: '#007AFF',
                        green: '#34C759',
                        orange: '#FF9500',
                        yellow: '#FFCC00',
                        red: '#FF3B30',
                        indigo: '#5856D6',
                        purple: '#AF52DE',
                    },
                    input: { background: '#f5f5f5' },
                    header: { tint: '#000' },
                    modal: { border: '#ddd' },
                    status: { error: '#f00' },
                    radio: { active: '#007AFF' },
                    shadow: { color: '#000', opacity: 0.2 },
                    groupped: { background: '#F5F5F5', chevron: '#C7C7CC', sectionTitle: '#8E8E93' },
                },
            },
        });
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        const routerMock = createExpoRouterMock({
            router: { push: vi.fn(), back: vi.fn() },
            pathname: '/',
        });
        return routerMock.module;
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                alert: (...args: any[]) => modalAlertSpy(...args),
                confirm: vi.fn(),
                prompt: vi.fn(),
            },
        }).module;
    },
    storage: async () => {
        const { createStorageModuleStub, createStorageStoreMock } = await import('@/dev/testkit/mocks/storage');
        const { settingsDefaults } = await import('@/sync/domains/settings/settings');
        return createStorageModuleStub({
            storage: createStorageStoreMock({
                    sessions: { s1: sessionState.session },
                    sessionPending: canonicalSessionPendingState,
                    machines: {
                        m1: {
                            id: 'm1',
                            seq: 0,
                            createdAt: 0,
                            updatedAt: 0,
                            active: true,
                            activeAt: 0,
                            metadata: {
                                host: 'happy-host',
                                platform: 'darwin',
                                happyCliVersion: '0.0.0',
                                happyHomeDir: '/tmp',
                                homeDir: '/tmp',
                            },
                            metadataVersion: 0,
                            daemonState: null,
                            daemonStateVersion: 0,
                        },
                    },
                    sessionListIndexByServerId: {},
                    settings: settingsDefaults,
                    deleteWorkspaceReviewCommentDraft: deleteWorkspaceReviewCommentDraftSpy,
            }),
            useSession: () => sessionState.session,
            // Keep the hook aligned with the same canonical session fixture used by useSession.
            useSessionMachineId: () => sessionState.session.metadata.machineId ?? null,
            useIsDataReady: () => true,
            useRealtimeStatus: () => ({ status: 'connected' }),
            useSessionMessages: () => ({ messages: [], isLoaded: true }),
            useSessionTranscriptIds: () => ({ ids: [], isLoaded: true }),
            useSessionPendingMessages: () => {
                const [, forceRender] = React.useState(0);
                React.useEffect(() => {
                    const listener = () => forceRender((value) => value + 1);
                    sessionPendingMessagesState.listeners.add(listener);
                    return () => {
                        sessionPendingMessagesState.listeners.delete(listener);
                    };
                }, []);
                return { messages: sessionPendingMessagesState.current, discarded: [] };
            },
            useSessionSubagentSourceMessages: () => [],
            useSessionReviewCommentsDrafts: () => [],
            useWorkspaceReviewCommentsDrafts: () => reviewCommentDraftsState.current,
            useSessionUsage: () => null,
            useSetting: () => null,
            useSettings: () => ({ experiments: true, featureToggles: {} }),
            useAutomations: () => [],
            useMachine: () => null,
            useLocalSetting: (key: string) => {
                if (key === 'acknowledgedCliVersions') return {};
                if (key === 'uiMultiPanePanelsEnabled') return false;
                if (key === 'detailsPaneTabsBehavior') return 'preview';
                if (key === 'rightPaneWidthPx') return 360;
                if (key === 'rightPaneWidthBasisPx') return 1200;
                if (key === 'detailsPaneWidthPx') return 520;
                if (key === 'detailsPaneWidthBasisPx') return 1200;
                return null;
            },
            useLocalSettingMutable: () => [null, vi.fn()],
            useSettingMutable: () => [null, vi.fn()],
        });
    },
});

vi.mock('@/hooks/server/useAutomationsSupport', () => ({
    useAutomationsSupport: () => ({ enabled: false }),
}));

vi.mock('@/utils/system/versionUtils', () => ({
    isVersionSupported: () => true,
    MINIMUM_CLI_VERSION: '0.0.0',
}));

vi.mock('@/agents/catalog/catalog', () => ({
    AGENT_IDS: ['codex'],
    DEFAULT_AGENT_ID: 'codex',
    buildResumeSessionExtrasFromUiState: () => null,
    getAgentCore: () => ({
        model: { defaultMode: 'default' },
        cli: { spawnAgent: 'codex' },
        localControl: { supported: true },
        resume: {
            vendorResumeIdField: 'codexSessionId',
            supportsVendorResume: true,
            experimental: true,
        },
        uiConnectedService: { serviceId: null, labelKey: 'agentInput.agent.codex', connectRoute: null },
    }),
    getAgentResumeExperimentsFromSettings: () => null,
    getNewSessionRelevantInstallableDepKeys: () => [],
    isBundledAgentId: (value: unknown) => value === 'codex',
    resolveAgentIdFromFlavor: () => 'codex',
}));

vi.mock('@/agents/hooks/useResumeCapabilityOptions', () => ({
    useResumeCapabilityOptions: () => ({ resumeCapabilityOptions: { accountSettings: { codexBackendMode: 'acp' } } }),
}));
vi.mock('@/agents/runtime/resumeCapabilities', async (importOriginal) => {
    return await importOriginal<any>();
});
vi.mock('@/hooks/server/useMachineCapabilitiesCache', async (importOriginal) => {
    const actual = await importOriginal<any>();
    return {
        ...actual,
        useMachineCapabilitiesCache: () => ({ state: { status: 'loaded', snapshot: { response: { results: [] } } } }),
        prefetchMachineCapabilities: vi.fn(),
        getMachineCapabilitiesSnapshot: vi.fn(),
    };
});
vi.mock('@/utils/sessions/sessionUtils', async (importOriginal) => {
    const actual = await importOriginal<any>();
    return {
        ...actual,
        useSessionStatus: () => ({ statusText: '', statusColor: '#000', statusDotColor: '#000' }),
        shouldShowAbortButtonForSessionState: () => false,
        getSessionAvatarId: () => '1',
        getSessionName: () => 'Session',
        listPendingPermissionRequests: () => [],
        listPendingUserActionRequests: () => [],
        formatPathRelativeToHome: () => '',
        getSessionSubtitle: () => '',
    };
});
vi.mock('@/utils/platform/platform', () => ({
    isRunningOnMac: () => false,
}));
vi.mock('@/utils/system/fireAndForget', () => ({
    fireAndForget: (p: any, opts?: { tag?: string }) => {
        const tag = typeof opts?.tag === 'string' ? opts.tag : '';
        // This test is validating the resumable attachment send flow; ignore unrelated
        // fire-and-forget work (analytics, mount-time prefetch, etc).
        if (tag === 'SessionView.composer.dispatch') {
            pendingFireAndForget.push(p);
        }
        return p;
    },
}));
vi.mock('@/sync/domains/input/slashCommands/resolveSessionComposerSend', () => ({
    resolveSessionComposerSend: (...args: any[]) => resolveSessionComposerSendMock(...args),
}));
vi.mock('@/sync/domains/input/slashCommands/executeSessionComposerResolution', () => ({
    executeSessionComposerResolution: vi.fn(),
}));
vi.mock('@/sync/domains/session/control/submitMode', () => ({
    decideSessionMessageDelivery: () => ({
        mode: chooseSubmitModeState.mode,
        intent: 'default',
        reason: 'test_decision',
        pendingSupportState: 'supported',
        ...(chooseSubmitModeState.mode === 'agent_queue'
            ? { directBypassReason: 'selected_direct' }
            : chooseSubmitModeState.mode === 'interrupt'
                ? { directBypassReason: 'interrupt' }
                : {}),
    }),
    chooseSubmitMode: () => chooseSubmitModeState.mode,
    chooseForceImmediateSubmitMode: () => chooseSubmitModeState.mode,
    canDirectSubmitUserMessageNow: () => true,
    getPendingQueueSubmitSupportState: () => 'supported',
    isPendingQueueSubmitKnownUnsupported: () => false,
}));
vi.mock('@/sync/domains/session/control/localControlSwitch', () => ({
    shouldRenderChatTimelineForSession: () => true,
    shouldRequestRemoteControl: () => false,
    shouldRequestRemoteControlAfterPendingEnqueue: () => false,
}));
vi.mock('@/sync/acp/sessionModeControl', () => ({
    supportsSessionModeOverrides: () => false,
}));
vi.mock('@/sync/domains/sessionControl/sessionModeControl', () => ({
    supportsSessionModeOverrides: () => false,
}));
vi.mock('@/sync/ops/sessionSwitch', () => ({
    sessionSwitch: vi.fn(),
}));
vi.mock('@/sync/domains/automations/automationSessionLink', () => ({
    countEnabledAutomationsLinkedToSession: () => 0,
}));

const {
    applyComposerPresentationTransaction,
    createComposerPresentationTransactionApplier,
    createComposerPresentationHostHandlers,
    readComposerPresentationSnapshot,
} = await import('@/components/sessions/presentation/sessionComposerPresentationTargets');
const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
const { getInactiveSessionUiState } = await import('@/components/sessions/model/inactiveSessionUi');
const { SessionView } = await import('./SessionView');

describe('SessionView (attachments.uploads resumable send)', () => {
    beforeEach(() => {
        chooseSubmitModeState.mode = 'agent_queue';
        clearSessionAttachmentDrafts('s1');
        sendMessageSpy.mockClear();
        enqueuePendingMessageSpy.mockClear();
        updatePendingMessageSpy.mockClear();
        patchSessionMetadataWithRetrySpy.mockClear();
        machinePluginComposerAttachmentPrepareMock.mockReset();
        daemonMergedProjectionState.value = { phase: 'idle', inputs: null };
        resumeSessionSpy.mockClear();
        uploadSpy.mockClear();
        modalAlertSpy.mockClear();
        resolveSessionComposerSendMock.mockClear();
        chatListPropsSpy.mockClear();
        deleteWorkspaceReviewCommentDraftSpy.mockClear();
        reviewCommentDraftsState.current = [];
        sessionPendingMessagesState.current = [];
        sessionPendingMessagesState.listeners.clear();
        for (const key of Object.keys(canonicalSessionPendingState)) delete canonicalSessionPendingState[key];
        armedContinuationState.intent = null;
        armedContinuationState.localId = null;
        armedContinuationState.submission = null;
        armedContinuationState.submissionIntent = null;
        clearArmedContinuationSpy.mockClear();
        clearPersistedArmedContinuationSubmissionSpy.mockClear();
        recordArmedContinuationSubmissionSpy.mockClear();
        runSessionAgentTransitionSpy.mockClear();
        useFeatureEnabledSpy.mockClear();
        useFeatureDecisionSpy.mockClear();
        sessionState.session.seq = 0;
        resetSessionShellDraftStateForTest();
        clearSessionDraftValuesForSession(TEST_SERVER_ACCOUNT_SCOPE, 's1', { reason: 'composerClear' });
        // The armed continuation has the same composer-clear lifetime as its
        // sibling routing fields; session deletion is still an idempotent
        // second cleanup path.
        clearSessionDraftValuesForSession(TEST_SERVER_ACCOUNT_SCOPE, 's1', { reason: 'sessionDelete' });
        pendingFireAndForget.length = 0;
    });

    it('restores unsent attachment drafts when the session input remounts', async () => {
        featureEnabledState.reviewComments = false;
        sendMessageSpy.mockClear();
        resumeSessionSpy.mockClear();
        uploadSpy.mockClear();
        modalAlertSpy.mockClear();
        resolveSessionComposerSendMock.mockClear();
        reviewCommentDraftsState.current = [];
        deleteWorkspaceReviewCommentDraftSpy.mockClear();
        pendingFireAndForget.length = 0;

        let firstTree: renderer.ReactTestRenderer | undefined;
        let secondTree: renderer.ReactTestRenderer | undefined;
        try {
            firstTree = (await renderScreen(<AppPaneProvider>
                        <SessionView id="s1" />
                    </AppPaneProvider>)).tree;

            const renderedFirstTree = firstTree;
            expect(renderedFirstTree).toBeDefined();
            if (!renderedFirstTree) throw new Error('SessionView test renderer did not mount');

            let agentInput = findTestInstanceByTypeWithProps(renderedFirstTree, 'AgentInput' as any, {}) as any;
            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onAttachmentsAdded', [
                    { name: 'draft-note.txt', size: 1, type: 'text/plain', slice: () => new Blob([new Uint8Array([97])]) } as any,
                ], 'AgentInput');
            });

            agentInput = findTestInstanceByTypeWithProps(renderedFirstTree, 'AgentInput' as any, {}) as any;
            expect(agentInput.props.attachmentRowItems).toEqual([
                expect.objectContaining({ label: 'draft-note.txt', status: 'pending' }),
            ]);

            act(() => {
                firstTree?.unmount();
            });
            firstTree = undefined;

            secondTree = (await renderScreen(<AppPaneProvider>
                        <SessionView id="s1" />
                    </AppPaneProvider>)).tree;
            const renderedSecondTree = secondTree;
            expect(renderedSecondTree).toBeDefined();
            if (!renderedSecondTree) throw new Error('SessionView test renderer did not remount');

            agentInput = findTestInstanceByTypeWithProps(renderedSecondTree, 'AgentInput' as any, {}) as any;
            expect(agentInput.props.attachmentRowItems).toEqual([
                expect.objectContaining({ label: 'draft-note.txt', status: 'pending' }),
            ]);
        } finally {
            act(() => {
                firstTree?.unmount();
                secondTree?.unmount();
            });
            pendingFireAndForget.length = 0;
        }
    });

    it('hydrates recoverable attachment drafts so retry can reuse uploaded files', async () => {
        sendMessageSpy.mockClear();
        resumeSessionSpy.mockClear();
        uploadSpy.mockClear();
        modalAlertSpy.mockClear();
        resolveSessionComposerSendMock.mockClear();
        pendingFireAndForget.length = 0;

        let tree: renderer.ReactTestRenderer | undefined;
        try {
            tree = (await renderScreen(<AppPaneProvider>
                        <SessionView
                            id="s1"
                            initialAttachmentDrafts={[{
                                id: 'draft-retry',
                                source: {
                                    kind: 'native',
                                    uri: 'file:///tmp/retry.txt',
                                    name: 'retry.txt',
                                    sizeBytes: 1,
                                    mimeType: 'text/plain',
                                },
                                status: 'uploaded',
                                uploadedPath: 'p1',
                                uploadedSizeBytes: 1,
                                uploadedMimeType: 'text/plain',
                                sha256: 'h1',
                            }]}
                        />
                    </AppPaneProvider>)).tree;

            pendingFireAndForget.length = 0;

            const renderedTree = tree;
            expect(renderedTree).toBeDefined();
            if (!renderedTree) throw new Error('SessionView test renderer did not mount');

            const agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;

            expect(agentInput.props.attachmentRowItems).toEqual(expect.arrayContaining([
                expect.objectContaining({
                    key: 'draft-retry',
                    label: 'retry.txt',
                    status: 'uploaded',
                }),
            ]));

            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onSend', undefined, 'AgentInput');
            });

            expect(pendingFireAndForget.length).toBe(1);
            await pendingFireAndForget[0];

            expect(uploadSpy).not.toHaveBeenCalled();
            expect(sendMessageSpy).toHaveBeenCalledTimes(1);

            const [sentSessionId, sentText, sentDisplayText, sentMetaOverrides] = sendMessageSpy.mock.calls[0] ?? [];
            expect(sentSessionId).toBe('s1');
            expect(String(sentText)).toContain('[attachments]');
            expect(String(sentText)).toContain('- p1');
            expect(String(sentText)).toContain('retry.txt');
            expect(sentDisplayText).toBe('hello');
            expect(sentMetaOverrides).toMatchObject({
                happier: {
                    kind: 'attachments.v1',
                    payload: {
                        attachments: [
                            expect.objectContaining({
                                name: 'retry.txt',
                                path: 'p1',
                                mimeType: 'text/plain',
                                sizeBytes: 1,
                                sha256: 'h1',
                            }),
                        ],
                    },
                },
            });
        } finally {
            act(() => {
                tree?.unmount();
            });
            pendingFireAndForget.length = 0;
        }
    });

    it('resumes and queues attachments when chooseSubmitMode selects server_pending', async () => {
        expect(getInactiveSessionUiState({ isSessionActive: true, isResumable: true, isMachineOnline: true })).toMatchObject({ shouldShowInput: true });

        chooseSubmitModeState.mode = 'server_pending';
        featureEnabledState.reviewComments = false;
        sendMessageSpy.mockClear();
        enqueuePendingMessageSpy.mockClear();
        resumeSessionSpy.mockClear();
        uploadSpy.mockClear();
        modalAlertSpy.mockClear();
        resolveSessionComposerSendMock.mockClear();
        reviewCommentDraftsState.current = [];
        deleteWorkspaceReviewCommentDraftSpy.mockClear();
        pendingFireAndForget.length = 0;

        let tree: renderer.ReactTestRenderer | undefined;
        try {
            tree = (await renderScreen(<AppPaneProvider>
                        <SessionView id="s1" />
                    </AppPaneProvider>)).tree;

            // Ignore mount-time fire-and-forget work; we only care about the send flow.
            pendingFireAndForget.length = 0;

            const renderedTree = tree;
            expect(renderedTree).toBeDefined();
            if (!renderedTree) throw new Error('SessionView test renderer did not mount');

            const agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onAttachmentsAdded', [
                    { name: 'a.txt', size: 1, type: 'text/plain', slice: () => new Blob([new Uint8Array([97])]) } as any,
                ], 'AgentInput');
            });

            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onSend', undefined, 'AgentInput');
            });

            expect(pendingFireAndForget.length).toBe(1);
            await pendingFireAndForget[0];

            // Should not show the legacy "attachments require direct sending" error anymore.
            expect(modalAlertSpy.mock.calls.some((c) => String(c?.[1] ?? '').includes('Attachments require direct sending'))).toBe(false);
            expect(resumeSessionSpy).toHaveBeenCalled();
            expect(uploadSpy).toHaveBeenCalled();
            expect(sendMessageSpy).not.toHaveBeenCalled();
            expect(enqueuePendingMessageSpy).toHaveBeenCalledTimes(1);

            const [sentSessionId, sentText, sentDisplayText, sentMetaOverrides] = enqueuePendingMessageSpy.mock.calls[0] ?? [];
            expect(sentSessionId).toBe('s1');
            expect(String(sentText)).toContain('[attachments]');
            expect(String(sentText)).toContain('- p1');
            expect(String(sentText)).toContain('a.txt');
            expect(sentDisplayText).toBe('hello');
            expect(sentMetaOverrides).toMatchObject({
                happier: {
                    kind: 'attachments.v1',
                    payload: {
                        attachments: [
                            {
                                name: 'a.txt',
                                path: 'p1',
                                mimeType: 'text/plain',
                                sizeBytes: 1,
                                sha256: 'h1',
                            },
                        ],
                    },
                },
            });
        } finally {
            act(() => {
                tree?.unmount();
            });
            pendingFireAndForget.length = 0;
        }
    });

    it('edits a queued message from what the transcript showed, not the expanded transport text', async () => {
        const queuedMessage: PendingMessage = {
            id: 'p-display',
            localId: 'p-display',
            text: 'Review these\n\n<review-comments>\nsrc/a.ts:1 fix it\n</review-comments>',
            displayText: 'Review these',
            createdAt: 0,
            updatedAt: 0,
            deliveryStatus: 'accepted',
            rawRecord: {},
        };
        sessionPendingMessagesState.current = [queuedMessage];

        let tree: renderer.ReactTestRenderer | undefined;
        try {
            tree = (await renderScreen(<AppPaneProvider>
                        <SessionView id="s1" />
                    </AppPaneProvider>)).tree;

            const renderedTree = tree;
            expect(renderedTree).toBeDefined();
            if (!renderedTree) throw new Error('SessionView test renderer did not mount');

            expect(chatListPropsSpy).toHaveBeenCalled();
            const chatListProps = chatListPropsSpy.mock.calls.at(-1)?.[0];
            expect(chatListProps?.onEditPendingMessage).toEqual(expect.any(Function));

            await act(async () => {
                await chatListProps.onEditPendingMessage({
                    id: 'p-display',
                    text: queuedMessage.text,
                    displayText: queuedMessage.displayText,
                    message: queuedMessage,
                });
            });

            const agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            expect(agentInput.props.value).toBe('Review these');
        } finally {
            act(() => {
                tree?.unmount();
            });
            pendingFireAndForget.length = 0;
        }
    });

    it('restores the previous draft when a pending edit is abandoned by unmounting the session view', async () => {
        const queuedMessage: PendingMessage = {
            id: 'p-edit',
            localId: 'p-edit',
            text: 'Queued edit text',
            displayText: 'Queued edit text',
            createdAt: 0,
            updatedAt: 0,
            deliveryStatus: 'accepted',
            rawRecord: {},
        };
        sessionPendingMessagesState.current = [queuedMessage];

        let tree: renderer.ReactTestRenderer | undefined;
        try {
            tree = (await renderScreen(<AppPaneProvider>
                        <SessionView id="s1" />
                    </AppPaneProvider>)).tree;

            const renderedTree = tree;
            expect(renderedTree).toBeDefined();
            if (!renderedTree) throw new Error('SessionView test renderer did not mount');

            let agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onChangeText', 'Existing draft', 'AgentInput');
            });

            expect(chatListPropsSpy).toHaveBeenCalled();
            const chatListProps = chatListPropsSpy.mock.calls.at(-1)?.[0];
            expect(chatListProps?.onEditPendingMessage).toEqual(expect.any(Function));

            await act(async () => {
                await chatListProps.onEditPendingMessage({
                    id: 'p-edit',
                    text: 'Queued edit text',
                    displayText: 'Queued edit text',
                    message: queuedMessage,
                });
            });

            expect(readComposerPresentationSnapshot({ kind: 'session', sessionId: 's1' })).toMatchObject({
                ref: { kind: 'session', sessionId: 's1' },
                text: 'Existing draft',
            });
            expect(readComposerPresentationSnapshot({
                kind: 'pendingMessage',
                sessionId: 's1',
                localId: 'p-edit',
            })).toMatchObject({
                ref: { kind: 'pendingMessage', sessionId: 's1', localId: 'p-edit' },
                text: 'Queued edit text',
            });

            agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            expect(agentInput.props.value).toBe('Queued edit text');
            expect(readSessionShellDraftTextForTest('s1')).toBe('Existing draft');

            act(() => {
                tree?.unmount();
            });
            tree = undefined;

            expect(readSessionShellDraftTextForTest('s1')).toBe('Existing draft');
        } finally {
            act(() => {
                tree?.unmount();
            });
            pendingFireAndForget.length = 0;
        }
    });

    it('routes active and focus to the current session or pending scope through its mounted input', async () => {
        const queuedMessage: PendingMessage = {
            id: 'p-edit',
            localId: 'p-edit',
            text: 'Queued edit text',
            displayText: 'Queued edit text',
            createdAt: 0,
            updatedAt: 0,
            deliveryStatus: 'accepted',
            rawRecord: {},
        };
        sessionPendingMessagesState.current = [queuedMessage];
        const focus = vi.fn();
        const sessionRef = { kind: 'session' as const, sessionId: 's1' };
        const pendingRef = { kind: 'pendingMessage' as const, sessionId: 's1', localId: 'p-edit' };
        const handlers = createComposerPresentationHostHandlers({
            owner: {
                identity: { pluginId: 'acme.fixture', localId: 'composer-tools' },
                immutableGenerationId: 'generation-1',
                surfaceInstanceKey: 'mounted-1',
            },
        });
        const request = (method: 'activeComposer' | 'focusComposer', payload?: unknown) => ({
            version: 1,
            requestId: `request:${method}`,
            surface: {
                pluginId: 'acme.fixture',
                contributionId: 'composer-tools',
                surfaceId: 'composer-tools:mounted',
                placement: 'composerSurface',
                platform: 'web',
                channel: 'internal',
                resourceScope: [],
                diagnostics: [],
            },
            method,
            ...(payload === undefined ? {} : { payload }),
        }) as never;

        let tree: renderer.ReactTestRenderer | undefined;
        try {
            tree = (await renderScreen(<AppPaneProvider>
                <SessionView id="s1" />
            </AppPaneProvider>)).tree;
            if (!tree) throw new Error('SessionView test renderer did not mount');

            let agentInput = findTestInstanceByTypeWithProps(tree, 'AgentInput' as any, {}) as any;
            expect(agentInput.props.onComposerFocusChange).toEqual(expect.any(Function));
            expect(agentInput.props.onComposerFocusRequestChange).toEqual(expect.any(Function));
            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onComposerFocusRequestChange', focus, 'AgentInput');
                invokeTestInstanceHandler(agentInput, 'onComposerFocusChange', true, 'AgentInput');
            });

            expect(handlers.activeComposer!(request('activeComposer'))).toEqual(sessionRef);
            expect(handlers.focusComposer!(request('focusComposer', { ref: sessionRef })))
                .toEqual({ status: 'focused' });
            expect(focus).toHaveBeenCalledTimes(1);

            const chatListProps = chatListPropsSpy.mock.calls.at(-1)?.[0];
            expect(chatListProps?.onEditPendingMessage).toEqual(expect.any(Function));
            await act(async () => {
                await chatListProps.onEditPendingMessage({
                    id: 'p-edit',
                    text: 'Queued edit text',
                    displayText: 'Queued edit text',
                    message: queuedMessage,
                });
            });

            agentInput = findTestInstanceByTypeWithProps(tree, 'AgentInput' as any, {}) as any;
            expect(agentInput.props.value).toBe('Queued edit text');
            expect(handlers.activeComposer!(request('activeComposer'))).toEqual(pendingRef);
            expect(handlers.focusComposer!(request('focusComposer', { ref: sessionRef })))
                .toEqual({ status: 'notEditable' });
            expect(handlers.focusComposer!(request('focusComposer', { ref: pendingRef })))
                .toEqual({ status: 'focused' });
            expect(focus).toHaveBeenCalledTimes(2);
        } finally {
            await act(async () => {
                handlers.dispose();
                tree?.unmount();
            });
            pendingFireAndForget.length = 0;
        }
    });

    it('projects decorations and edit locks only through the active pending-message input', async () => {
        const queuedMessage: PendingMessage = {
            id: 'p-edit',
            localId: 'p-edit',
            text: 'Queued edit text',
            displayText: 'Queued edit text',
            createdAt: 0,
            updatedAt: 0,
            deliveryStatus: 'accepted',
            rawRecord: {},
        };
        sessionPendingMessagesState.current = [queuedMessage];
        const pendingRef = { kind: 'pendingMessage' as const, sessionId: 's1', localId: 'p-edit' };
        const handlers = createComposerPresentationHostHandlers({
            owner: {
                identity: { pluginId: 'acme.fixture', localId: 'composer-tools' },
                immutableGenerationId: 'generation-1',
                surfaceInstanceKey: 'mounted-1',
            },
        });
        const request = (method: 'setComposerDecorations' | 'acquireComposerInputLock', payload: unknown) => ({
            version: 1,
            requestId: `request:${method}`,
            surface: {
                pluginId: 'acme.fixture',
                contributionId: 'composer-tools',
                surfaceId: 'composer-tools:mounted',
                placement: 'composerSurface',
                platform: 'web',
                channel: 'internal',
                resourceScope: [],
                diagnostics: [],
            },
            method,
            payload,
        }) as never;

        let tree: renderer.ReactTestRenderer | undefined;
        try {
            tree = (await renderScreen(<AppPaneProvider>
                <SessionView id="s1" />
            </AppPaneProvider>)).tree;
            if (!tree) throw new Error('SessionView test renderer did not mount');

            const chatListProps = chatListPropsSpy.mock.calls.at(-1)?.[0];
            expect(chatListProps?.onEditPendingMessage).toEqual(expect.any(Function));
            await act(async () => {
                await chatListProps.onEditPendingMessage({
                    id: 'p-edit',
                    text: 'Queued edit text',
                    displayText: 'Queued edit text',
                    message: queuedMessage,
                });
            });

            const snapshot = readComposerPresentationSnapshot(pendingRef);
            expect(snapshot).not.toBeNull();
            if (!snapshot) throw new Error('expected mounted pending-message composer target');
            await act(async () => {
                expect(handlers.setComposerDecorations!(request('setComposerDecorations', {
                    ref: pendingRef,
                    key: 'pending-review',
                    decorations: {
                        revision: snapshot.revision,
                        ranges: [{ range: { start: 0, end: 1 }, treatment: 'warning' }],
                    },
                }))).toEqual({ status: 'set' });
            });
            let agentInput = findTestInstanceByTypeWithProps(tree, 'AgentInput' as any, {}) as any;
            expect(agentInput.props.composerDecorations).toEqual([
                expect.objectContaining({ key: 'pending-review' }),
            ]);

            await act(async () => {
                expect(handlers.acquireComposerInputLock!(request('acquireComposerInputLock', {
                    subscriptionId: 'lock-1',
                    ref: pendingRef,
                    request: { reason: 'Review required', mode: 'editAndSubmit' },
                }))).toBeNull();
            });
            agentInput = findTestInstanceByTypeWithProps(tree, 'AgentInput' as any, {}) as any;
            expect(agentInput.props.composerInputLock).toEqual({
                mode: 'editAndSubmit',
                reasons: ['Review required'],
            });
            expect(agentInput.props.disabled).toBe(true);
            expect(agentInput.props.isSendDisabled).toBe(true);
            expect(readComposerPresentationSnapshot(pendingRef)?.state).toMatchObject({
                editable: false,
                submittable: false,
                inputLock: { mode: 'editAndSubmit', reasons: ['Review required'] },
            });
        } finally {
            act(() => {
                handlers.dispose();
                tree?.unmount();
            });
            pendingFireAndForget.length = 0;
        }
    });

    it('restores non-text composer drafts when a modified pending edit row disappears', async () => {
        const queuedMessage: PendingMessage = {
            id: 'p-edit',
            localId: 'p-edit',
            text: 'Queued edit text',
            displayText: 'Queued edit text',
            createdAt: 0,
            updatedAt: 0,
            deliveryStatus: 'accepted',
            rawRecord: {},
        };
        sessionPendingMessagesState.current = [queuedMessage];
        writeSessionDraftValue(
            TEST_SERVER_ACCOUNT_SCOPE,
            's1',
            'routing.executionRunDelivery',
            'interrupt',
        );

        let refreshPendingMessages!: () => void;
        const PendingMessageHarness = () => {
            const [refresh, setRefresh] = React.useState(0);
            refreshPendingMessages = () => setRefresh((current) => current + 1);
            return <AppPaneProvider>
                <SessionView
                    id="s1"
                    jumpToSeq={refresh}
                    initialAttachmentDrafts={[{
                        id: 'draft-note',
                        source: {
                            kind: 'native',
                            uri: 'file:///tmp/draft-note.txt',
                            name: 'draft-note.txt',
                            sizeBytes: 1,
                            mimeType: 'text/plain',
                        },
                        status: 'pending',
                    }]}
                />
            </AppPaneProvider>;
        };
        let tree: renderer.ReactTestRenderer | undefined;
        try {
            tree = (await renderScreen(<PendingMessageHarness />)).tree;

            const renderedTree = tree;
            expect(renderedTree).toBeDefined();
            if (!renderedTree) throw new Error('SessionView test renderer did not mount');

            let agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            expect(agentInput.props.attachmentRowItems).toEqual([
                expect.objectContaining({ label: 'draft-note.txt', status: 'pending' }),
            ]);

            const chatListProps = chatListPropsSpy.mock.calls.at(-1)?.[0];
            expect(chatListProps?.onEditPendingMessage).toEqual(expect.any(Function));

            await act(async () => {
                await chatListProps.onEditPendingMessage({
                    id: 'p-edit',
                    text: 'Queued edit text',
                    displayText: 'Queued edit text',
                    message: queuedMessage,
                });
            });

            agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            expect(agentInput.props.value).toBe('Queued edit text');
            expect(agentInput.props.attachmentRowItems).toEqual([]);
            expect(readSessionDraftValue(
                TEST_SERVER_ACCOUNT_SCOPE,
                's1',
                'routing.executionRunDelivery',
            )).toBe('interrupt');

            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onChangeText', 'Edited queued text', 'AgentInput');
            });

            agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            expect(agentInput.props.value).toBe('Edited queued text');

            sessionPendingMessagesState.current = [];
            await act(async () => {
                refreshPendingMessages();
                await Promise.resolve();
            });

            expect(readComposerPresentationSnapshot({
                kind: 'pendingMessage',
                sessionId: 's1',
                localId: queuedMessage.localId!,
            })).toBeNull();
            agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            expect(agentInput.props.value).toBe('');
            expect(agentInput.props.attachmentRowItems).toEqual([
                expect.objectContaining({ label: 'draft-note.txt', status: 'pending' }),
            ]);
            expect(readSessionDraftValue(
                TEST_SERVER_ACCOUNT_SCOPE,
                's1',
                'routing.executionRunDelivery',
            )).toBe('interrupt');
            expect(agentInput.props.statusBadges?.some((badge: any) => badge.key === 'pending-message-edit')).toBe(false);
        } finally {
            act(() => {
                tree?.unmount();
            });
            pendingFireAndForget.length = 0;
        }
    });

    it('does not overwrite a later same-text revision when a pending edit row disappears', async () => {
        const queuedMessage: PendingMessage = {
            id: 'p-edit-same-text-disappears',
            localId: 'p-edit-same-text-disappears',
            text: 'Queued edit text',
            displayText: 'Queued edit text',
            createdAt: 0,
            updatedAt: 0,
            deliveryStatus: 'accepted',
            rawRecord: {},
        };
        sessionPendingMessagesState.current = [queuedMessage];

        let refreshPendingMessages!: () => void;
        const PendingMessageHarness = () => {
            const [refresh, setRefresh] = React.useState(0);
            refreshPendingMessages = () => setRefresh((current) => current + 1);
            return <AppPaneProvider>
                <SessionView id="s1" jumpToSeq={refresh} />
            </AppPaneProvider>;
        };
        let tree: renderer.ReactTestRenderer | undefined;
        try {
            tree = (await renderScreen(<PendingMessageHarness />)).tree;

            const renderedTree = tree;
            if (!renderedTree) throw new Error('SessionView test renderer did not mount');
            let agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onChangeText', 'Existing draft', 'AgentInput');
            });

            const chatListProps = chatListPropsSpy.mock.calls.at(-1)?.[0];
            await act(async () => {
                await chatListProps.onEditPendingMessage({
                    id: queuedMessage.id,
                    text: queuedMessage.text,
                    displayText: queuedMessage.displayText,
                    message: queuedMessage,
                });
            });

            agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onChangeText', 'Temporary edit', 'AgentInput');
                invokeTestInstanceHandler(agentInput, 'onChangeText', queuedMessage.text, 'AgentInput');
            });

            sessionPendingMessagesState.current = [];
            await act(async () => {
                refreshPendingMessages();
                await Promise.resolve();
            });
            await act(async () => {
                refreshPendingMessages();
                await Promise.resolve();
            });

            expect(readComposerPresentationSnapshot({
                kind: 'pendingMessage',
                sessionId: 's1',
                localId: queuedMessage.localId!,
            })).toBeNull();
            agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            expect(agentInput.props.value).toBe('Existing draft');
            expect(readSessionShellDraftTextForTest('s1')).toBe('Existing draft');
        } finally {
            act(() => {
                tree?.unmount();
            });
            pendingFireAndForget.length = 0;
        }
    });

    it('restores unchanged prior semantic fields without overwriting a field changed during a pending edit', async () => {
        const queuedMessage: PendingMessage = {
            id: 'p-edit-semantic-fields',
            localId: 'p-edit-semantic-fields',
            text: 'Queued edit text',
            displayText: 'Queued edit text',
            createdAt: 0,
            updatedAt: 0,
            deliveryStatus: 'accepted',
            rawRecord: {},
        };
        const priorRecipient = { kind: 'execution_run' as const, runId: 'run-a' };
        sessionPendingMessagesState.current = [queuedMessage];
        writeSessionDraftValue(
            TEST_SERVER_ACCOUNT_SCOPE,
            's1',
            'routing.recipient',
            priorRecipient,
        );
        writeSessionDraftValue(
            TEST_SERVER_ACCOUNT_SCOPE,
            's1',
            'routing.executionRunDelivery',
            'interrupt',
        );

        let tree: renderer.ReactTestRenderer | undefined;
        try {
            tree = (await renderScreen(<AppPaneProvider>
                <SessionView id="s1" />
            </AppPaneProvider>)).tree;

            const renderedTree = tree;
            expect(renderedTree).toBeDefined();
            if (!renderedTree) throw new Error('SessionView test renderer did not mount');

            const chatListProps = chatListPropsSpy.mock.calls.at(-1)?.[0];
            expect(chatListProps?.onEditPendingMessage).toEqual(expect.any(Function));
            await act(async () => {
                await chatListProps.onEditPendingMessage({
                    id: queuedMessage.id,
                    text: queuedMessage.text,
                    displayText: queuedMessage.displayText,
                    message: queuedMessage,
                });
            });

            // This store write models the user selecting a new delivery mode while
            // the queued row owns the text editor. The recipient remains empty.
            writeSessionDraftValue(
                TEST_SERVER_ACCOUNT_SCOPE,
                's1',
                'routing.executionRunDelivery',
                'prompt',
            );
            sessionPendingMessagesState.current = [];
            await act(async () => {
                renderedTree.update(<AppPaneProvider>
                    <SessionView id="s1" />
                </AppPaneProvider>);
                await Promise.resolve();
            });

            expect(readSessionDraftValue(
                TEST_SERVER_ACCOUNT_SCOPE,
                's1',
                'routing.recipient',
            )).toEqual(priorRecipient);
            expect(readSessionDraftValue(
                TEST_SERVER_ACCOUNT_SCOPE,
                's1',
                'routing.executionRunDelivery',
            )).toBe('prompt');
        } finally {
            act(() => {
                tree?.unmount();
            });
            pendingFireAndForget.length = 0;
        }
    });

    it('restores non-text composer drafts when a modified pending edit is abandoned by unmounting', async () => {
        const queuedMessage: PendingMessage = {
            id: 'p-edit',
            localId: 'p-edit',
            text: 'Queued edit text',
            displayText: 'Queued edit text',
            createdAt: 0,
            updatedAt: 0,
            deliveryStatus: 'accepted',
            rawRecord: {},
        };
        sessionPendingMessagesState.current = [queuedMessage];
        writeSessionDraftValue(
            TEST_SERVER_ACCOUNT_SCOPE,
            's1',
            'routing.executionRunDelivery',
            'interrupt',
        );

        let firstTree: renderer.ReactTestRenderer | undefined;
        let secondTree: renderer.ReactTestRenderer | undefined;
        try {
            firstTree = (await renderScreen(<AppPaneProvider>
                        <SessionView
                            id="s1"
                            initialAttachmentDrafts={[{
                                id: 'draft-note',
                                source: {
                                    kind: 'native',
                                    uri: 'file:///tmp/draft-note.txt',
                                    name: 'draft-note.txt',
                                    sizeBytes: 1,
                                    mimeType: 'text/plain',
                                },
                                status: 'pending',
                            }]}
                        />
                    </AppPaneProvider>)).tree;

            const renderedFirstTree = firstTree;
            expect(renderedFirstTree).toBeDefined();
            if (!renderedFirstTree) throw new Error('SessionView test renderer did not mount');

            let agentInput = findTestInstanceByTypeWithProps(renderedFirstTree, 'AgentInput' as any, {}) as any;
            expect(agentInput.props.attachmentRowItems).toEqual([
                expect.objectContaining({ label: 'draft-note.txt', status: 'pending' }),
            ]);

            const chatListProps = chatListPropsSpy.mock.calls.at(-1)?.[0];
            expect(chatListProps?.onEditPendingMessage).toEqual(expect.any(Function));

            await act(async () => {
                await chatListProps.onEditPendingMessage({
                    id: 'p-edit',
                    text: 'Queued edit text',
                    displayText: 'Queued edit text',
                    message: queuedMessage,
                });
            });

            agentInput = findTestInstanceByTypeWithProps(renderedFirstTree, 'AgentInput' as any, {}) as any;
            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onChangeText', 'Edited queued text', 'AgentInput');
            });

            act(() => {
                firstTree?.unmount();
            });
            firstTree = undefined;

            expect(readSessionShellDraftTextForTest('s1')).toBe('');
            expect(readSessionDraftValue(
                TEST_SERVER_ACCOUNT_SCOPE,
                's1',
                'routing.executionRunDelivery',
            )).toBe('interrupt');

            secondTree = (await renderScreen(<AppPaneProvider>
                        <SessionView id="s1" />
                    </AppPaneProvider>)).tree;
            const renderedSecondTree = secondTree;
            expect(renderedSecondTree).toBeDefined();
            if (!renderedSecondTree) throw new Error('SessionView test renderer did not remount');

            agentInput = findTestInstanceByTypeWithProps(renderedSecondTree, 'AgentInput' as any, {}) as any;
            expect(agentInput.props.attachmentRowItems).toEqual([
                expect.objectContaining({ label: 'draft-note.txt', status: 'pending' }),
            ]);
        } finally {
            act(() => {
                firstTree?.unmount();
                secondTree?.unmount();
            });
            pendingFireAndForget.length = 0;
        }
    });

    it('saves a pending edit through updatePendingMessage and restores the previous draft', async () => {
        const queuedMessage: PendingMessage = {
            id: 'p-edit',
            localId: 'p-edit',
            text: 'Queued edit text',
            displayText: 'Queued edit text',
            createdAt: 0,
            updatedAt: 0,
            deliveryStatus: 'accepted',
            rawRecord: {},
        };
        sessionPendingMessagesState.current = [queuedMessage];

        let tree: renderer.ReactTestRenderer | undefined;
        try {
            tree = (await renderScreen(<AppPaneProvider>
                        <SessionView id="s1" />
                    </AppPaneProvider>)).tree;

            pendingFireAndForget.length = 0;

            const renderedTree = tree;
            expect(renderedTree).toBeDefined();
            if (!renderedTree) throw new Error('SessionView test renderer did not mount');

            let agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onChangeText', 'Existing draft', 'AgentInput');
            });

            const chatListProps = chatListPropsSpy.mock.calls.at(-1)?.[0];
            expect(chatListProps?.onEditPendingMessage).toEqual(expect.any(Function));

            await act(async () => {
                await chatListProps.onEditPendingMessage({
                    id: 'p-edit',
                    text: 'Queued edit text',
                    displayText: 'Queued edit text',
                    message: queuedMessage,
                });
            });

            agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            expect(agentInput.props.value).toBe('Queued edit text');
            expect(readSessionShellDraftTextForTest('s1')).toBe('Existing draft');
            expect(readComposerPresentationSnapshot({ kind: 'session', sessionId: 's1' })?.text).toBe('Existing draft');
            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onChangeText', 'Edited queued text', 'AgentInput');
            });

            agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onSend', undefined, 'AgentInput');
            });

            expect(pendingFireAndForget.length).toBe(1);
            await act(async () => {
                await pendingFireAndForget[0];
            });

            expect(updatePendingMessageSpy).toHaveBeenCalledTimes(1);
            expect(updatePendingMessageSpy).toHaveBeenCalledWith(
                's1', 'p-edit', 'Edited queued text', { v: 1 }, undefined,
            );
            expect(sendMessageSpy).not.toHaveBeenCalled();
            expect(enqueuePendingMessageSpy).not.toHaveBeenCalled();

            agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            expect(agentInput.props.value).toBe('Existing draft');
            expect(readSessionShellDraftTextForTest('s1')).toBe('Existing draft');
        } finally {
            act(() => {
                tree?.unmount();
            });
            pendingFireAndForget.length = 0;
        }
    });

    it('does not overwrite text entered while a pending edit PATCH is deferred', async () => {
        const queuedMessage: PendingMessage = {
            id: 'p-edit-deferred',
            localId: 'p-edit-deferred',
            text: 'Queued edit text',
            displayText: 'Queued edit text',
            createdAt: 0,
            updatedAt: 0,
            deliveryStatus: 'accepted',
            rawRecord: {},
        };
        sessionPendingMessagesState.current = [queuedMessage];
        let releaseUpdate!: () => void;
        const updateGate = new Promise<void>((resolve) => { releaseUpdate = resolve; });
        updatePendingMessageSpy.mockImplementationOnce(async () => {
            await updateGate;
        });

        let tree: renderer.ReactTestRenderer | undefined;
        try {
            tree = (await renderScreen(<AppPaneProvider>
                <SessionView id="s1" />
            </AppPaneProvider>)).tree;
            pendingFireAndForget.length = 0;

            const renderedTree = tree;
            if (!renderedTree) throw new Error('SessionView test renderer did not mount');
            let agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onChangeText', 'Existing draft', 'AgentInput');
            });
            const chatListProps = chatListPropsSpy.mock.calls.at(-1)?.[0];
            await act(async () => {
                await chatListProps.onEditPendingMessage({
                    id: queuedMessage.id,
                    text: queuedMessage.text,
                    displayText: queuedMessage.displayText,
                    message: queuedMessage,
                });
            });
            agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onChangeText', 'Edited queued text', 'AgentInput');
                invokeTestInstanceHandler(agentInput, 'onSend', undefined, 'AgentInput');
                invokeTestInstanceHandler(agentInput, 'onSend', undefined, 'AgentInput');
            });
            expect(updatePendingMessageSpy).toHaveBeenCalledTimes(1);
            expect(updatePendingMessageSpy).toHaveBeenCalledWith(
                's1', queuedMessage.id, 'Edited queued text', { v: 1 }, undefined,
            );

            agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onChangeText', 'Intervening draft', 'AgentInput');
            });
            await act(async () => {
                releaseUpdate();
                await pendingFireAndForget[0];
            });

            agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            expect(agentInput.props.value).toBe('Intervening draft');
            expect(readSessionShellDraftTextForTest('s1')).toBe('Existing draft');
        } finally {
            act(() => {
                tree?.unmount();
            });
            pendingFireAndForget.length = 0;
        }
    });

    it('restores the prior text when a pending edit returns to its accepted text before PATCH settlement', async () => {
        const queuedMessage: PendingMessage = {
            id: 'p-edit-deferred-same-text',
            localId: 'p-edit-deferred-same-text',
            text: 'Queued edit text',
            displayText: 'Queued edit text',
            createdAt: 0,
            updatedAt: 0,
            deliveryStatus: 'accepted',
            rawRecord: {},
        };
        sessionPendingMessagesState.current = [queuedMessage];
        let releaseUpdate!: () => void;
        const updateGate = new Promise<void>((resolve) => { releaseUpdate = resolve; });
        updatePendingMessageSpy.mockImplementationOnce(async () => {
            await updateGate;
        });

        let tree: renderer.ReactTestRenderer | undefined;
        try {
            tree = (await renderScreen(<AppPaneProvider>
                <SessionView id="s1" />
            </AppPaneProvider>)).tree;
            pendingFireAndForget.length = 0;

            const renderedTree = tree;
            if (!renderedTree) throw new Error('SessionView test renderer did not mount');
            let agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onChangeText', 'Existing draft', 'AgentInput');
            });
            const chatListProps = chatListPropsSpy.mock.calls.at(-1)?.[0];
            await act(async () => {
                await chatListProps.onEditPendingMessage({
                    id: queuedMessage.id,
                    text: queuedMessage.text,
                    displayText: queuedMessage.displayText,
                    message: queuedMessage,
                });
            });
            agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onChangeText', 'Edited queued text', 'AgentInput');
                invokeTestInstanceHandler(agentInput, 'onSend', undefined, 'AgentInput');
            });
            expect(updatePendingMessageSpy).toHaveBeenCalledWith(
                's1', queuedMessage.id, 'Edited queued text', { v: 1 }, undefined,
            );
            expect(pendingFireAndForget).toHaveLength(1);

            agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onChangeText', 'Temporary edit', 'AgentInput');
                invokeTestInstanceHandler(agentInput, 'onChangeText', 'Edited queued text', 'AgentInput');
            });
            await act(async () => {
                releaseUpdate();
                await pendingFireAndForget[0];
            });
            await act(async () => {
                await Promise.resolve();
            });

            agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            expect(agentInput.props.value).toBe('Edited queued text');
            expect(readSessionShellDraftTextForTest('s1')).toBe('Existing draft');
        } finally {
            act(() => {
                tree?.unmount();
            });
            pendingFireAndForget.length = 0;
        }
    });

    it('restores prior text while retaining a newer attachment snapshot after a pending edit PATCH', async () => {
        const queuedMessage: PendingMessage = {
            id: 'p-edit-deferred-attachment',
            localId: 'p-edit-deferred-attachment',
            text: 'Queued edit text',
            displayText: 'Queued edit text',
            createdAt: 0,
            updatedAt: 0,
            deliveryStatus: 'accepted',
            rawRecord: {},
        };
        const newerAttachment = {
            v: 1,
            instanceId: 'issue-43',
            attachment: { pluginId: 'acme.issues', localId: 'issue' },
            key: '43',
            value: { issueId: 43 },
            presentation: { label: 'Issue #43', typeLabel: 'Issue' },
        } as const;
        sessionPendingMessagesState.current = [queuedMessage];
        let releaseUpdate!: () => void;
        const updateGate = new Promise<void>((resolve) => { releaseUpdate = resolve; });
        updatePendingMessageSpy.mockImplementationOnce(async () => {
            await updateGate;
        });

        let tree: renderer.ReactTestRenderer | undefined;
        try {
            tree = (await renderScreen(<AppPaneProvider>
                <SessionView id="s1" />
            </AppPaneProvider>)).tree;
            pendingFireAndForget.length = 0;

            const renderedTree = tree;
            if (!renderedTree) throw new Error('SessionView test renderer did not mount');
            let agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onChangeText', 'Existing draft', 'AgentInput');
            });
            const chatListProps = chatListPropsSpy.mock.calls.at(-1)?.[0];
            await act(async () => {
                await chatListProps.onEditPendingMessage({
                    id: queuedMessage.id,
                    text: queuedMessage.text,
                    displayText: queuedMessage.displayText,
                    message: queuedMessage,
                });
            });
            agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onChangeText', 'Edited queued text', 'AgentInput');
                invokeTestInstanceHandler(agentInput, 'onSend', undefined, 'AgentInput');
            });
            expect(updatePendingMessageSpy).toHaveBeenCalledWith(
                's1', queuedMessage.id, 'Edited queued text', { v: 1 }, undefined,
            );
            expect(pendingFireAndForget).toHaveLength(1);

            await act(async () => {
                writeSessionDraftValue(
                    TEST_SERVER_ACCOUNT_SCOPE,
                    's1',
                    'structuredInput.composerAttachments',
                    [newerAttachment],
                );
            });
            await act(async () => {
                releaseUpdate();
                await pendingFireAndForget[0];
            });

            agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            expect(agentInput.props.value).toBe('Existing draft');
            expect(readSessionShellDraftTextForTest('s1')).toBe('Existing draft');
            expect(readSessionDraftValue(
                TEST_SERVER_ACCOUNT_SCOPE,
                's1',
                'structuredInput.composerAttachments',
            )).toEqual([newerAttachment]);
        } finally {
            act(() => {
                tree?.unmount();
            });
            pendingFireAndForget.length = 0;
        }
    });

    it('restores prior text while retaining a newer reference snapshot after a pending edit PATCH', async () => {
        const queuedMessage: PendingMessage = {
            id: 'p-edit-deferred-reference',
            localId: 'p-edit-deferred-reference',
            text: 'Queued edit text',
            displayText: 'Queued edit text',
            createdAt: 0,
            updatedAt: 0,
            deliveryStatus: 'accepted',
            rawRecord: {},
        };
        const newerReference = {
            kind: 'partner.reference',
            ref: 'partner:issue-99',
            token: '@new.ts',
            start: 7,
            end: 14,
            label: 'Issue #99',
        } as const;
        sessionPendingMessagesState.current = [queuedMessage];
        let releaseUpdate!: () => void;
        const updateGate = new Promise<void>((resolve) => { releaseUpdate = resolve; });
        updatePendingMessageSpy.mockImplementationOnce(async () => {
            await updateGate;
        });

        let tree: renderer.ReactTestRenderer | undefined;
        try {
            tree = (await renderScreen(<AppPaneProvider>
                <SessionView id="s1" />
            </AppPaneProvider>)).tree;
            pendingFireAndForget.length = 0;

            const renderedTree = tree;
            if (!renderedTree) throw new Error('SessionView test renderer did not mount');
            let agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onChangeText', 'Before @new.ts draft', 'AgentInput');
            });
            const chatListProps = chatListPropsSpy.mock.calls.at(-1)?.[0];
            await act(async () => {
                await chatListProps.onEditPendingMessage({
                    id: queuedMessage.id,
                    text: queuedMessage.text,
                    displayText: queuedMessage.displayText,
                    message: queuedMessage,
                });
            });
            agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onChangeText', 'Edited @new.ts text', 'AgentInput');
                invokeTestInstanceHandler(agentInput, 'onSend', undefined, 'AgentInput');
            });
            expect(updatePendingMessageSpy).toHaveBeenCalledWith(
                's1', queuedMessage.id, 'Edited @new.ts text', { v: 1 }, undefined,
            );
            expect(pendingFireAndForget).toHaveLength(1);

            const pendingRef = {
                kind: 'pendingMessage' as const,
                sessionId: 's1',
                localId: queuedMessage.localId!,
            };
            await act(async () => {
                const current = readComposerPresentationSnapshot(pendingRef);
                if (!current) throw new Error('expected active pending Composer snapshot');
                expect(applyComposerPresentationTransaction({
                    ref: pendingRef,
                    transaction: {
                        expectedRevision: current.revision,
                        operations: [{ kind: 'reference.insert', reference: newerReference }],
                    },
                }).status).toBe('applied');
            });
            expect(readComposerPresentationSnapshot(pendingRef)?.references).toEqual([
                expect.objectContaining({
                    kind: newerReference.kind,
                    ref: newerReference.ref,
                    token: newerReference.token,
                }),
            ]);
            expect(readSessionDraftValue(
                TEST_SERVER_ACCOUNT_SCOPE,
                's1',
                'structuredInput.mentions',
            )).toBeUndefined();
            await act(async () => {
                releaseUpdate();
                await pendingFireAndForget[0];
            });

            agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            expect(agentInput.props.value).toBe('Edited @new.ts text');
            expect(readSessionShellDraftTextForTest('s1')).toBe('Before @new.ts draft');
            expect(readComposerPresentationSnapshot(pendingRef)?.references).toEqual(expect.arrayContaining([
                expect.objectContaining({
                    kind: newerReference.kind,
                    ref: newerReference.ref,
                    token: newerReference.token,
                }),
            ]));
            expect(readSessionDraftValue(
                TEST_SERVER_ACCOUNT_SCOPE,
                's1',
                'structuredInput.mentions',
            )).toBeUndefined();
        } finally {
            act(() => {
                tree?.unmount();
            });
            pendingFireAndForget.length = 0;
        }
    });

    it('keeps an unchanged contentless attachment selection in the admitted pending envelope', async () => {
        const mention = {
            kind: 'happier.file',
            ref: 'file:src/index.ts',
            token: '@src/index.ts',
        } as const;
        const attachment = {
            v: 1,
            instanceId: 'issue-42',
            attachment: { pluginId: 'acme.issues', localId: 'issue' },
            key: '42',
            value: { issueId: 42 },
            presentation: { label: 'Issue #42', typeLabel: 'Issue' },
        } as const;
        const queuedMessage: PendingMessage = {
            id: 'p-edit-with-composer-attachment',
            localId: 'p-edit-with-composer-attachment',
            text: '@src/index.ts',
            displayText: '@src/index.ts',
            createdAt: 0,
            updatedAt: 0,
            deliveryStatus: 'accepted',
            rawRecord: {
                role: 'user',
                content: { type: 'text', text: '@src/index.ts' },
                meta: {
                    happierStructuredInputV1: {
                        v: 1,
                        mentions: [mention],
                        composerAttachments: [attachment],
                    },
                },
            },
        };
        sessionPendingMessagesState.current = [queuedMessage];
        setCurrentComposerAttachmentProjection();

        let tree: renderer.ReactTestRenderer | undefined;
        try {
            tree = (await renderScreen(<AppPaneProvider>
                <SessionView id="s1" />
            </AppPaneProvider>)).tree;

            pendingFireAndForget.length = 0;

            const renderedTree = tree;
            expect(renderedTree).toBeDefined();
            if (!renderedTree) throw new Error('SessionView test renderer did not mount');

            const chatListProps = chatListPropsSpy.mock.calls.at(-1)?.[0];
            expect(chatListProps?.onEditPendingMessage).toEqual(expect.any(Function));

            await act(async () => {
                await chatListProps.onEditPendingMessage({
                    id: queuedMessage.id,
                    text: queuedMessage.text,
                    displayText: queuedMessage.displayText,
                    message: queuedMessage,
                });
            });

            const agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            expect(readComposerPresentationSnapshot({
                kind: 'pendingMessage',
                sessionId: 's1',
                localId: queuedMessage.localId!,
            })).toMatchObject({
                text: queuedMessage.text,
                attachments: [attachment],
                references: [mention],
            });
            // The ordinary Session document stays independent while the
            // Pending-message document owns the visible editor.
            expect(readSessionDraftValue(
                TEST_SERVER_ACCOUNT_SCOPE,
                's1',
                'structuredInput.composerAttachments',
            )).toBeUndefined();

            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onSend', undefined, 'AgentInput');
            });

            expect(pendingFireAndForget).toHaveLength(1);
            await act(async () => {
                await pendingFireAndForget[0];
            });

            expect(updatePendingMessageSpy).toHaveBeenCalledWith(
                's1',
                queuedMessage.id,
                '@src/index.ts',
                {
                    v: 1,
                    mentions: [mention],
                    composerAttachments: [attachment],
                },
                undefined,
            );
            expect(sendMessageSpy).not.toHaveBeenCalled();
            expect(enqueuePendingMessageSpy).not.toHaveBeenCalled();
        } finally {
            act(() => {
                tree?.unmount();
            });
            pendingFireAndForget.length = 0;
        }
    });

    it('prepares a changed pending-edit attachment under one replacement localId before atomically saving it', async () => {
        const attachment = {
            v: 1,
            instanceId: 'issue-42',
            attachment: { pluginId: 'acme.issues', localId: 'issue' },
            key: '42',
            value: { issueId: 42 },
            presentation: { label: 'Issue #42', typeLabel: 'Issue' },
        } as const;
        const changedAttachment = {
            ...attachment,
            value: { issueId: 43 },
            presentation: { label: 'Issue #43', typeLabel: 'Issue' },
        } as const;
        const queuedMessage: PendingMessage = {
            id: 'p-edit-changed-composer-attachment',
            localId: 'p-edit-changed-composer-attachment',
            text: 'Queued edit text',
            displayText: 'Queued edit text',
            createdAt: 0,
            updatedAt: 0,
            deliveryStatus: 'accepted',
            rawRecord: {
                role: 'user',
                content: { type: 'text', text: 'Queued edit text' },
                meta: { happierStructuredInputV1: { v: 1, composerAttachments: [attachment] } },
            },
        };
        sessionPendingMessagesState.current = [queuedMessage];
        setCurrentComposerAttachmentProjection();

        let tree: renderer.ReactTestRenderer | undefined;
        try {
            tree = (await renderScreen(<AppPaneProvider>
                <SessionView id="s1" />
            </AppPaneProvider>)).tree;
            pendingFireAndForget.length = 0;
            const renderedTree = tree;
            if (!renderedTree) throw new Error('SessionView test renderer did not mount');
            const chatListProps = chatListPropsSpy.mock.calls.at(-1)?.[0];
            await act(async () => {
                await chatListProps.onEditPendingMessage({
                    id: queuedMessage.id,
                    text: queuedMessage.text,
                    displayText: queuedMessage.displayText,
                    message: queuedMessage,
                });
            });
            const pendingRef = {
                kind: 'pendingMessage' as const,
                sessionId: 's1',
                localId: queuedMessage.localId!,
            };
            const attachmentApplier = createComposerPresentationTransactionApplier({
                composerAttachmentsById: {
                    'acme.issues/issue': daemonMergedProjectionState.value.inputs.pluginProjectionV2
                        .familiesById.composerAttachments.entriesById['acme.issues/issue'],
                },
            });
            await act(async () => {
                const current = readComposerPresentationSnapshot(pendingRef);
                if (!current) throw new Error('expected active pending Composer snapshot');
                expect(attachmentApplier.apply({
                    ref: pendingRef,
                    admittedContributor: {
                        identity: { pluginId: 'acme.issues', localId: 'pending-editor' },
                        immutableGenerationId: 'issue-generation-a',
                    },
                    transaction: {
                        expectedRevision: current.revision,
                        operations: [{
                            kind: 'attachment.update',
                            instanceId: attachment.instanceId,
                            update: {
                                value: changedAttachment.value,
                                presentation: { label: 'Issue #43' },
                            },
                        }],
                    },
                }).status).toBe('applied');
            });
            machinePluginComposerAttachmentPrepareMock.mockResolvedValueOnce({
                supported: true,
                result: {
                    ok: true,
                    attachment: attachment.attachment,
                    result: {
                        attachments: [{
                            instanceId: attachment.instanceId,
                            status: 'ready',
                            value: { issueId: 430 },
                            presentation: { label: 'Prepared issue #430' },
                        }],
                    },
                },
            });

            const agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onSend', undefined, 'AgentInput');
            });

            expect(pendingFireAndForget).toHaveLength(1);
            await act(async () => {
                await pendingFireAndForget[0];
            });
            expect(machinePluginComposerAttachmentPrepareMock).toHaveBeenCalledTimes(1);
            const prepareRequest = machinePluginComposerAttachmentPrepareMock.mock.calls[0]?.[1];
            expect(prepareRequest).toMatchObject({
                serverId: 'server-1',
                expectedGeneration: '7',
                attachment: attachment.attachment,
                request: {
                    sessionId: 's1',
                    localId: expect.any(String),
                    attachments: [{
                        instanceId: attachment.instanceId,
                        key: attachment.key,
                        value: changedAttachment.value,
                    }],
                },
            });
            const replacementLocalId = prepareRequest.request.localId;
            expect(replacementLocalId).not.toBe(queuedMessage.localId);
            expect(updatePendingMessageSpy).toHaveBeenCalledWith('s1', queuedMessage.id, queuedMessage.text, {
                v: 1,
                composerAttachments: [{
                    ...changedAttachment,
                    value: { issueId: 430 },
                    presentation: { label: 'Prepared issue #430', typeLabel: 'Issue' },
                }],
            }, { replacementLocalId });
            expect(modalAlertSpy).not.toHaveBeenCalled();
        } finally {
            act(() => {
                tree?.unmount();
            });
            pendingFireAndForget.length = 0;
        }
    });

    it('refuses a pending-edit save whose prepared attachment still owns transfer-staged media', async () => {
        const attachment = {
            v: 1,
            instanceId: 'issue-42',
            attachment: { pluginId: 'acme.issues', localId: 'issue' },
            key: '42',
            value: { issueId: 42 },
            presentation: { label: 'Issue #42', typeLabel: 'Issue' },
        } as const;
        const queuedMessage: PendingMessage = {
            id: 'p-edit-staged-media-composer-attachment',
            localId: 'p-edit-staged-media-composer-attachment',
            text: 'Queued edit text',
            displayText: 'Queued edit text',
            createdAt: 0,
            updatedAt: 0,
            deliveryStatus: 'accepted',
            rawRecord: {
                role: 'user',
                content: { type: 'text', text: 'Queued edit text' },
                meta: { happierStructuredInputV1: { v: 1, composerAttachments: [attachment] } },
            },
        };
        sessionPendingMessagesState.current = [queuedMessage];
        setCurrentComposerAttachmentProjection();

        let tree: renderer.ReactTestRenderer | undefined;
        try {
            tree = (await renderScreen(<AppPaneProvider>
                <SessionView id="s1" />
            </AppPaneProvider>)).tree;
            pendingFireAndForget.length = 0;
            const renderedTree = tree;
            if (!renderedTree) throw new Error('SessionView test renderer did not mount');
            const chatListProps = chatListPropsSpy.mock.calls.at(-1)?.[0];
            await act(async () => {
                await chatListProps.onEditPendingMessage({
                    id: queuedMessage.id,
                    text: queuedMessage.text,
                    displayText: queuedMessage.displayText,
                    message: queuedMessage,
                });
            });
            const pendingRef = {
                kind: 'pendingMessage' as const,
                sessionId: 's1',
                localId: queuedMessage.localId!,
            };
            const attachmentApplier = createComposerPresentationTransactionApplier({
                composerAttachmentsById: {
                    'acme.issues/issue': daemonMergedProjectionState.value.inputs.pluginProjectionV2
                        .familiesById.composerAttachments.entriesById['acme.issues/issue'],
                },
            });
            await act(async () => {
                const current = readComposerPresentationSnapshot(pendingRef);
                if (!current) throw new Error('expected active pending Composer snapshot');
                expect(attachmentApplier.apply({
                    ref: pendingRef,
                    admittedContributor: {
                        identity: { pluginId: 'acme.issues', localId: 'pending-editor' },
                        immutableGenerationId: 'issue-generation-a',
                    },
                    transaction: {
                        expectedRevision: current.revision,
                        operations: [{
                            kind: 'attachment.update',
                            instanceId: attachment.instanceId,
                            update: {
                                value: { issueId: 43 },
                                presentation: { label: 'Issue #43' },
                            },
                        }],
                    },
                }).status).toBe('applied');
            });
            // The plugin's own `prepareForSend` is allowed to return a staged-media
            // claim (ComposerAttachmentPrepareReadyOutcomeV1 carries `content`). A
            // Pending row can only persist contentless admitted records, so this
            // save must fail closed instead of silently dropping the media.
            machinePluginComposerAttachmentPrepareMock.mockResolvedValueOnce({
                supported: true,
                result: {
                    ok: true,
                    attachment: attachment.attachment,
                    result: {
                        attachments: [{
                            instanceId: attachment.instanceId,
                            status: 'ready',
                            value: { issueId: 430 },
                            presentation: { label: 'Prepared issue #430' },
                            content: {
                                kind: 'stagedMedia',
                                handle: {
                                    v: 1,
                                    id: 'stage-1',
                                    executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
                                    owner: { pluginId: 'acme.issues', localId: 'issue' },
                                    mediaKind: 'image',
                                    mimeType: 'image/png',
                                    name: 'screenshot.png',
                                    sizeBytes: 1234,
                                    sha256: 'a'.repeat(64),
                                },
                            },
                        }],
                    },
                },
            });

            const agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onSend', undefined, 'AgentInput');
            });

            expect(pendingFireAndForget).toHaveLength(1);
            await act(async () => {
                await pendingFireAndForget[0];
            });
            // Nothing is persisted, so nothing is silently lost.
            expect(updatePendingMessageSpy).not.toHaveBeenCalled();
            expect(modalAlertSpy).toHaveBeenCalled();
            // The Pending row and its editor are left exactly as they were.
            expect(readComposerPresentationSnapshot(pendingRef)?.attachments).toMatchObject([{
                instanceId: attachment.instanceId,
                value: { issueId: 43 },
            }]);
        } finally {
            act(() => {
                tree?.unmount();
            });
            pendingFireAndForget.length = 0;
        }
    });

    it('refuses malformed persisted semantic input without mutating the active composer', async () => {
        const queuedMessage: PendingMessage = {
            id: 'p-edit-with-malformed-semantic-input',
            localId: 'p-edit-with-malformed-semantic-input',
            text: 'Queued malformed semantic input edit text',
            displayText: 'Queued malformed semantic input edit text',
            createdAt: 0,
            updatedAt: 0,
            deliveryStatus: 'accepted',
            rawRecord: {
                role: 'user',
                content: { type: 'text', text: 'Queued malformed semantic input edit text' },
                meta: {
                    happierStructuredInputV1: {
                        v: 1,
                        // This is intentionally not a valid Composer attachment. The raw
                        // guard must fail closed for malformed persisted semantic input,
                        // without reviving it into the text-only editor.
                        unknownPersistedSemanticInput: [{ source: 'legacy-invalid' }],
                    },
                },
            },
        };
        sessionPendingMessagesState.current = [queuedMessage];
        writeSessionDraftValue(
            TEST_SERVER_ACCOUNT_SCOPE,
            's1',
            'routing.executionRunDelivery',
            'interrupt',
        );

        let tree: renderer.ReactTestRenderer | undefined;
        try {
            tree = (await renderScreen(<AppPaneProvider>
                <SessionView
                    id="s1"
                    initialAttachmentDrafts={[{
                        id: 'draft-note',
                        source: {
                            kind: 'native',
                            uri: 'file:///tmp/draft-note.txt',
                            name: 'draft-note.txt',
                            sizeBytes: 1,
                            mimeType: 'text/plain',
                        },
                        status: 'pending',
                    }]}
                />
            </AppPaneProvider>)).tree;

            const renderedTree = tree;
            expect(renderedTree).toBeDefined();
            if (!renderedTree) throw new Error('SessionView test renderer did not mount');

            let agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onChangeText', 'Existing draft', 'AgentInput');
            });
            expect(agentInput.props.attachmentRowItems).toEqual([
                expect.objectContaining({ label: 'draft-note.txt', status: 'pending' }),
            ]);

            const chatListProps = chatListPropsSpy.mock.calls.at(-1)?.[0];
            expect(chatListProps?.onEditPendingMessage).toEqual(expect.any(Function));
            patchSessionMetadataWithRetrySpy.mockClear();
            modalAlertSpy.mockClear();

            await act(async () => {
                await chatListProps.onEditPendingMessage({
                    id: queuedMessage.id,
                    text: queuedMessage.text,
                    displayText: queuedMessage.displayText,
                    message: queuedMessage,
                });
            });

            agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            expect(agentInput.props.value).toBe('Existing draft');
            expect(agentInput.props.attachmentRowItems).toEqual([
                expect.objectContaining({ label: 'draft-note.txt', status: 'pending' }),
            ]);
            expect(readSessionDraftValue(
                TEST_SERVER_ACCOUNT_SCOPE,
                's1',
                'routing.executionRunDelivery',
            )).toBe('interrupt');
            expect(patchSessionMetadataWithRetrySpy).not.toHaveBeenCalled();
            expect(updatePendingMessageSpy).not.toHaveBeenCalled();
            expect(modalAlertSpy).toHaveBeenCalledWith(
                'common.error',
                'session.pendingMessages.errors.editStructuredInputUnsupported',
            );
        } finally {
            act(() => {
                tree?.unmount();
            });
            pendingFireAndForget.length = 0;
        }
    });

    it('publishes and clears a pending queue drain hold while editing a queued message', async () => {
        const queuedMessage: PendingMessage = {
            id: 'p-edit',
            localId: 'p-edit',
            text: 'Queued edit text',
            displayText: 'Queued edit text',
            createdAt: 0,
            updatedAt: 0,
            deliveryStatus: 'accepted',
            rawRecord: {},
        };
        sessionPendingMessagesState.current = [queuedMessage];

        let tree: renderer.ReactTestRenderer | undefined;
        try {
            tree = (await renderScreen(<AppPaneProvider>
                        <SessionView id="s1" />
                    </AppPaneProvider>)).tree;

            pendingFireAndForget.length = 0;

            const renderedTree = tree;
            expect(renderedTree).toBeDefined();
            if (!renderedTree) throw new Error('SessionView test renderer did not mount');

            const chatListProps = chatListPropsSpy.mock.calls.at(-1)?.[0];
            expect(chatListProps?.onEditPendingMessage).toEqual(expect.any(Function));

            await act(async () => {
                await chatListProps.onEditPendingMessage({
                    id: 'p-edit',
                    text: 'Queued edit text',
                    displayText: 'Queued edit text',
                    message: queuedMessage,
                });
            });

            expect(patchSessionMetadataWithRetrySpy).toHaveBeenCalledTimes(1);
            expect(patchSessionMetadataWithRetrySpy.mock.calls[0]?.[0]).toBe('s1');
            const writeUpdater = patchSessionMetadataWithRetrySpy.mock.calls[0]?.[1] as (metadata: Record<string, unknown>) => Record<string, unknown>;
            const metadataWithHold = writeUpdater({});
            const holdsById = (metadataWithHold.sessionPendingQueueHoldV1 as any)?.holdsById;
            const holdId = Object.keys(holdsById ?? {})[0];
            expect(holdId).toBeTruthy();
            expect(holdsById[holdId]).toMatchObject({
                kind: 'pending_message_edit',
                localId: 'p-edit',
            });

            let agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onChangeText', 'Edited queued text', 'AgentInput');
            });
            agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onSend', undefined, 'AgentInput');
            });
            expect(pendingFireAndForget.length).toBe(1);
            await act(async () => {
                await pendingFireAndForget[0];
            });

            expect(patchSessionMetadataWithRetrySpy).toHaveBeenCalledTimes(2);
            const clearUpdater = patchSessionMetadataWithRetrySpy.mock.calls[1]?.[1] as (metadata: Record<string, unknown>) => Record<string, unknown>;
            expect(clearUpdater(metadataWithHold)).not.toHaveProperty('sessionPendingQueueHoldV1');
        } finally {
            act(() => {
                tree?.unmount();
            });
            pendingFireAndForget.length = 0;
        }
    });

    it('keeps composer text visible until attachment send creates a local pending projection', async () => {
        featureEnabledState.reviewComments = false;
        sendMessageSpy.mockClear();
        resumeSessionSpy.mockClear();
        uploadSpy.mockClear();
        modalAlertSpy.mockClear();
        resolveSessionComposerSendMock.mockClear();
        reviewCommentDraftsState.current = [];
        deleteWorkspaceReviewCommentDraftSpy.mockClear();
        pendingFireAndForget.length = 0;

        let resolveUpload: (() => void) | null = null;
        const uploadStarted = new Promise<void>((resolveStarted) => {
            uploadSpy.mockImplementationOnce(async () => {
                resolveStarted();
                return await new Promise((resolve) => {
                    resolveUpload = () => resolve({ success: true, path: 'p1', sizeBytes: 1, sha256: 'h1' });
                });
            });
        });
        let resolveSend: (() => void) | null = null;
        let localPendingProjectionCreated: (() => void) | null = null;
        const sendStarted = new Promise<void>((resolveStarted) => {
            sendMessageSpy.mockImplementationOnce(async (...args: any[]) => {
                const options = args[4] as
                    | { onLocalPendingProjectionCreated?: (event: Readonly<{ localId: string }>) => void }
                    | undefined;
                localPendingProjectionCreated = () => options?.onLocalPendingProjectionCreated?.({ localId: 'attachment-local-id' });
                resolveStarted();
                return await new Promise<void>((resolve) => {
                    resolveSend = resolve;
                });
            });
        });

        let tree: renderer.ReactTestRenderer | undefined;
        try {
            tree = (await renderScreen(<AppPaneProvider>
                        <SessionView id="s1" />
                    </AppPaneProvider>)).tree;

            pendingFireAndForget.length = 0;

            const renderedTree = tree;
            expect(renderedTree).toBeDefined();
            if (!renderedTree) throw new Error('SessionView test renderer did not mount');

            let agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onChangeText', 'Describe this image', 'AgentInput');
            });

            agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            expect(agentInput.props.value).toBe('Describe this image');

            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onAttachmentsAdded', [
                    { name: 'a.txt', size: 1, type: 'text/plain', slice: () => new Blob([new Uint8Array([97])]) } as any,
                ], 'AgentInput');
            });

            agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onSend', undefined, 'AgentInput');
            });

            expect(pendingFireAndForget.length).toBe(1);
            await act(async () => {
                await uploadStarted;
            });

            agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            expect(agentInput.props.value).toBe('Describe this image');
            expect(sendMessageSpy).toHaveBeenCalledTimes(0);

            await act(async () => {
                if (!resolveUpload) throw new Error('upload did not start');
                resolveUpload();
                await sendStarted;
            });

            agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            expect(sendMessageSpy).toHaveBeenCalledTimes(1);
            expect(agentInput.props.value).toBe('Describe this image');

            await act(async () => {
                if (!localPendingProjectionCreated) throw new Error('local pending projection callback was not registered');
                localPendingProjectionCreated();
            });

            agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            expect(agentInput.props.value).toBe('');

            await act(async () => {
                if (!resolveSend) throw new Error('send did not start');
                resolveSend();
                await pendingFireAndForget[0];
            });
        } finally {
            act(() => {
                tree?.unmount();
            });
            pendingFireAndForget.length = 0;
        }
    });

    it('preserves newer attachment drafts when a no-callback attachment send resolves after the draft changes', async () => {
        featureEnabledState.reviewComments = false;
        sendMessageSpy.mockClear();
        resumeSessionSpy.mockClear();
        uploadSpy.mockClear();
        modalAlertSpy.mockClear();
        resolveSessionComposerSendMock.mockClear();
        reviewCommentDraftsState.current = [];
        deleteWorkspaceReviewCommentDraftSpy.mockClear();
        pendingFireAndForget.length = 0;

        uploadSpy.mockResolvedValueOnce({ success: true, path: 'p1', sizeBytes: 1, sha256: 'h1' });

        let resolveSend: (() => void) | null = null;
        const sendStarted = new Promise<void>((resolveStarted) => {
            sendMessageSpy.mockImplementationOnce(async () => {
                resolveStarted();
                return await new Promise<void>((resolve) => {
                    resolveSend = resolve;
                });
            });
        });

        let tree: renderer.ReactTestRenderer | undefined;
        try {
            tree = (await renderScreen(<AppPaneProvider>
                        <SessionView id="s1" />
                    </AppPaneProvider>)).tree;

            pendingFireAndForget.length = 0;

            const renderedTree = tree;
            expect(renderedTree).toBeDefined();
            if (!renderedTree) throw new Error('SessionView test renderer did not mount');

            let agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onChangeText', 'Describe this image', 'AgentInput');
            });
            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onAttachmentsAdded', [
                    { name: 'a.txt', size: 1, type: 'text/plain', slice: () => new Blob([new Uint8Array([97])]) } as any,
                ], 'AgentInput');
            });

            agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onSend', undefined, 'AgentInput');
            });

            await act(async () => {
                await sendStarted;
            });

            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onChangeText', 'Next draft', 'AgentInput');
            });
            agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onAttachmentsAdded', [
                    { name: 'next.txt', size: 1, type: 'text/plain', slice: () => new Blob([new Uint8Array([98])]) } as any,
                ], 'AgentInput');
            });

            await act(async () => {
                if (!resolveSend) throw new Error('send did not start');
                resolveSend();
                await pendingFireAndForget[0];
            });

            agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            expect(agentInput.props.value).toBe('Next draft');
            expect(agentInput.props.attachmentRowItems).toEqual([
                expect.objectContaining({ label: 'next.txt' }),
            ]);
        } finally {
            act(() => {
                tree?.unmount();
            });
            pendingFireAndForget.length = 0;
        }
    });

    it('preserves attachment drafts added while the submitted attachments are uploading', async () => {
        featureEnabledState.reviewComments = false;
        sendMessageSpy.mockClear();
        resumeSessionSpy.mockClear();
        uploadSpy.mockClear();
        modalAlertSpy.mockClear();
        resolveSessionComposerSendMock.mockClear();
        reviewCommentDraftsState.current = [];
        deleteWorkspaceReviewCommentDraftSpy.mockClear();
        pendingFireAndForget.length = 0;

        let resolveUpload: (() => void) | null = null;
        const uploadStarted = new Promise<void>((resolveStarted) => {
            uploadSpy.mockImplementationOnce(async () => {
                resolveStarted();
                return await new Promise((resolve) => {
                    resolveUpload = () => resolve({ success: true, path: 'p1', sizeBytes: 1, sha256: 'h1' });
                });
            });
        });

        let resolveSend: (() => void) | null = null;
        const sendStarted = new Promise<void>((resolveStarted) => {
            sendMessageSpy.mockImplementationOnce(async () => {
                resolveStarted();
                return await new Promise<void>((resolve) => {
                    resolveSend = resolve;
                });
            });
        });

        let tree: renderer.ReactTestRenderer | undefined;
        try {
            tree = (await renderScreen(<AppPaneProvider>
                        <SessionView id="s1" />
                    </AppPaneProvider>)).tree;

            pendingFireAndForget.length = 0;

            const renderedTree = tree;
            expect(renderedTree).toBeDefined();
            if (!renderedTree) throw new Error('SessionView test renderer did not mount');

            let agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onChangeText', 'Describe this image', 'AgentInput');
            });
            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onAttachmentsAdded', [
                    { name: 'a.txt', size: 1, type: 'text/plain', slice: () => new Blob([new Uint8Array([97])]) } as any,
                ], 'AgentInput');
            });

            agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onSend', undefined, 'AgentInput');
            });

            expect(pendingFireAndForget.length).toBe(1);
            await act(async () => {
                await uploadStarted;
            });

            agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onChangeText', 'Next draft', 'AgentInput');
            });
            agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onAttachmentsAdded', [
                    { name: 'next.txt', size: 1, type: 'text/plain', slice: () => new Blob([new Uint8Array([98])]) } as any,
                ], 'AgentInput');
            });

            await act(async () => {
                if (!resolveUpload) throw new Error('upload did not start');
                resolveUpload();
                await sendStarted;
            });

            await act(async () => {
                if (!resolveSend) throw new Error('send did not start');
                resolveSend();
                await pendingFireAndForget[0];
            });

            agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            expect(agentInput.props.value).toBe('Next draft');
            expect(agentInput.props.attachmentRowItems).toEqual([
                expect.objectContaining({ label: 'next.txt' }),
            ]);
        } finally {
            act(() => {
                tree?.unmount();
            });
            pendingFireAndForget.length = 0;
        }
    });

    it('clears submitted text while preserving an attachment draft added during upload', async () => {
        featureEnabledState.reviewComments = false;
        sendMessageSpy.mockClear();
        resumeSessionSpy.mockClear();
        uploadSpy.mockClear();
        modalAlertSpy.mockClear();
        resolveSessionComposerSendMock.mockClear();
        reviewCommentDraftsState.current = [];
        deleteWorkspaceReviewCommentDraftSpy.mockClear();
        pendingFireAndForget.length = 0;

        let resolveUpload: (() => void) | null = null;
        const uploadStarted = new Promise<void>((resolveStarted) => {
            uploadSpy.mockImplementationOnce(async () => {
                resolveStarted();
                return await new Promise((resolve) => {
                    resolveUpload = () => resolve({ success: true, path: 'p1', sizeBytes: 1, sha256: 'h1' });
                });
            });
        });

        let localPendingProjectionCreated: (() => void) | null = null;
        const sendStarted = new Promise<void>((resolveStarted) => {
            sendMessageSpy.mockImplementationOnce(async (...args: any[]) => {
                const options = args[4] as
                    | { onLocalPendingProjectionCreated?: (event: Readonly<{ localId: string }>) => void }
                    | undefined;
                localPendingProjectionCreated = () => options?.onLocalPendingProjectionCreated?.({ localId: 'attachment-local-id' });
                resolveStarted();
            });
        });

        let tree: renderer.ReactTestRenderer | undefined;
        try {
            tree = (await renderScreen(<AppPaneProvider>
                        <SessionView id="s1" />
                    </AppPaneProvider>)).tree;

            pendingFireAndForget.length = 0;

            const renderedTree = tree;
            expect(renderedTree).toBeDefined();
            if (!renderedTree) throw new Error('SessionView test renderer did not mount');

            let agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onChangeText', 'Describe this image', 'AgentInput');
            });
            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onAttachmentsAdded', [
                    { name: 'a.txt', size: 1, type: 'text/plain', slice: () => new Blob([new Uint8Array([97])]) } as any,
                ], 'AgentInput');
            });

            agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onSend', undefined, 'AgentInput');
            });

            expect(pendingFireAndForget.length).toBe(1);
            await act(async () => {
                await uploadStarted;
            });

            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onAttachmentsAdded', [
                    { name: 'next.txt', size: 1, type: 'text/plain', slice: () => new Blob([new Uint8Array([98])]) } as any,
                ], 'AgentInput');
            });

            await act(async () => {
                if (!resolveUpload) throw new Error('upload did not start');
                resolveUpload();
                await sendStarted;
            });

            await act(async () => {
                if (!localPendingProjectionCreated) throw new Error('local pending projection callback was not registered');
                localPendingProjectionCreated();
                await pendingFireAndForget[0];
            });

            agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            expect(agentInput.props.value).toBe('');
            expect(agentInput.props.attachmentRowItems).toEqual([
                expect.objectContaining({ label: 'next.txt' }),
            ]);
        } finally {
            act(() => {
                tree?.unmount();
            });
            pendingFireAndForget.length = 0;
        }
    });

    it('clears in-flight changed references when the accepted Main Session text clears', async () => {
        featureEnabledState.reviewComments = false;
        sendMessageSpy.mockClear();
        resumeSessionSpy.mockClear();
        uploadSpy.mockClear();
        modalAlertSpy.mockClear();
        resolveSessionComposerSendMock.mockClear();
        reviewCommentDraftsState.current = [];
        deleteWorkspaceReviewCommentDraftSpy.mockClear();
        pendingFireAndForget.length = 0;

        let resolveUpload: (() => void) | null = null;
        const uploadStarted = new Promise<void>((resolveStarted) => {
            uploadSpy.mockImplementationOnce(async () => {
                resolveStarted();
                return await new Promise((resolve) => {
                    resolveUpload = () => resolve({ success: true, path: 'p1', sizeBytes: 1, sha256: 'h1' });
                });
            });
        });
        let acceptHandoff: (() => void) | null = null;
        const sendStarted = new Promise<void>((resolveStarted) => {
            sendMessageSpy.mockImplementationOnce(async (...args: any[]) => {
                const options = args[4] as
                    | { onLocalPendingProjectionCreated?: (event: Readonly<{ localId: string }>) => void }
                    | undefined;
                acceptHandoff = () => options?.onLocalPendingProjectionCreated?.({ localId: 'reference-local-id' });
                resolveStarted();
            });
        });

        let tree: renderer.ReactTestRenderer | undefined;
        try {
            tree = (await renderScreen(<AppPaneProvider>
                        <SessionView id="s1" />
                    </AppPaneProvider>)).tree;

            const renderedTree = tree;
            if (!renderedTree) throw new Error('SessionView test renderer did not mount');
            let agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onChangeText', 'Use @accepted.ts and @newer.ts', 'AgentInput');
            });

            const sessionRef = { kind: 'session' as const, sessionId: 's1' };
            await act(async () => {
                const current = readComposerPresentationSnapshot(sessionRef);
                if (!current) throw new Error('expected active Session Composer snapshot');
                expect(current).toMatchObject({
                    text: 'Use @accepted.ts and @newer.ts',
                    capabilities: { references: true },
                });
                expect(applyComposerPresentationTransaction({
                    ref: sessionRef,
                    transaction: {
                        expectedRevision: current.revision,
                        operations: [{
                            kind: 'reference.insert',
                            reference: {
                                kind: 'partner.reference',
                                ref: 'partner:accepted',
                                token: '@accepted.ts',
                                start: 4,
                                end: 16,
                                label: 'Accepted issue',
                            },
                        }],
                    },
                }).status).toBe('applied');
            });

            agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onAttachmentsAdded', [
                    { name: 'a.txt', size: 1, type: 'text/plain', slice: () => new Blob([new Uint8Array([97])]) } as any,
                ], 'AgentInput');
            });

            agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onSend', undefined, 'AgentInput');
            });
            expect(pendingFireAndForget).toHaveLength(1);
            await act(async () => {
                await uploadStarted;
            });

            const newerMention = {
                kind: 'partner.reference',
                ref: 'partner:newer',
                tokenText: '@newer.ts',
                label: 'Newer issue',
            } as const;
            agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            const onStructuredInputMentionsChange = agentInput.props.onStructuredInputMentionsChange;
            if (typeof onStructuredInputMentionsChange !== 'function') {
                throw new Error('expected SessionView to expose the structured-mention owner');
            }
            await act(async () => {
                onStructuredInputMentionsChange([newerMention]);
            });
            agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            expect(agentInput.props.value).toBe('Use @accepted.ts and @newer.ts');
            expect(readSessionDraftValue(
                TEST_SERVER_ACCOUNT_SCOPE,
                's1',
                'structuredInput.mentions',
            )).toEqual(expect.arrayContaining([
                expect.objectContaining({ ref: newerMention.ref, tokenText: newerMention.tokenText }),
            ]));

            await act(async () => {
                if (!resolveUpload) throw new Error('attachment upload did not start');
                resolveUpload();
                await sendStarted;
            });

            await act(async () => {
                if (!acceptHandoff) throw new Error('local pending projection callback was not registered');
                acceptHandoff();
                await pendingFireAndForget[0];
            });

            agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            expect(readSessionDraftValue(
                TEST_SERVER_ACCOUNT_SCOPE,
                's1',
                'structuredInput.mentions',
            )).toBeUndefined();
            expect(agentInput.props.value).toBe('');
        } finally {
            act(() => {
                tree?.unmount();
            });
            pendingFireAndForget.length = 0;
        }
    });

    it('restores text and attachment drafts when outbound handoff after upload fails', async () => {
        featureEnabledState.reviewComments = false;
        sendMessageSpy.mockClear();
        resumeSessionSpy.mockClear();
        uploadSpy.mockClear();
        modalAlertSpy.mockClear();
        resolveSessionComposerSendMock.mockClear();
        reviewCommentDraftsState.current = [];
        deleteWorkspaceReviewCommentDraftSpy.mockClear();
        pendingFireAndForget.length = 0;

        uploadSpy.mockResolvedValueOnce({ success: true, path: 'p1', sizeBytes: 1, sha256: 'h1' });

        let rejectSend: (() => void) | null = null;
        const sendStarted = new Promise<void>((resolveStarted) => {
            sendMessageSpy.mockImplementationOnce(async (...args: any[]) => {
                const options = args[4] as
                    | { onLocalPendingProjectionCreated?: (event: Readonly<{ localId: string }>) => void }
                    | undefined;
                options?.onLocalPendingProjectionCreated?.({ localId: 'attachment-local-id' });
                resolveStarted();
                return await new Promise<void>((_resolve, reject) => {
                    rejectSend = () => reject(new Error('attachment handoff rejected'));
                });
            });
        });

        let tree: renderer.ReactTestRenderer | undefined;
        try {
            tree = (await renderScreen(<AppPaneProvider>
                        <SessionView id="s1" />
                    </AppPaneProvider>)).tree;

            pendingFireAndForget.length = 0;

            const renderedTree = tree;
            expect(renderedTree).toBeDefined();
            if (!renderedTree) throw new Error('SessionView test renderer did not mount');

            let agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onChangeText', 'Describe this image', 'AgentInput');
            });
            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onAttachmentsAdded', [
                    { name: 'a.txt', size: 1, type: 'text/plain', slice: () => new Blob([new Uint8Array([97])]) } as any,
                ], 'AgentInput');
            });

            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onSend', undefined, 'AgentInput');
            });

            expect(pendingFireAndForget.length).toBe(1);
            await act(async () => {
                await sendStarted;
            });

            agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            expect(agentInput.props.value).toBe('');
            expect(agentInput.props.attachmentRowItems).toEqual([]);

            await act(async () => {
                if (!rejectSend) throw new Error('send did not start');
                rejectSend();
                await pendingFireAndForget[0];
            });

            agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            expect(agentInput.props.value).toBe('Describe this image');
            expect(agentInput.props.attachmentRowItems).toEqual([
                expect.objectContaining({ label: 'a.txt', status: 'uploaded' }),
            ]);
            expect(modalAlertSpy).toHaveBeenCalledWith('common.error', 'attachment handoff rejected');
        } finally {
            act(() => {
                tree?.unmount();
            });
            pendingFireAndForget.length = 0;
        }
    });

    it('does not restore a failed attachment send over a newer attachment-only draft', async () => {
        featureEnabledState.reviewComments = false;
        sendMessageSpy.mockClear();
        resumeSessionSpy.mockClear();
        uploadSpy.mockClear();
        modalAlertSpy.mockClear();
        resolveSessionComposerSendMock.mockClear();
        reviewCommentDraftsState.current = [];
        deleteWorkspaceReviewCommentDraftSpy.mockClear();
        pendingFireAndForget.length = 0;

        uploadSpy.mockResolvedValueOnce({ success: true, path: 'p1', sizeBytes: 1, sha256: 'h1' });

        let rejectSend: (() => void) | null = null;
        const sendStarted = new Promise<void>((resolveStarted) => {
            sendMessageSpy.mockImplementationOnce(async (...args: any[]) => {
                const options = args[4] as
                    | { onLocalPendingProjectionCreated?: (event: Readonly<{ localId: string }>) => void }
                    | undefined;
                options?.onLocalPendingProjectionCreated?.({ localId: 'attachment-local-id' });
                resolveStarted();
                return await new Promise<void>((_resolve, reject) => {
                    rejectSend = () => reject(new Error('attachment handoff rejected'));
                });
            });
        });

        let tree: renderer.ReactTestRenderer | undefined;
        try {
            tree = (await renderScreen(<AppPaneProvider>
                        <SessionView id="s1" />
                    </AppPaneProvider>)).tree;

            pendingFireAndForget.length = 0;

            const renderedTree = tree;
            expect(renderedTree).toBeDefined();
            if (!renderedTree) throw new Error('SessionView test renderer did not mount');

            let agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onChangeText', 'Describe this image', 'AgentInput');
            });
            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onAttachmentsAdded', [
                    { name: 'a.txt', size: 1, type: 'text/plain', slice: () => new Blob([new Uint8Array([97])]) } as any,
                ], 'AgentInput');
            });

            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onSend', undefined, 'AgentInput');
            });

            expect(pendingFireAndForget.length).toBe(1);
            await act(async () => {
                await sendStarted;
            });

            agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            expect(agentInput.props.value).toBe('');
            expect(agentInput.props.attachmentRowItems).toEqual([]);

            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onAttachmentsAdded', [
                    { name: 'next.txt', size: 1, type: 'text/plain', slice: () => new Blob([new Uint8Array([98])]) } as any,
                ], 'AgentInput');
            });

            await act(async () => {
                if (!rejectSend) throw new Error('send did not start');
                rejectSend();
                await pendingFireAndForget[0];
            });

            agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            expect(agentInput.props.value).toBe('');
            expect(agentInput.props.attachmentRowItems).toEqual([
                expect.objectContaining({ label: 'next.txt' }),
            ]);
            expect(modalAlertSpy).toHaveBeenCalledWith('common.error', 'attachment handoff rejected');
        } finally {
            act(() => {
                tree?.unmount();
            });
            pendingFireAndForget.length = 0;
        }
    });

    it('sends review comments and attachments with both structured metadata envelopes', async () => {
        featureEnabledState.reviewComments = true;
        reviewCommentDraftsState.current = [{
            id: 'draft-1',
            filePath: 'src/a.ts',
            source: 'diff',
            anchor: {
                kind: 'diffLine',
                startLine: 1,
                side: 'after',
                oldLine: 1,
                newLine: 1,
            },
            snapshot: {
                selectedLines: ['+export const a = 2;'],
                beforeContext: ['-export const a = 1;'],
                afterContext: [],
            },
            body: 'Please verify this project change.',
            createdAt: 1,
        }];
        sendMessageSpy.mockClear();
        resumeSessionSpy.mockClear();
        uploadSpy.mockClear();
        modalAlertSpy.mockClear();
        resolveSessionComposerSendMock.mockClear();
        deleteWorkspaceReviewCommentDraftSpy.mockClear();
        pendingFireAndForget.length = 0;

        let tree: renderer.ReactTestRenderer | undefined;
        try {
            tree = (await renderScreen(<AppPaneProvider>
                        <SessionView id="s1" />
                    </AppPaneProvider>)).tree;

            pendingFireAndForget.length = 0;

            const renderedTree = tree;
            expect(renderedTree).toBeDefined();
            if (!renderedTree) throw new Error('SessionView test renderer did not mount');

            const agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onAttachmentsAdded', [
                    { name: 'a.txt', size: 1, type: 'text/plain', slice: () => new Blob([new Uint8Array([97])]) } as any,
                ], 'AgentInput');
            });

            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onSend', undefined, 'AgentInput');
            });

            expect(pendingFireAndForget.length).toBe(1);
            await pendingFireAndForget[0];

            expect(sendMessageSpy).toHaveBeenCalledTimes(1);
            const [sentSessionId, sentText, sentDisplayText, sentMetaOverrides] = sendMessageSpy.mock.calls[0] ?? [];
            expect(sentSessionId).toBe('s1');
            expect(String(sentText)).toContain('Review comments:');
            expect(String(sentText)).toContain('[attachments]');
            expect(sentDisplayText).toContain('Review comments (1)');
            expect(sentDisplayText).toContain('[attachments]');
            expect(sentMetaOverrides).toMatchObject({
                happier: {
                    kind: 'review_comments.v1',
                    payload: {
                        comments: [expect.objectContaining({ id: 'draft-1' })],
                    },
                },
                happierAttachments: {
                    kind: 'attachments.v1',
                    payload: {
                        attachments: [
                            expect.objectContaining({
                                name: 'a.txt',
                                path: 'p1',
                            }),
                        ],
                    },
                },
            });
            expect(deleteWorkspaceReviewCommentDraftSpy).toHaveBeenCalledWith('server-1:m1:/tmp', 'draft-1');
        } finally {
            featureEnabledState.reviewComments = false;
            reviewCommentDraftsState.current = [];
            act(() => {
                tree?.unmount();
            });
            pendingFireAndForget.length = 0;
        }
    });

    // The composer has two destinations, and starting an Agent is the one step
    // that cannot be taken back. An inactive Session resumed on the way to an
    // ARMED send starts the source Agent — the very Agent the reader chose to
    // leave — which spends provider work and can make the transition fail
    // non-idle. So the destination decision must happen before any Agent-runtime
    // side effect, not after the upload.
    describe('armed Agent continuation', () => {
        const armSecondAgent = () => {
            armedContinuationState.intent = {
                v: 1,
                mode: 'same_session',
                sourceAgentId: 'codex',
                selection: { v: 1, agentId: 'claude' },
            };
            armedContinuationState.localId = 'armed-local-id';
            armedContinuationState.submissionIntent = null;
        };

        async function sendOneAttachment(tree: renderer.ReactTestRenderer) {
            const agentInput = findTestInstanceByTypeWithProps(tree, 'AgentInput' as any, {}) as any;
            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onAttachmentsAdded', [
                    { name: 'a.txt', size: 1, type: 'text/plain', slice: () => new Blob([new Uint8Array([97])]) } as any,
                ], 'AgentInput');
            });
            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onSend', undefined, 'AgentInput');
            });
            expect(pendingFireAndForget.length).toBe(1);
            await pendingFireAndForget[0];
        }

        // The switch runs on THIS Session's server, and neither the daemon nor
        // the server re-gates the transition, so the scope of this one decision
        // IS the gate. Resolving it against whichever servers happen to be
        // selected in the sidebar makes an unrelated server's setting decide
        // whether this Session may switch Agent.
        it('resolves the Agent-switching gate against this Session\'s server', async () => {
            let tree: renderer.ReactTestRenderer | undefined;
            try {
                tree = (await renderScreen(<AppPaneProvider>
                            <SessionView id="s1" />
                        </AppPaneProvider>)).tree;
                expect(useFeatureDecisionSpy).toHaveBeenCalledWith(
                    'sessions.agentSwitching',
                    expect.objectContaining({ scopeKind: 'spawn', serverId: 'server-1' }),
                );
            } finally {
                act(() => {
                    tree?.unmount();
                });
                pendingFireAndForget.length = 0;
            }
        });

        it('does not start the inactive source Agent when the send is armed for another Agent', async () => {
            armSecondAgent();

            let tree: renderer.ReactTestRenderer | undefined;
            try {
                tree = (await renderScreen(<AppPaneProvider>
                            <SessionView id="s1" />
                        </AppPaneProvider>)).tree;
                pendingFireAndForget.length = 0;
                const renderedTree = tree;
                if (!renderedTree) throw new Error('SessionView test renderer did not mount');

                await sendOneAttachment(renderedTree);

                expect(resumeSessionSpy).not.toHaveBeenCalled();
                expect(sendMessageSpy).not.toHaveBeenCalled();
                expect(enqueuePendingMessageSpy).not.toHaveBeenCalled();
                expect(runSessionAgentTransitionSpy).toHaveBeenCalledTimes(1);
                const [transitionInput] = runSessionAgentTransitionSpy.mock.calls[0] ?? [];
                expect(transitionInput).toMatchObject({
                    machineId: 'm1',
                    request: {
                        sessionId: 's1',
                        expectedCurrentAgentId: 'codex',
                        selection: { agentId: 'claude' },
                        input: { localId: 'armed-local-id' },
                    },
                });
                expect(String((transitionInput as any)?.request?.input?.text ?? '')).toContain('a.txt');
            } finally {
                act(() => {
                    tree?.unmount();
                });
                pendingFireAndForget.length = 0;
            }
        });

        it('records the exact nested handoff before the transition RPC starts', async () => {
            armSecondAgent();

            let tree: renderer.ReactTestRenderer | undefined;
            try {
                tree = (await renderScreen(<AppPaneProvider>
                            <SessionView id="s1" />
                        </AppPaneProvider>)).tree;
                if (!tree) throw new Error('SessionView test renderer did not mount');

                await sendOneAttachment(tree);

                expect(recordArmedContinuationSubmissionSpy).toHaveBeenCalledWith(expect.objectContaining({
                    localId: 'armed-local-id',
                    input: expect.objectContaining({ localId: 'armed-local-id' }),
                    currentness: expect.objectContaining({
                        text: '',
                        attachmentDraftIds: [expect.any(String)],
                    }),
                }));
                expect(recordArmedContinuationSubmissionSpy.mock.invocationCallOrder[0])
                    .toBeLessThan(runSessionAgentTransitionSpy.mock.invocationCallOrder[0]!);
            } finally {
                act(() => { tree?.unmount(); });
                pendingFireAndForget.length = 0;
            }
        });

        async function sendArmedAndReadBanner(result: unknown) {
            armSecondAgent();
            runSessionAgentTransitionSpy.mockImplementationOnce(async () => result as any);
            const screen = await renderScreen(<AppPaneProvider>
                        <SessionView id="s1" />
                    </AppPaneProvider>);
            pendingFireAndForget.length = 0;
            if (!screen.tree) throw new Error('SessionView test renderer did not mount');
            await sendOneAttachment(screen.tree);
            return screen;
        }

        it('tells the reader through the composer banner instead of a modal they must dismiss', async () => {
            // The switch happened and the message did not. A modal buries that
            // under an OK button and leaves the composer looking ordinary; the
            // banner sits above the composer the reader is about to use again.
            const screen = await sendArmedAndReadBanner({
                type: 'partially_applied',
                localId: 'armed-local-id',
                applied: 'current_view_committed',
                code: 'divider_unavailable',
            });
            try {
                expect(modalAlertSpy).not.toHaveBeenCalled();
                expect(screen.findAllByTestId('session.agentTransitionOutcome.banner').length).toBeGreaterThan(0);
                expect(screen.getTextContent())
                    .toContain('session.agentContinuation.transition.switched');
                // Collapsing must demote the signal to a badge, never destroy it,
                // so the banner always publishes one into the composer action bar.
                const agentInput = findTestInstanceByTypeWithProps(screen.tree, 'AgentInput' as any, {}) as any;
                const badges = (agentInput?.props?.statusBadges ?? []) as ReadonlyArray<{ testID?: string }>;
                expect(badges.some((badge) => badge.testID === 'session.agentTransitionOutcome.badge')).toBe(true);
            } finally {
                act(() => { screen.tree?.unmount(); });
                pendingFireAndForget.length = 0;
            }
        });

        it('delegates the committed-but-inactive recovery to the Session resume owner', async () => {
            // The Session already IS the target and has no live runtime, so the
            // one factual recovery is to start it — through the same resume owner
            // every other inactive-session affordance uses, not a second start
            // path owned by the banner.
            const screen = await sendArmedAndReadBanner({
                type: 'partially_applied',
                localId: 'armed-local-id',
                applied: 'current_view_committed',
                code: 'divider_unavailable',
            });
            try {
                resumeSessionSpy.mockClear();
                await act(async () => {
                    await screen.pressByTestIdAsync('session.agentTransitionOutcome.resume');
                });
                expect(resumeSessionSpy).toHaveBeenCalledTimes(1);
            } finally {
                act(() => { screen.tree?.unmount(); });
                pendingFireAndForget.length = 0;
            }
        });

        it('hands a switch whose input is already queued to the Session queued-message owner', async () => {
            // `target_start_failed` is only reachable after the daemon admitted
            // this exact localId, so telling the reader "your message wasn't
            // sent. Send it again." is false — and following it duplicates the
            // message, because the spent arm makes the retry an ordinary send
            // under a fresh identity. The true state — admitted input, no
            // runtime — is the one the Session's queued-message banner already
            // owns, so it is raised instead of a second banner beside it.
            const screen = await sendArmedAndReadBanner({
                type: 'partially_applied',
                localId: 'armed-local-id',
                applied: 'current_view_committed',
                code: 'target_start_failed',
            });
            try {
                expect(modalAlertSpy).not.toHaveBeenCalled();
                expect(screen.getTextContent())
                    .not.toContain('session.agentContinuation.transition.switched');
                expect(screen.findAllByTestId('session.agentTransitionOutcome.banner')).toHaveLength(0);
                expect(screen.findAllByTestId('session-pendingQueue-resumeFailed').length)
                    .toBeGreaterThan(0);
            } finally {
                act(() => { screen.tree?.unmount(); });
                pendingFireAndForget.length = 0;
            }
        });

        /**
         * The real ordering, and the one the case below this seeds away: the
         * daemon answers, and the canonical pending row for that exact localId
         * reaches this client a beat later. Notifying the pending-message
         * listeners is that sync arriving — the same re-render the store
         * publishes in production.
         */
        function syncPendingRowForLocalId(localId: string) {
            canonicalSessionPendingState.s1 = {
                messages: [{
                    id: `pending-${localId}`,
                    localId,
                    createdAt: 1,
                    updatedAt: 1,
                    source: 'server_pending',
                    text: 'queued message',
                    rawRecord: { role: 'user', content: { type: 'text', text: 'queued message' } },
                }],
                discarded: [],
                isLoaded: true,
            } as SessionPending;
            act(() => {
                for (const listener of sessionPendingMessagesState.listeners) listener();
            });
        }

        it('tells the reader when custody of the queued input only lands after the switch answered', async () => {
            // The case below seeds the pending row BEFORE the send, so it passes
            // whether or not custody is watched. A real Session cannot: the row is
            // written after the RPC returns, and a disposition decided once
            // against `absent` and never re-decided is exactly how this arm
            // reached a reader saying nothing at all.
            const screen = await sendArmedAndReadBanner({ type: 'accepted', localId: 'armed-local-id' });
            try {
                expect(modalAlertSpy).not.toHaveBeenCalled();
                // Nothing yet, correctly: no canonical fact has arrived.
                expect(screen.findAllByTestId('session-pendingQueue-resumeFailed')).toHaveLength(0);

                syncPendingRowForLocalId('armed-local-id');

                expect(screen.findAllByTestId('session-pendingQueue-resumeFailed').length)
                    .toBeGreaterThan(0);
                // Never an invitation to send the same input twice: the only action
                // is the Session's own resume owner, which drains the queue.
                expect(screen.findAllByTestId('session-pendingQueue-resumeFailed-retry').length)
                    .toBeGreaterThan(0);
            } finally {
                act(() => { screen.tree?.unmount(); });
                pendingFireAndForget.length = 0;
            }
        });

        it('does not let a live Session view silence an activation failure the daemon proved', async () => {
            // `target_start_failed` is the daemon's own account: the input was
            // admitted and the target then failed to start. A client-side liveness
            // read must never weaken a definite daemon arm, so this must be stated
            // even while this client still believes the Session is running.
            const restoreActive = sessionState.session.active;
            const restorePresence = sessionState.session.presence;
            sessionState.session.active = true;
            sessionState.session.presence = 'online';
            const screen = await sendArmedAndReadBanner({
                type: 'partially_applied',
                localId: 'armed-local-id',
                applied: 'current_view_committed',
                code: 'target_start_failed',
            });
            try {
                const queuedWarning = screen.findByTestId('session-pendingQueue-resumeFailed');
                expect(queuedWarning).toBeTruthy();
                // The input is already in canonical custody. The existing
                // queued-message banner and resume handler stay authoritative,
                // but its action must not imply resending it.
                const retry = screen.findByTestId('session-pendingQueue-resumeFailed-retry');
                expect(retry).toBeTruthy();
                expect(retry?.props.accessibilityLabel)
                    .toBe('session.agentContinuation.transition.resumeAction');
                expect(retry?.findAll((node) => (
                    node.props.children === 'session.agentContinuation.transition.resumeAction'
                )).length).toBeGreaterThan(0);
            } finally {
                sessionState.session.active = restoreActive;
                sessionState.session.presence = restorePresence;
                act(() => { screen.tree?.unmount(); });
                pendingFireAndForget.length = 0;
            }
        });

        it('does not go silent when an ACCEPTED switch leaves the message behind a target that never came up', async () => {
            // The real failure: `accepted` came back, the target runtime died,
            // and the reader was told NOTHING — new Agent on screen, message
            // never processed, Session inactive, no banner. `accepted` only ever
            // meant "spawn acknowledged"; there is no readiness wait behind it.
            canonicalSessionPendingState.s1 = {
                messages: [{
                    id: 'pending-armed-local-id',
                    localId: 'armed-local-id',
                    createdAt: 1,
                    updatedAt: 1,
                    source: 'server_pending',
                    text: 'queued message',
                    rawRecord: { role: 'user', content: { type: 'text', text: 'queued message' } },
                }],
                discarded: [],
                isLoaded: true,
            };
            const screen = await sendArmedAndReadBanner({ type: 'accepted', localId: 'armed-local-id' });
            try {
                expect(modalAlertSpy).not.toHaveBeenCalled();
                // Still no second banner of its own — the Session's existing
                // queued-message owner says it, exactly as for `target_start_failed`.
                expect(screen.findAllByTestId('session.agentTransitionOutcome.banner')).toHaveLength(0);
                expect(screen.findAllByTestId('session-pendingQueue-resumeFailed').length)
                    .toBeGreaterThan(0);
            } finally {
                act(() => { screen.tree?.unmount(); });
                pendingFireAndForget.length = 0;
            }
        });

        it('stays silent for an ACCEPTED switch whose message a runtime already carried', async () => {
            // The other half of the same rule. This arm stays live for the whole
            // Session, so a Session that answered and then idled out must not be
            // reported as one whose message never went. Nothing is queued here.
            const screen = await sendArmedAndReadBanner({ type: 'accepted', localId: 'armed-local-id' });
            try {
                expect(screen.findAllByTestId('session-pendingQueue-resumeFailed')).toHaveLength(0);
                expect(screen.findAllByTestId('session.agentTransitionOutcome.banner')).toHaveLength(0);
            } finally {
                act(() => { screen.tree?.unmount(); });
                pendingFireAndForget.length = 0;
            }
        });

        it('offers no retry at all for an outcome nothing has established', async () => {
            const screen = await sendArmedAndReadBanner({ type: 'outcome_unknown', localId: 'armed-local-id' });
            try {
                expect(modalAlertSpy).not.toHaveBeenCalled();
                expect(screen.getTextContent())
                    .toContain('session.agentContinuation.transition.unknown');
                // A blind retry against an effect that may already have happened
                // is the one action this state must never expose.
                expect(screen.findAllByTestId('session.agentTransitionOutcome.resume')).toHaveLength(0);
                // Reconciliation reads canonical Session/message truth through the
                // owners that already publish it — no status operation of its own.
                expect(ensureSessionVisibleSpy).toHaveBeenCalledWith('s1', expect.objectContaining({ forceRefresh: true }));
                expect(refreshSessionMessagesSpy).toHaveBeenCalledWith('s1');
            } finally {
                act(() => { screen.tree?.unmount(); });
                pendingFireAndForget.length = 0;
            }
        });

        /**
         * A text send through the armed destination, so the composer's persisted
         * draft can restore after a remount, but its retained arm blocks dispatch
         * until canonical reconciliation settles.
         */
        async function sendArmedText(result: unknown, text: string) {
            armSecondAgent();
            resolveSessionComposerSendMock.mockImplementationOnce(() => ({ kind: 'send', text }));
            runSessionAgentTransitionSpy.mockImplementationOnce(async () => result as any);
            const screen = await renderScreen(<AppPaneProvider>
                        <SessionView id="s1" />
                    </AppPaneProvider>);
            pendingFireAndForget.length = 0;
            if (!screen.tree) throw new Error('SessionView test renderer did not mount');
            const agentInput = findTestInstanceByTypeWithProps(screen.tree, 'AgentInput' as any, {}) as any;
            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onChangeText', text, 'AgentInput');
            });
            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onSend', undefined, 'AgentInput');
            });
            for (const pending of [...pendingFireAndForget]) await pending;
            const [transitionDispatch] = runSessionAgentTransitionSpy.mock.calls[0] ?? [];
            expect((transitionDispatch as any)?.request?.input).toEqual({
                text,
                localId: 'armed-local-id',
                meta: {},
            });
            return screen;
        }

        it('reconciles a retained submission after its old arm is no longer a next-message promise', async () => {
            armedContinuationState.intent = null;
            armedContinuationState.localId = null;
            armedContinuationState.submissionIntent = {
                v: 1,
                mode: 'same_session',
                sourceAgentId: 'codex',
                selection: { v: 1, agentId: 'claude' },
            };
            armedContinuationState.submission = {
                localId: 'retained-submission-id',
                input: {
                    localId: 'retained-submission-id',
                    text: 'switch and send this',
                    meta: {},
                },
                currentness: {
                    text: 'switch and send this',
                    mentions: [],
                    composerAttachments: [],
                    attachmentDraftIds: [],
                },
            };
            resolveSessionComposerSendMock.mockImplementationOnce(() => ({ kind: 'send', text: 'switch and send this' }));
            let settleCanonicalRefresh: () => void = () => {};
            const canonicalRefresh = new Promise<void>((resolve) => {
                settleCanonicalRefresh = resolve;
            });
            ensureSessionVisibleSpy.mockImplementationOnce(async () => {
                await canonicalRefresh;
                return { kind: 'available' };
            });
            refreshSessionMessagesSpy.mockImplementationOnce(async () => {
                await canonicalRefresh;
            });

            const screen = await renderScreen(<AppPaneProvider>
                        <SessionView id="s1" />
                    </AppPaneProvider>);
            try {
                expect(screen.getTextContent()).toContain('session.agentContinuation.transition.unknown');
                const agentInput = findTestInstanceByTypeWithProps(screen.tree!, 'AgentInput' as any, {}) as any;
                await act(async () => {
                    invokeTestInstanceHandler(agentInput, 'onSend', undefined, 'AgentInput');
                });

                // The old transition has no live arm to route through, but its
                // exact localId still blocks a fresh send until existing custody
                // readers establish whether it was admitted.
                expect(sendMessageSpy).not.toHaveBeenCalled();
                expect(enqueuePendingMessageSpy).not.toHaveBeenCalled();
                expect(runSessionAgentTransitionSpy).not.toHaveBeenCalled();
                expect(ensureSessionVisibleSpy).toHaveBeenCalledWith(
                    's1',
                    expect.objectContaining({ forceRefresh: true }),
                );
                expect(refreshSessionMessagesSpy).toHaveBeenCalledWith('s1');

                syncPendingRowForLocalId('retained-submission-id');
                settleCanonicalRefresh();
                await act(async () => {
                    await Promise.resolve();
                    await Promise.resolve();
                });

                expect(clearPersistedArmedContinuationSubmissionSpy).toHaveBeenCalledWith(
                    expect.objectContaining({ localId: 'retained-submission-id' }),
                );
            } finally {
                act(() => { screen.tree?.unmount(); });
                pendingFireAndForget.length = 0;
            }
        });

        it('blocks a remounted nested submission until reconciliation reads canonical custody', async () => {
            const first = await sendArmedText(
                { type: 'outcome_unknown', localId: 'armed-local-id' },
                'first submitted text',
            );
            try {
                expect(armedContinuationState.submission).toMatchObject({
                    localId: 'armed-local-id',
                    input: { text: 'first submitted text' },
                });
            } finally {
                act(() => { first.tree?.unmount(); });
                pendingFireAndForget.length = 0;
            }

            runSessionAgentTransitionSpy.mockClear();
            ensureSessionVisibleSpy.mockClear();
            refreshSessionMessagesSpy.mockClear();
            let settleCanonicalRefresh: () => void = () => {};
            const canonicalRefresh = new Promise<void>((resolve) => {
                settleCanonicalRefresh = resolve;
            });
            ensureSessionVisibleSpy.mockImplementationOnce(async () => {
                await canonicalRefresh;
                return { kind: 'available' };
            });
            refreshSessionMessagesSpy.mockImplementationOnce(async () => {
                await canonicalRefresh;
            });
            const second = await renderScreen(<AppPaneProvider>
                        <SessionView id="s1" />
                    </AppPaneProvider>);
            try {
                const agentInput = findTestInstanceByTypeWithProps(second.tree!, 'AgentInput' as any, {}) as any;
                await act(async () => {
                    invokeTestInstanceHandler(agentInput, 'onChangeText', 'newer local draft', 'AgentInput');
                });
                await act(async () => {
                    invokeTestInstanceHandler(agentInput, 'onSend', undefined, 'AgentInput');
                });

                // A restored submission has no persisted daemon result to
                // replay. Until the existing one-shot refresh has read custody,
                // it is treated as the same unknown outcome and cannot dispatch
                // a second transition under the old localId.
                expect(runSessionAgentTransitionSpy).not.toHaveBeenCalled();
                expect(ensureSessionVisibleSpy).toHaveBeenCalledWith(
                    's1',
                    expect.objectContaining({ forceRefresh: true }),
                );
                expect(refreshSessionMessagesSpy).toHaveBeenCalledWith('s1');

                syncPendingRowForLocalId('armed-local-id');
                settleCanonicalRefresh();
                await act(async () => {
                    await Promise.resolve();
                    await Promise.resolve();
                });

                // Once custody has arrived, the canonical disposition spends
                // the arm rather than offering the same transition again.
                expect(clearArmedContinuationSpy).toHaveBeenCalled();
            } finally {
                act(() => { second.tree?.unmount(); });
                pendingFireAndForget.length = 0;
            }
        });

        // The narrower half: the answer that resolves an unestablished switch
        // routinely arrives after the call returned. Taking the notice down
        // while leaving the message in the composer is the same duplicate one
        // tap away.
        it('compare-clears the unchanged submitted draft when custody only lands later', async () => {
            const screen = await sendArmedText(
                { type: 'outcome_unknown', localId: 'armed-local-id' },
                'switch and send this',
            );
            try {
                expect(screen.getTextContent()).toContain('session.agentContinuation.transition.unknown');
                expect(readSessionShellDraftTextForTest('s1')).toBe('switch and send this');

                syncPendingRowForLocalId('armed-local-id');

                expect(screen.getTextContent()).not.toContain('session.agentContinuation.transition.unknown');
                expect(screen.findAllByTestId('session.agentTransitionOutcome.banner')).toHaveLength(0);
                expect(readSessionShellDraftTextForTest('s1')).toBe('');
                // The arm goes with the draft: this depth spends the switch.
                expect(clearArmedContinuationSpy).toHaveBeenCalled();
            } finally {
                act(() => { screen.tree?.unmount(); });
                pendingFireAndForget.length = 0;
            }
        });

        // A draft the reader has since rewritten is not the submitted one, and
        // taking it away would destroy work to tidy up a banner.
        it('leaves an edited draft alone when custody of the submitted one lands', async () => {
            const screen = await sendArmedText(
                { type: 'outcome_unknown', localId: 'armed-local-id' },
                'switch and send this',
            );
            try {
                const agentInput = findTestInstanceByTypeWithProps(screen.tree!, 'AgentInput' as any, {}) as any;
                await act(async () => {
                    invokeTestInstanceHandler(agentInput, 'onChangeText', 'a different message', 'AgentInput');
                });

                syncPendingRowForLocalId('armed-local-id');

                expect(readSessionShellDraftTextForTest('s1')).toBe('a different message');
                // The rewritten text is a new message, so canonical custody
                // must spend the original arm/localId without clearing it.
                expect(clearArmedContinuationSpy).toHaveBeenCalled();
            } finally {
                act(() => { screen.tree?.unmount(); });
                pendingFireAndForget.length = 0;
            }
        });

        it('does not clear a newer same-target arm when the previous transition reaches custody', async () => {
            const screen = await sendArmedText(
                { type: 'outcome_unknown', localId: 'armed-local-id' },
                'switch and send this',
            );
            try {
                // The reader disarmed and selected the same target again. Its
                // intent happens to compare equal, but its localId names a new
                // transition and must not be spent by the old one's custody.
                armedContinuationState.localId = 'newer-armed-local-id';
                syncPendingRowForLocalId('armed-local-id');

                expect(clearArmedContinuationSpy).not.toHaveBeenCalled();
            } finally {
                act(() => { screen.tree?.unmount(); });
                pendingFireAndForget.length = 0;
            }
        });

        it('still resumes the inactive source Agent for an ordinary unarmed attachment send', async () => {
            let tree: renderer.ReactTestRenderer | undefined;
            try {
                tree = (await renderScreen(<AppPaneProvider>
                            <SessionView id="s1" />
                        </AppPaneProvider>)).tree;
                pendingFireAndForget.length = 0;
                const renderedTree = tree;
                if (!renderedTree) throw new Error('SessionView test renderer did not mount');

                await sendOneAttachment(renderedTree);

                expect(resumeSessionSpy).toHaveBeenCalled();
                expect(runSessionAgentTransitionSpy).not.toHaveBeenCalled();
                expect(sendMessageSpy).toHaveBeenCalledTimes(1);
            } finally {
                act(() => {
                    tree?.unmount();
                });
                pendingFireAndForget.length = 0;
            }
        });
    });
});
