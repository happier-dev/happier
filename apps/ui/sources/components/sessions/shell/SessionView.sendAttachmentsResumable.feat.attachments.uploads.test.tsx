import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { findTestInstanceByTypeWithProps, invokeTestInstanceHandler, renderScreen } from '@/dev/testkit';
import { installSessionShellCommonModuleMocks } from './sessionShellTestHelpers';
import { clearSessionAttachmentDrafts } from '@/components/sessions/attachments/sessionAttachmentDraftStore';
import { existingSessionDraftSemanticValues } from '@/sync/domains/input/drafts/existingSessionDraftSemanticValues';
import {
    captureSessionDraftCurrentness,
    clearSessionDraftCurrentness,
    deleteSessionDraft,
    getSessionDraftSnapshot,
    subscribeSessionDraft,
    writeExistingSessionDraft,
} from '@/sync/ops/sessionDrafts/sessionDraftRepository';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).__DEV__ = false;
const TEST_SERVER_ACCOUNT_SCOPE = { serverId: 'server-1', accountId: 'account-1' } as const;
const TEST_SESSION_DRAFT_ADDRESS = { kind: 'session' as const, sessionId: 's1' };
let authCredentials: any = { token: 't', secret: 's' };
const sessionState = vi.hoisted(() => ({
    session: {
        id: 's1',
        seq: 0,
        presence: 'online',
        active: true,
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
const sessionMachineTargetState = vi.hoisted(() => ({ available: false }));
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
const clearArmedContinuationSubmissionSpy = vi.hoisted(() => vi.fn(() => true));
const recordArmedContinuationSubmissionSpy = vi.hoisted(() => vi.fn());
const useFeatureEnabledSpy = vi.hoisted(() => vi.fn());
const useFeatureDecisionSpy = vi.hoisted(() => vi.fn());
const runSessionAgentTransitionSpy = vi.hoisted(() => vi.fn(async (..._args: any[]) => ({
    type: 'accepted' as const,
    localId: 'agent-transition:armed-local-id',
})));
const chooseSubmitModeState = vi.hoisted(() => ({
    mode: 'agent_queue',
}));
const reviewCommentDraftsState = vi.hoisted(() => ({
    current: [] as any[],
}));
const sessionPendingMessagesState = vi.hoisted(() => ({
    current: [] as any[],
    listeners: new Set<() => void>(),
}));
const sessionTranscriptIdsState = vi.hoisted(() => ({
    current: [] as string[],
}));
// The store slice the canonical custody reader consults, kept separate from the
// `useSessionPendingMessages` hook state so a case can model the real ordering:
// the transition RPC answers first, and the pending row syncs afterwards.
const sessionPendingStoreState = vi.hoisted(() => ({
    current: {} as Record<string, { messages: any[]; discarded: any[]; isLoaded: boolean }>,
}));
const deleteWorkspaceReviewCommentDraftSpy = vi.hoisted(() => vi.fn());
const draftHookState = vi.hoisted(() => ({
    valuesBySessionId: new Map<string, string>(),
}));
const chatListPropsSpy = vi.hoisted(() => vi.fn());

const pendingFireAndForget: Promise<unknown>[] = [];

const resolveSessionComposerSendMock = vi.fn((..._args: any[]) => ({ kind: 'send', text: 'hello' }));

vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    return createReanimatedModuleMock();
});
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
        return featureId === 'sessions.agentSwitching' ? { state: 'enabled' } : null;
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
    useDraft: (_sessionId: string, value: string, onChange: (next: string) => void) => {
        draftHookState.valuesBySessionId.set(_sessionId, value);
        const address = { kind: 'session' as const, sessionId: _sessionId };
        const draftSnapshot = React.useSyncExternalStore(
            (listener) => subscribeSessionDraft(TEST_SERVER_ACCOUNT_SCOPE, address, listener),
            () => getSessionDraftSnapshot(TEST_SERVER_ACCOUNT_SCOPE, address),
            () => getSessionDraftSnapshot(TEST_SERVER_ACCOUNT_SCOPE, address),
        );
        return {
            clearDraft: () => {
                draftHookState.valuesBySessionId.set(_sessionId, '');
                onChange('');
            },
            setDraftValue: (nextValueOrUpdater: string | ((currentValue: string) => string)) => {
                const currentValue = draftHookState.valuesBySessionId.get(_sessionId) ?? '';
                const nextValue = typeof nextValueOrUpdater === 'function'
                    ? nextValueOrUpdater(currentValue)
                    : nextValueOrUpdater;
                draftHookState.valuesBySessionId.set(_sessionId, nextValue);
                onChange(nextValue);
            },
            clearDraftForSessionIfCurrentValueMatches: (snapshot: Readonly<{ sessionId?: string; text: string }>) => {
                const targetSessionId = snapshot.sessionId ?? _sessionId;
                const currentValue = draftHookState.valuesBySessionId.get(targetSessionId) ?? '';
                if (currentValue !== snapshot.text) return false;
                draftHookState.valuesBySessionId.set(targetSessionId, '');
                if (targetSessionId === _sessionId) {
                    onChange('');
                }
                return true;
            },
            restoreDraftForSessionIfCurrentValueMatches: (
                snapshot: Readonly<{ sessionId?: string; text: string }>,
                expectedCurrentValue: string,
            ) => {
                const targetSessionId = snapshot.sessionId ?? _sessionId;
                const currentValue = draftHookState.valuesBySessionId.get(targetSessionId) ?? '';
                if (currentValue !== expectedCurrentValue) return false;
                draftHookState.valuesBySessionId.set(targetSessionId, snapshot.text);
                if (targetSessionId === _sessionId) {
                    onChange(snapshot.text);
                }
                return true;
            },
            restoreDraft: (draft: string) => {
                draftHookState.valuesBySessionId.set(_sessionId, draft);
                onChange(draft);
            },
            restoreComposerSnapshot: (snapshot: Readonly<{ sessionId?: string; text: string }>) => {
                const targetSessionId = snapshot.sessionId ?? _sessionId;
                draftHookState.valuesBySessionId.set(targetSessionId, snapshot.text);
                if (targetSessionId === _sessionId) {
                    onChange(snapshot.text);
                }
            },
            captureDraftForOutboundHandoff: () => ({
                sessionId: _sessionId,
                text: draftHookState.valuesBySessionId.get(_sessionId) ?? '',
                scope: TEST_SERVER_ACCOUNT_SCOPE,
                currentness: captureSessionDraftCurrentness({
                    scope: TEST_SERVER_ACCOUNT_SCOPE,
                    address,
                }),
            }),
            clearDraftCurrentness: (snapshot: Readonly<{ text: string; currentness?: any }>) => {
                if (!snapshot.currentness) return false;
                const currentText = draftHookState.valuesBySessionId.get(_sessionId) ?? '';
                if (currentText !== snapshot.text) {
                    writeExistingSessionDraft({
                        scope: TEST_SERVER_ACCOUNT_SCOPE,
                        sessionId: _sessionId,
                        patch: { text: currentText },
                    });
                }
                void clearSessionDraftCurrentness({
                    scope: TEST_SERVER_ACCOUNT_SCOPE,
                    address,
                    currentness: snapshot.currentness,
                });
                const remainingText = getSessionDraftSnapshot(TEST_SERVER_ACCOUNT_SCOPE, address)
                    ?.document.composer.text.value ?? '';
                draftHookState.valuesBySessionId.set(_sessionId, remainingText);
                onChange(remainingText);
                return true;
            },
            draftSnapshot,
            draftScope: TEST_SERVER_ACCOUNT_SCOPE,
        };
    },
}));
vi.mock('@/components/sessions/model/inactiveSessionUi', () => ({
    getInactiveSessionUiState: () => ({ noticeKind: 'none', inactiveStatusTextKey: null, shouldShowInput: true }),
}));
vi.mock('@/components/sessions/model/resolveSessionMachineReachability', () => ({
    resolveSessionMachineReachability: () => true,
}));
vi.mock('@/components/sessions/model/useSessionMachineReachability', () => ({
    useSessionMachineReachability: () => ({ machineReachable: true, machineOnline: true }),
}));
vi.mock('@/components/sessions/model/useSessionMachineTarget', () => ({
    useSessionMachineTarget: () => sessionMachineTargetState.available
        ? { machineId: 'm1', basePath: '/tmp' }
        : null,
    useSessionMachineControlTarget: () => sessionMachineTargetState.available
        ? { machineId: 'm1', basePath: '/tmp', confidence: 'reachable' }
        : null,
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => ({ serverId: 'server-1' }),
    subscribeActiveServer: () => () => {},
}));
vi.mock('@/voice/session/voiceSession', () => ({
    useVoiceSessionSnapshot: () => ({ status: 'disconnected' }),
    voiceSessionManager: {},
}));

const sendMessageSpy = vi.fn(async (..._args: any[]) => {});
const enqueuePendingMessageSpy = vi.fn(async (..._args: any[]) => ({ localId: 'pending-local-id' }));
const updatePendingMessageSpy = vi.fn(async (..._args: any[]) => {});

const ensureSessionVisibleSpy = vi.hoisted(() => vi.fn(async (..._args: any[]) => ({ kind: 'available' })));
const refreshSessionMessagesSpy = vi.hoisted(() => vi.fn(async (..._args: any[]) => {}));
vi.mock('@/sync/sync', () => ({
    sync: {
        markSessionViewed: async () => {},
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
        markSessionLiveTailIntent: () => {},
        sendMessage: (...args: any[]) => sendMessageSpy(...args),
        enqueuePendingMessage: (...args: any[]) => enqueuePendingMessageSpy(...args),
        updatePendingMessage: (...args: any[]) => updatePendingMessageSpy(...args),
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
        clearArmedContinuationSubmissionIfCurrent: clearArmedContinuationSubmissionSpy,
        recordArmedContinuationSubmission: (submission: unknown) => {
            recordArmedContinuationSubmissionSpy(submission);
            armedContinuationState.submission = submission;
            return true;
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
        const { createStorageModuleStub, createStorageStoreStub } = await import('@/dev/testkit/mocks/storage');
        const { settingsDefaults } = await import('@/sync/domains/settings/settings');
        return createStorageModuleStub({
            storage: createStorageStoreStub(() => ({
                    sessions: { s1: sessionState.session },
                    sessionPending: sessionPendingStoreState.current,
                    sessionMessages: {},
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
                    sessionListViewDataByServerId: {},
                    settings: {
                        ...settingsDefaults,
                        sessionMessageSendMode: 'agent_queue',
                    },
                    deleteWorkspaceReviewCommentDraft: deleteWorkspaceReviewCommentDraftSpy,
            })),
            useSession: () => sessionState.session,
            useIsDataReady: () => true,
            useRealtimeStatus: () => ({ status: 'connected' }),
            useSessionMessages: () => ({ messages: [], isLoaded: true }),
            useSessionTranscriptIds: () => ({ ids: sessionTranscriptIdsState.current, isLoaded: true }),
            useSessionPendingMessages: () => {
                const [, forceRender] = React.useState(0);
                React.useEffect(() => {
                    const listener = () => forceRender((value) => value + 1);
                    sessionPendingMessagesState.listeners.add(listener);
                    return () => {
                        sessionPendingMessagesState.listeners.delete(listener);
                    };
                }, []);
                return { messages: sessionPendingMessagesState.current };
            },
            useSessionSubagentSourceMessages: () => [],
            useSessionReviewCommentsDrafts: () => [],
            useWorkspaceReviewCommentsDrafts: () => reviewCommentDraftsState.current,
            useSessionUsage: () => null,
            useProfile: () => null,
            useActiveServerAccountScope: () => ({ serverId: 'server-1', accountId: 'account-1' }),
            useSetting: () => null,
            useSettings: () => ({ experiments: true, featureToggles: {} }),
            useAutomations: () => [],
            useSessionAutomationsEnabledCount: () => 0,
            useOpenApprovalArtifactsForSession: () => [],
            useMachine: () => ({
                id: 'm1',
                active: true,
                metadata: {
                    host: 'happy-host',
                    platform: 'darwin',
                    happyCliVersion: '0.0.0',
                    happyHomeDir: '/tmp',
                    homeDir: '/tmp',
                },
            }),
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

vi.mock('@/agents/catalog/catalog', async (importOriginal) => {
    const actual = await importOriginal<any>();
    return {
        ...actual,
        getAgentCore: () => ({
            model: { defaultMode: 'default' },
            cli: { spawnAgent: 'codex' },
            localControl: { supported: true },
            resume: {
                vendorResumeIdField: 'codexSessionId',
                supportsVendorResume: true,
                experimental: true,
            },
            uiConnectedService: { serviceId: null, label: 'Provider', connectRoute: null },
        }),
        resolveAgentIdFromFlavor: () => 'codex',
        DEFAULT_AGENT_ID: 'codex',
    };
});

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
        if (tag.startsWith('SessionView.sendMessage') || tag.startsWith('SessionView.pendingMessageEdit')) {
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
        pendingSupportState: chooseSubmitModeState.mode === 'agent_queue' ? 'unsupported' : 'supported',
        ...(chooseSubmitModeState.mode === 'agent_queue'
            ? { directBypassReason: 'selected_direct' }
            : chooseSubmitModeState.mode === 'interrupt'
                ? { directBypassReason: 'interrupt' }
                : {}),
    }),
    chooseSubmitMode: () => chooseSubmitModeState.mode,
    chooseForceImmediateSubmitMode: () => chooseSubmitModeState.mode,
    canDirectSubmitUserMessageNow: () => true,
    getPendingQueueSubmitSupportState: () => chooseSubmitModeState.mode === 'agent_queue' ? 'unsupported' : 'supported',
    isPendingQueueSubmitKnownUnsupported: () => chooseSubmitModeState.mode === 'agent_queue',
}));
vi.mock('@/sync/domains/session/control/localControlSwitch', () => ({
    shouldRenderChatTimelineForSession: () => true,
    shouldRequestRemoteControl: () => false,
    shouldRequestRemoteControlAfterPendingEnqueue: () => false,
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

const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
const { getInactiveSessionUiState } = await import('@/components/sessions/model/inactiveSessionUi');
const { SessionView } = await import('./SessionView');

describe('SessionView (attachments.uploads resumable send)', () => {
    beforeEach(() => {
        sessionState.session.active = true;
        sessionState.session.presence = 'online';
        sessionMachineTargetState.available = false;
        // Most cases exercise the legacy direct-send compatibility path: an
        // agent queue whose runtime is known not to support durable pending input.
        // Pending delivery has explicit cases below.
        chooseSubmitModeState.mode = 'agent_queue';
        enqueuePendingMessageSpy.mockClear();
        updatePendingMessageSpy.mockClear();
        chatListPropsSpy.mockClear();
        sessionPendingMessagesState.current = [];
        sessionPendingMessagesState.listeners.clear();
        sessionPendingStoreState.current = {};
        armedContinuationState.intent = null;
        armedContinuationState.localId = null;
        armedContinuationState.submission = null;
        armedContinuationState.submissionIntent = null;
        clearArmedContinuationSpy.mockClear();
        clearArmedContinuationSubmissionSpy.mockClear();
        recordArmedContinuationSubmissionSpy.mockClear();
        runSessionAgentTransitionSpy.mockClear();
        useFeatureEnabledSpy.mockClear();
        useFeatureDecisionSpy.mockClear();
        sessionTranscriptIdsState.current = [];
        draftHookState.valuesBySessionId.clear();
        clearSessionAttachmentDrafts('s1');
        void deleteSessionDraft({ scope: TEST_SERVER_ACCOUNT_SCOPE, address: TEST_SESSION_DRAFT_ADDRESS });
    });

    it('restores unsent attachment drafts when the session input remounts', async () => {
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
            expect(agentInput.props.attachments).toEqual([
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
            expect(agentInput.props.attachments).toEqual([
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

            expect(agentInput.props.attachments).toEqual(expect.arrayContaining([
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
            const canonicalSendCalls = [
                ...sendMessageSpy.mock.calls,
                ...enqueuePendingMessageSpy.mock.calls,
            ];
            expect(canonicalSendCalls).toHaveLength(1);

            const [sentSessionId, sentText, sentDisplayText, sentMetaOverrides] = canonicalSendCalls[0] ?? [];
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

    it('edits a queued message from what the transcript showed, not the expanded transport text', async () => {
        sessionPendingMessagesState.current = [{
            id: 'p-display',
            text: 'Review these\n\n<review-comments>\nsrc/a.ts:1 fix it\n</review-comments>',
            displayText: 'Review these',
            createdAt: 0,
            updatedAt: 0,
            localId: 'p-display',
            rawRecord: {},
        }];
        sessionTranscriptIdsState.current = ['m1'];
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

            const latestChatListProps = chatListPropsSpy.mock.calls
                .map((call) => call[0])
                .find((props) => typeof props?.onEditPendingMessage === 'function');
            expect(latestChatListProps?.onEditPendingMessage).toEqual(expect.any(Function));

            await act(async () => {
                await latestChatListProps.onEditPendingMessage({
                    id: 'p-display',
                    text: sessionPendingMessagesState.current[0].text,
                    displayText: sessionPendingMessagesState.current[0].displayText,
                    message: sessionPendingMessagesState.current[0],
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

    it('loads pending edits into the composer and saves them without sending a new message', async () => {
        sessionPendingMessagesState.current = [{
            id: 'p1',
            text: 'queued\nmessage',
            displayText: undefined,
            createdAt: 0,
            updatedAt: 0,
            localId: 'p1',
            rawRecord: {},
        }];
        sessionTranscriptIdsState.current = ['m1'];
        sendMessageSpy.mockClear();
        enqueuePendingMessageSpy.mockClear();
        updatePendingMessageSpy.mockClear();
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

            let agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onChangeText', 'unrelated draft', 'AgentInput');
            });

            const latestChatListProps = chatListPropsSpy.mock.calls
                .map((call) => call[0])
                .find((props) => typeof props?.onEditPendingMessage === 'function');
            expect(latestChatListProps?.onEditPendingMessage).toEqual(expect.any(Function));

            await act(async () => {
                await latestChatListProps.onEditPendingMessage({
                    id: 'p1',
                    text: 'queued\nmessage',
                    message: sessionPendingMessagesState.current[0],
                });
            });

            agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            expect(agentInput.props.value).toBe('queued\nmessage');

            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onChangeText', 'edited queued message', 'AgentInput');
            });
            agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onSend', undefined, 'AgentInput');
            });

            expect(pendingFireAndForget.length).toBe(1);
            await act(async () => {
                await pendingFireAndForget[0];
            });

            expect(updatePendingMessageSpy).toHaveBeenCalledWith('s1', 'p1', 'edited queued message');
            expect(sendMessageSpy).not.toHaveBeenCalled();
            expect(enqueuePendingMessageSpy).not.toHaveBeenCalled();

            agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            expect(agentInput.props.value).toBe('unrelated draft');
        } finally {
            act(() => {
                tree?.unmount();
            });
            pendingFireAndForget.length = 0;
        }
    });

    it('restores the previous composer draft when pending edit mode is cancelled', async () => {
        sessionPendingMessagesState.current = [{
            id: 'p1',
            text: 'queued message',
            displayText: undefined,
            createdAt: 0,
            updatedAt: 0,
            localId: 'p1',
            rawRecord: {},
        }];
        sessionTranscriptIdsState.current = ['m1'];
        pendingFireAndForget.length = 0;

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
                invokeTestInstanceHandler(agentInput, 'onChangeText', 'draft before edit', 'AgentInput');
            });

            const latestChatListProps = chatListPropsSpy.mock.calls
                .map((call) => call[0])
                .find((props) => typeof props?.onEditPendingMessage === 'function');
            expect(latestChatListProps?.onEditPendingMessage).toEqual(expect.any(Function));

            await act(async () => {
                await latestChatListProps.onEditPendingMessage({
                    id: 'p1',
                    text: 'queued message',
                    message: sessionPendingMessagesState.current[0],
                });
            });

            agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            expect(agentInput.props.value).toBe('queued message');
            const editBadge = agentInput.props.statusBadges?.find((badge: any) => badge.key === 'pending-message-edit');
            expect(editBadge?.onPress).toEqual(expect.any(Function));

            await act(async () => {
                editBadge.onPress();
            });

            expect(updatePendingMessageSpy).not.toHaveBeenCalled();
            agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            expect(agentInput.props.value).toBe('draft before edit');
        } finally {
            act(() => {
                tree?.unmount();
            });
            pendingFireAndForget.length = 0;
        }
    });

    it('clears current attachment drafts during pending edit and restores them on cancel', async () => {
        sessionPendingMessagesState.current = [{
            id: 'p1',
            text: 'queued message',
            displayText: undefined,
            createdAt: 0,
            updatedAt: 0,
            localId: 'p1',
            rawRecord: {},
        }];
        sessionTranscriptIdsState.current = ['m1'];
        pendingFireAndForget.length = 0;

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
            expect(agentInput.props.attachments).toEqual([
                expect.objectContaining({ label: 'draft-note.txt', status: 'pending' }),
            ]);

            const latestChatListProps = chatListPropsSpy.mock.calls
                .map((call) => call[0])
                .find((props) => typeof props?.onEditPendingMessage === 'function');
            expect(latestChatListProps?.onEditPendingMessage).toEqual(expect.any(Function));

            await act(async () => {
                await latestChatListProps.onEditPendingMessage({
                    id: 'p1',
                    text: 'queued message',
                    message: sessionPendingMessagesState.current[0],
                });
            });

            agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            expect(agentInput.props.value).toBe('queued message');
            expect(agentInput.props.attachments).toEqual([]);

            const editBadge = agentInput.props.statusBadges?.find((badge: any) => badge.key === 'pending-message-edit');
            expect(editBadge?.onPress).toEqual(expect.any(Function));
            await act(async () => {
                editBadge.onPress();
            });

            agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            expect(agentInput.props.attachments).toEqual([
                expect.objectContaining({ label: 'draft-note.txt', status: 'pending' }),
            ]);
        } finally {
            act(() => {
                tree?.unmount();
            });
            pendingFireAndForget.length = 0;
        }
    });

    it('clears semantic composer drafts during pending edit and restores them on cancel', async () => {
        sessionPendingMessagesState.current = [{
            id: 'p1',
            text: 'queued message',
            displayText: undefined,
            createdAt: 0,
            updatedAt: 0,
            localId: 'p1',
            rawRecord: {},
        }];
        sessionTranscriptIdsState.current = ['m1'];
        pendingFireAndForget.length = 0;
        existingSessionDraftSemanticValues.write(
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

            const latestChatListProps = chatListPropsSpy.mock.calls
                .map((call) => call[0])
                .find((props) => typeof props?.onEditPendingMessage === 'function');
            expect(latestChatListProps?.onEditPendingMessage).toEqual(expect.any(Function));

            await act(async () => {
                await latestChatListProps.onEditPendingMessage({
                    id: 'p1',
                    text: 'queued message',
                    message: sessionPendingMessagesState.current[0],
                });
            });

            expect(existingSessionDraftSemanticValues.read(
                TEST_SERVER_ACCOUNT_SCOPE,
                's1',
                'routing.executionRunDelivery',
            )).toBeUndefined();

            const agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            const editBadge = agentInput.props.statusBadges?.find((badge: any) => badge.key === 'pending-message-edit');
            expect(editBadge?.onPress).toEqual(expect.any(Function));
            await act(async () => {
                editBadge.onPress();
            });

            expect(existingSessionDraftSemanticValues.read(
                TEST_SERVER_ACCOUNT_SCOPE,
                's1',
                'routing.executionRunDelivery',
            )).toBe('interrupt');
        } finally {
            act(() => {
                tree?.unmount();
            });
            pendingFireAndForget.length = 0;
        }
    });

    it('exits pending edit mode and restores the previous draft when the row disappears unchanged', async () => {
        sessionPendingMessagesState.current = [{
            id: 'p1',
            text: 'queued message',
            displayText: undefined,
            createdAt: 0,
            updatedAt: 0,
            localId: 'p1',
            rawRecord: {},
        }];
        sessionTranscriptIdsState.current = ['m1'];
        pendingFireAndForget.length = 0;

        let tree: renderer.ReactTestRenderer | undefined;
        try {
            const element = <AppPaneProvider>
                <SessionView id="s1" />
            </AppPaneProvider>;
            tree = (await renderScreen(element)).tree;

            const renderedTree = tree;
            expect(renderedTree).toBeDefined();
            if (!renderedTree) throw new Error('SessionView test renderer did not mount');

            let agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onChangeText', 'draft before edit', 'AgentInput');
            });

            const latestChatListProps = chatListPropsSpy.mock.calls
                .map((call) => call[0])
                .find((props) => typeof props?.onEditPendingMessage === 'function');
            expect(latestChatListProps?.onEditPendingMessage).toEqual(expect.any(Function));

            await act(async () => {
                await latestChatListProps.onEditPendingMessage({
                    id: 'p1',
                    text: 'queued message',
                    message: sessionPendingMessagesState.current[0],
                });
            });

            agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            expect(agentInput.props.value).toBe('queued message');

            sessionPendingMessagesState.current = [];
            await act(async () => {
                for (const listener of sessionPendingMessagesState.listeners) listener();
            });

            agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            expect(agentInput.props.value).toBe('draft before edit');
            expect(agentInput.props.statusBadges?.some((badge: any) => badge.key === 'pending-message-edit')).toBe(false);
        } finally {
            act(() => {
                tree?.unmount();
            });
            pendingFireAndForget.length = 0;
        }
    });

    it('restores the previous draft when pending edit mode is abandoned by unmounting unchanged', async () => {
        sessionPendingMessagesState.current = [{
            id: 'p1',
            text: 'queued message',
            displayText: undefined,
            createdAt: 0,
            updatedAt: 0,
            localId: 'p1',
            rawRecord: {},
        }];
        sessionTranscriptIdsState.current = ['m1'];

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
                invokeTestInstanceHandler(agentInput, 'onChangeText', 'draft before edit', 'AgentInput');
            });

            const latestChatListProps = chatListPropsSpy.mock.calls
                .map((call) => call[0])
                .find((props) => typeof props?.onEditPendingMessage === 'function');
            expect(latestChatListProps?.onEditPendingMessage).toEqual(expect.any(Function));

            await act(async () => {
                await latestChatListProps.onEditPendingMessage({
                    id: 'p1',
                    text: 'queued message',
                    message: sessionPendingMessagesState.current[0],
                });
            });

            agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            expect(agentInput.props.value).toBe('queued message');

            act(() => {
                tree?.unmount();
            });
            tree = undefined;

            expect(draftHookState.valuesBySessionId.get('s1')).toBe('draft before edit');
        } finally {
            act(() => {
                tree?.unmount();
            });
            pendingFireAndForget.length = 0;
        }
    });

    it('restores non-text composer drafts when a modified pending edit row disappears', async () => {
        sessionPendingMessagesState.current = [{
            id: 'p1',
            text: 'queued message',
            displayText: undefined,
            createdAt: 0,
            updatedAt: 0,
            localId: 'p1',
            rawRecord: {},
        }];
        sessionTranscriptIdsState.current = ['m1'];
        existingSessionDraftSemanticValues.write(
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
            expect(agentInput.props.attachments).toEqual([
                expect.objectContaining({ label: 'draft-note.txt', status: 'pending' }),
            ]);

            const latestChatListProps = chatListPropsSpy.mock.calls
                .map((call) => call[0])
                .find((props) => typeof props?.onEditPendingMessage === 'function');
            expect(latestChatListProps?.onEditPendingMessage).toEqual(expect.any(Function));

            await act(async () => {
                await latestChatListProps.onEditPendingMessage({
                    id: 'p1',
                    text: 'queued message',
                    message: sessionPendingMessagesState.current[0],
                });
            });

            agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            expect(agentInput.props.value).toBe('queued message');
            expect(agentInput.props.attachments).toEqual([]);
            expect(existingSessionDraftSemanticValues.read(
                TEST_SERVER_ACCOUNT_SCOPE,
                's1',
                'routing.executionRunDelivery',
            )).toBeUndefined();

            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onChangeText', 'edited queued message', 'AgentInput');
            });

            sessionPendingMessagesState.current = [];
            await act(async () => {
                for (const listener of sessionPendingMessagesState.listeners) listener();
            });

            agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            expect(agentInput.props.value).toBe('edited queued message');
            expect(agentInput.props.attachments).toEqual([
                expect.objectContaining({ label: 'draft-note.txt', status: 'pending' }),
            ]);
            expect(existingSessionDraftSemanticValues.read(
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

    it('resumes and queues attachments when chooseSubmitMode selects server_pending', async () => {
        expect(getInactiveSessionUiState({ isSessionActive: true, isResumable: true, isMachineOnline: true })).toMatchObject({ shouldShowInput: true });

        sessionState.session.active = false;
        sessionState.session.presence = 'offline';
        sessionMachineTargetState.available = true;
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
            expect(modalAlertSpy).not.toHaveBeenCalled();
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

    it('keeps composer text visible while attachment upload is pending and clears at outbound handoff', async () => {
        featureEnabledState.reviewComments = false;
        sendMessageSpy.mockClear();
        resumeSessionSpy.mockClear();
        uploadSpy.mockClear();
        modalAlertSpy.mockClear();
        resolveSessionComposerSendMock.mockClear();
        reviewCommentDraftsState.current = [];
        deleteWorkspaceReviewCommentDraftSpy.mockClear();
        pendingFireAndForget.length = 0;

        let resolveUpload: ((result: Readonly<{
            success: true;
            path: string;
            sizeBytes: number;
            sha256: string;
        }>) => void) | null = null;
        const uploadResult = new Promise<Readonly<{
            success: true;
            path: string;
            sizeBytes: number;
            sha256: string;
        }>>((resolve) => {
            resolveUpload = resolve;
        });
        const uploadStarted = new Promise<void>((resolveStarted) => {
            uploadSpy.mockImplementationOnce(() => {
                resolveStarted();
                return uploadResult;
            });
        });
        const sendStarted = new Promise<void>((resolveStarted) => {
            const submit = async (...args: any[]) => {
                const options = args[4] as
                    | { onLocalPendingProjectionCreated?: (event: Readonly<{ localId: string }>) => void }
                    | undefined;
                options?.onLocalPendingProjectionCreated?.({ localId: 'attachment-local-id' });
                resolveStarted();
            };
            sendMessageSpy.mockImplementationOnce(submit);
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
            await uploadStarted;

            agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            expect(agentInput.props.value).toBe('Describe this image');
            expect(sendMessageSpy).toHaveBeenCalledTimes(0);

            if (!resolveUpload) throw new Error('upload did not start');
            act(() => resolveUpload?.({ success: true, path: 'p1', sizeBytes: 1, sha256: 'h1' }));
            await sendStarted;
            await pendingFireAndForget[0];
            await act(async () => {
                await Promise.resolve();
            });

            agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            expect(sendMessageSpy).toHaveBeenCalledTimes(1);
            expect(agentInput.props.value).toBe('');
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
            const submit = async () => {
                resolveStarted();
                return await new Promise<void>((resolve) => {
                    resolveSend = resolve;
                });
            };
            sendMessageSpy.mockImplementationOnce(submit);
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

            await sendStarted;

            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onChangeText', 'Next draft', 'AgentInput');
            });
            agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onAttachmentsAdded', [
                    { name: 'next.txt', size: 1, type: 'text/plain', slice: () => new Blob([new Uint8Array([98])]) } as any,
                ], 'AgentInput');
            });

            if (!resolveSend) throw new Error('send did not start');
            act(() => resolveSend?.());
            await pendingFireAndForget[0];
            await act(async () => {
                await Promise.resolve();
            });

            agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            expect(agentInput.props.value).toBe('Next draft');
            expect(agentInput.props.attachments).toEqual([
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
            act(() => {
                invokeTestInstanceHandler(agentInput, 'onChangeText', 'Next draft', 'AgentInput');
            });
            act(() => {
                invokeTestInstanceHandler(agentInput, 'onAttachmentsAdded', [
                    { name: 'next.txt', size: 1, type: 'text/plain', slice: () => new Blob([new Uint8Array([98])]) } as any,
                ], 'AgentInput');
            });

            await act(async () => {
                if (!resolveUpload) throw new Error('upload did not start');
                resolveUpload();
                await pendingFireAndForget[0];
            });

            agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            expect(agentInput.props.value).toBe('Next draft');
            expect(agentInput.props.attachments).toEqual([
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

            act(() => {
                invokeTestInstanceHandler(agentInput, 'onAttachmentsAdded', [
                    { name: 'next.txt', size: 1, type: 'text/plain', slice: () => new Blob([new Uint8Array([98])]) } as any,
                ], 'AgentInput');
            });

            await act(async () => {
                if (!resolveUpload) throw new Error('upload did not start');
                resolveUpload();
                await pendingFireAndForget[0];
            });

            agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            expect(agentInput.props.value).toBe('');
            expect(agentInput.props.attachments).toEqual([
                expect.objectContaining({ label: 'next.txt' }),
            ]);
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
            expect(agentInput.props.attachments).toEqual([]);

            await act(async () => {
                if (!rejectSend) throw new Error('send did not start');
                rejectSend();
                await pendingFireAndForget[0];
            });

            agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            expect(agentInput.props.value).toBe('Describe this image');
            expect(agentInput.props.attachments).toEqual([
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
            expect(agentInput.props.attachments).toEqual([]);

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
            expect(agentInput.props.attachments).toEqual([
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
        beforeEach(() => {
            // These cases exercise the transition-owned outbound handoff. The
            // outer suite defaults to the legacy unsupported-queue fallback.
            chooseSubmitModeState.mode = 'interrupt';
        });

        const armSecondAgent = () => {
            sessionState.session.active = false;
            sessionState.session.presence = 'offline';
            armedContinuationState.intent = {
                v: 1,
                mode: 'same_session',
                sourceAgentId: 'codex',
                selection: { v: 1, agentId: 'claude' },
            };
            armedContinuationState.localId = 'armed-local-id';
            armedContinuationState.submission = null;
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
            sendMessageSpy.mockClear();
            enqueuePendingMessageSpy.mockClear();
            resumeSessionSpy.mockClear();
            uploadSpy.mockClear();
            modalAlertSpy.mockClear();
            pendingFireAndForget.length = 0;
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

        async function sendArmedAndReadBanner(result: unknown) {
            modalAlertSpy.mockClear();
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

        /**
         * The real ordering: the daemon answers, and the canonical pending row
         * for that exact localId reaches this client a beat later. Notifying the
         * pending-message listeners is the sync arriving — the same re-render the
         * store publishes in production.
         */
        function syncPendingRowForLocalId(localId: string) {
            sessionPendingStoreState.current = {
                s1: { messages: [{ source: 'server_pending', localId }], discarded: [], isLoaded: true },
            };
            act(() => {
                for (const listener of sessionPendingMessagesState.listeners) listener();
            });
        }

        it('tells the reader when the switch left their message queued behind no runtime', async () => {
            // The arm a real Session hit: the cutover committed, the exact localId
            // reached canonical admission, and NO runtime came up — so `accepted`
            // is the whole of what the daemon can claim. It carries no notice by
            // design, on the contract that the queued-message owner states the
            // fact instead. That contract can only hold if custody is WATCHED:
            // the pending row lands after this call returns, and a disposition
            // decided once against `absent` is never re-decided. It was not, and
            // the reader was told nothing at all.
            const screen = await sendArmedAndReadBanner({ type: 'accepted', localId: 'armed-local-id' });
            try {
                expect(modalAlertSpy).not.toHaveBeenCalled();
                // Nothing yet, correctly: no canonical fact has arrived.
                expect(screen.findAllByTestId('session-pendingQueue-resumeFailed')).toHaveLength(0);

                syncPendingRowForLocalId('armed-local-id');

                const banner = screen.findAllByTestId('session-pendingQueue-resumeFailed');
                expect(banner.length).toBeGreaterThan(0);
                expect(screen.getTextContent()).toContain('session.pendingQueuedResumeFailedTitle');
                // Never an invitation to send the same input twice: the only action
                // is the Session's own resume owner, which drains the queue.
                expect(screen.findAllByTestId('session-pendingQueue-resumeFailed-retry').length).toBeGreaterThan(0);
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
            sessionState.session.active = true;
            sessionState.session.presence = 'online';
            armedContinuationState.intent = {
                v: 1,
                mode: 'same_session',
                sourceAgentId: 'codex',
                selection: { v: 1, agentId: 'claude' },
            };
            armedContinuationState.localId = 'armed-local-id';
            modalAlertSpy.mockClear();
            runSessionAgentTransitionSpy.mockImplementationOnce(async () => ({
                type: 'partially_applied',
                localId: 'armed-local-id',
                applied: 'current_view_committed',
                code: 'target_start_failed',
            }) as any);
            const screen = await renderScreen(<AppPaneProvider>
                        <SessionView id="s1" />
                    </AppPaneProvider>);
            pendingFireAndForget.length = 0;
            if (!screen.tree) throw new Error('SessionView test renderer did not mount');
            try {
                await sendOneAttachment(screen.tree);
                const banners = screen.findAllByTestId('session-pendingQueue-resumeFailed');
                expect(banners.length).toBeGreaterThan(0);
                const retry = screen.findByTestId('session-pendingQueue-resumeFailed-retry');
                expect(retry).toBeTruthy();
                expect(retry?.props.accessibilityLabel)
                    .toBe('session.agentContinuation.transition.resumeAction');
                expect(retry?.findAll((node) => (
                    node.props.children === 'session.agentContinuation.transition.resumeAction'
                )).length).toBeGreaterThan(0);
            } finally {
                act(() => { screen.tree?.unmount(); });
                pendingFireAndForget.length = 0;
            }
        });

        it('reports a committed switch as a composer warning, never as a dismissible error', async () => {
            // This arm is a partial SUCCESS: the Session really did move to the
            // target and only the message failed. Reporting it as "Error" behind an
            // OK button — and discarding the fact once dismissed — is the original
            // defect, so the assertion is on both halves.
            // `divider_unavailable` rather than `target_start_failed`: the latter now
            // rides the queued-input contract (the daemon proved the input was
            // admitted before activation was even attempted), which the two cases
            // above own. Every OTHER code at this depth still leaves the message
            // unsent, and those are what this asserts.
            const screen = await sendArmedAndReadBanner({
                type: 'partially_applied',
                localId: 'armed-local-id',
                applied: 'current_view_committed',
                code: 'divider_unavailable',
            });
            try {
                expect(modalAlertSpy).not.toHaveBeenCalled();
                const banner = screen.findAllByTestId('session.agentTransitionOutcome.banner');
                expect(banner.length).toBeGreaterThan(0);
                expect(banner.some((node) => node.props?.tone === 'warning')).toBe(true);
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
            sessionMachineTargetState.available = true;
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

        it('offers no retry at all for an outcome nothing has established', async () => {
            const screen = await sendArmedAndReadBanner({ type: 'outcome_unknown', localId: 'armed-local-id' });
            try {
                expect(modalAlertSpy).not.toHaveBeenCalled();
                expect(screen.getTextContent())
                    .toContain('session.agentContinuation.transition.unknown');
                // A blind retry against an effect that may already have happened is
                // the one action this state must never expose.
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
            modalAlertSpy.mockClear();
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

        function readNestedArmSubmission() {
            return armedContinuationState.submission;
        }

        it('blocks a remounted nested submission until reconciliation reads canonical custody', async () => {
            const first = await sendArmedText(
                { type: 'outcome_unknown', localId: 'armed-local-id' },
                'switch and send this',
            );
            try {
                expect(first.getTextContent()).toContain('session.agentContinuation.transition.unknown');
                expect(draftHookState.valuesBySessionId.get('s1')).toBe('switch and send this');
                expect(readNestedArmSubmission()).toMatchObject({
                    localId: 'armed-local-id',
                    input: { localId: 'armed-local-id', text: 'switch and send this' },
                });
            } finally {
                act(() => { first.tree?.unmount(); });
                pendingFireAndForget.length = 0;
            }

            runSessionAgentTransitionSpy.mockClear();
            sendMessageSpy.mockClear();
            enqueuePendingMessageSpy.mockClear();
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
                expect(readNestedArmSubmission()).toMatchObject({ localId: 'armed-local-id' });
                const agentInput = findTestInstanceByTypeWithProps(second.tree!, 'AgentInput' as any, {}) as any;
                await act(async () => {
                    invokeTestInstanceHandler(agentInput, 'onChangeText', 'later edited draft', 'AgentInput');
                });
                await act(async () => {
                    invokeTestInstanceHandler(agentInput, 'onSend', undefined, 'AgentInput');
                });
                expect(sendMessageSpy).not.toHaveBeenCalled();
                expect(enqueuePendingMessageSpy).not.toHaveBeenCalled();
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
                expect(draftHookState.valuesBySessionId.get('s1')).toBe('switch and send this');

                syncPendingRowForLocalId('armed-local-id');

                expect(screen.getTextContent()).not.toContain('session.agentContinuation.transition.unknown');
                expect(screen.findAllByTestId('session.agentTransitionOutcome.banner')).toHaveLength(0);
                expect(draftHookState.valuesBySessionId.get('s1')).toBe('');
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

                expect(draftHookState.valuesBySessionId.get('s1')).toBe('a different message');
                // The rewritten text is a new message, so canonical custody
                // must spend the original arm/localId without clearing it.
                expect(clearArmedContinuationSpy).toHaveBeenCalled();
            } finally {
                act(() => { screen.tree?.unmount(); });
                pendingFireAndForget.length = 0;
            }
        });

        it('after remount clears only admitted attachment drafts, preserving later attachment edits', async () => {
            const first = await sendArmedAndReadBanner({
                type: 'outcome_unknown',
                localId: 'armed-local-id',
            });
            let submittedAttachmentId: string;
            try {
                const firstInput = findTestInstanceByTypeWithProps(first.tree!, 'AgentInput' as any, {}) as any;
                const submittedAttachments = firstInput.props.attachments as readonly { key: string; label: string }[];
                expect(submittedAttachments).toEqual([
                    expect.objectContaining({ label: 'a.txt' }),
                ]);
                submittedAttachmentId = submittedAttachments[0]!.key;

                // The continuation record carries the exact delivered attachment
                // metadata and the local draft identity needed to compare-clear
                // after remount. It deliberately does not create a second
                // plugin-attachment draft representation.
                expect(readNestedArmSubmission()).toMatchObject({
                    input: {
                        meta: {
                            happier: expect.objectContaining({ kind: 'attachments.v1' }),
                        },
                    },
                    currentness: {
                        text: '',
                        mentions: [],
                        attachmentDraftIds: [submittedAttachmentId],
                    },
                });
                expect(readNestedArmSubmission().currentness).not.toHaveProperty('composerAttachments');
            } finally {
                act(() => { first.tree?.unmount(); });
                pendingFireAndForget.length = 0;
            }

            const second = await renderScreen(<AppPaneProvider>
                        <SessionView id="s1" />
                    </AppPaneProvider>);
            try {
                let agentInput = findTestInstanceByTypeWithProps(second.tree!, 'AgentInput' as any, {}) as any;
                expect(agentInput.props.attachments).toEqual([
                    expect.objectContaining({ key: submittedAttachmentId, label: 'a.txt' }),
                ]);

                await act(async () => {
                    invokeTestInstanceHandler(agentInput, 'onAttachmentsAdded', [
                        { name: 'later.txt', size: 1, type: 'text/plain', slice: () => new Blob([new Uint8Array([98])]) } as any,
                    ], 'AgentInput');
                });
                agentInput = findTestInstanceByTypeWithProps(second.tree!, 'AgentInput' as any, {}) as any;
                expect(agentInput.props.attachments).toEqual([
                    expect.objectContaining({ key: submittedAttachmentId, label: 'a.txt' }),
                    expect.objectContaining({ label: 'later.txt' }),
                ]);

                // Canonical custody arrives after the remount. The ID-based
                // compare-clear removes the admitted attachment but leaves the
                // newer draft untouched.
                syncPendingRowForLocalId('armed-local-id');

                agentInput = findTestInstanceByTypeWithProps(second.tree!, 'AgentInput' as any, {}) as any;
                expect(agentInput.props.attachments).toEqual([
                    expect.objectContaining({ label: 'later.txt' }),
                ]);
                expect(clearArmedContinuationSpy).toHaveBeenCalled();
            } finally {
                act(() => { second.tree?.unmount(); });
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

        it('still routes an ordinary unarmed attachment send through the source resume', async () => {
            sessionState.session.active = false;
            sessionState.session.presence = 'offline';
            sendMessageSpy.mockClear();
            enqueuePendingMessageSpy.mockClear();
            resumeSessionSpy.mockClear();
            uploadSpy.mockClear();
            modalAlertSpy.mockClear();
            pendingFireAndForget.length = 0;

            let tree: renderer.ReactTestRenderer | undefined;
            try {
                tree = (await renderScreen(<AppPaneProvider>
                            <SessionView id="s1" />
                        </AppPaneProvider>)).tree;
                pendingFireAndForget.length = 0;
                const renderedTree = tree;
                if (!renderedTree) throw new Error('SessionView test renderer did not mount');

                await sendOneAttachment(renderedTree);

                // The control leg. This harness's resume prerequisites do not
                // currently resolve, so an ordinary inactive send fails at the
                // resume and says so. That is exactly what makes it a control:
                // the unarmed send still goes through the source resume, and
                // only the armed send skips it. If the fix had simply deleted
                // the resume, this leg would stop failing.
                expect(runSessionAgentTransitionSpy).not.toHaveBeenCalled();
                expect(sendMessageSpy).not.toHaveBeenCalled();
                expect(modalAlertSpy.mock.calls.some(
                    (call) => String(call?.[1] ?? '').includes('session.resumeFailed'),
                )).toBe(true);
            } finally {
                act(() => {
                    tree?.unmount();
                });
                pendingFireAndForget.length = 0;
            }
        });
    });
});
