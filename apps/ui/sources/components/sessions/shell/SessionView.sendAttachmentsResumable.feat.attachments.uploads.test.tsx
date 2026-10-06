import 'fake-indexeddb/auto';
import { createReactNavigationNativeMock } from '@/dev/testkit/mocks/reactNavigation';
import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createHomeHubArtifactHttpBoundary } from '@/dev/testkit/harness/homeHubArtifactHttpBoundary';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createSessionAccessFixture, createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { AUTHORING_MEMORY_ROUTE_V1, AuthoringMemoryListResponseV1Schema,
    PluginProjectionV2Schema, SessionCurrentProjectionRecordV1Schema } from '@happier-dev/protocol';
import { findTestInstanceByTypeWithProps, invokeTestInstanceHandler, renderScreen } from '@/dev/testkit/render/renderScreen';
import { activateSessionShellStorageBoundary,
    installSessionShellCommonModuleMocks,
    resetSessionShellDraftStateForTest,
} from './sessionShellTestHelpers';

import { COMPOSER_SOURCE_REF_PRIVATE_META_FIELD_V1, composerRefV1Key } from '@happier-dev/protocol/plugins/ui/composerRef';
import { clearSessionAttachmentDrafts, writeSessionAttachmentDrafts } from '@/components/sessions/attachments/sessionAttachmentDraftStore';
import {
    clearSessionDraftValuesForSession,
    readSessionDraftValue,
    writeSessionDraftValue,
} from '@/dev/testkit/sessionDraftRepositoryTestkit';
import type { PendingMessage } from '@/sync/domains/state/storageTypes';
import type { SessionPending } from '@/sync/store/domains/pending';

installDisconnectedServerSocketBoundary();

type StorageModule = typeof import('@/sync/domains/state/storage');
let originalStorageModule: StorageModule | undefined;
let originalStorageModulePromise: Promise<StorageModule> | undefined;
let seedSessionStorage: (() => void) | undefined;

vi.mock('@/components/ui/code/editor/CodeEditor', () => ({ CodeEditor: () => null }));
vi.mock('@/components/sessions/companion/presentation/SessionCompanionPresentationBridge', () => ({
    SessionCompanionPresentationBridge: () => null,
}));
vi.mock('@/components/sessions/companion/SessionCompanionHost', () => ({
    SessionCompanionHost: () => null,
}));
vi.mock('@/components/sessions/board/SessionBoardControllerProvider', () => ({
    SessionBoardControllerProvider: ({ children }: React.PropsWithChildren) => children,
    useMountedSessionBoardController: () => null,
}));


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).__DEV__ = false;
let authCredentials: any = { token: 't', secret: 's' };
const sessionState = vi.hoisted(() => ({
    session: {
        id: 's1',
        serverId: 'server-1',
        seq: 0,
        presence: 'offline',
        active: false,
        accessLevel: 'edit',
        access: { level: 'edit', capabilities: { readTranscript: true, submitAgentInput: true } },
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
const preparePendingMessageComposerAdmissionMock = vi.hoisted(() => vi.fn());
const acceptPendingMessageComposerAdmissionMock = vi.hoisted(() => vi.fn());
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
// The transcript rows the canonical subagent/participant-target owner reads. Seeding
// them lets a case address a real Session-owned Execution Run through the composer's
// recipient without mocking the derivation itself.
const sessionSubagentSourceMessagesState = vi.hoisted(() => ({
    current: [] as any[],
}));
const companionPreferenceSlot = vi.hoisted(() => ({ storageKey: null, stored: undefined }));
const machineDisplayNamesById = vi.hoisted(() => ({}));
const mutateCompanionPreference = vi.hoisted(() => vi.fn());
const settingWriter = vi.hoisted(() => vi.fn());
const localSettingWriter = vi.hoisted(() => vi.fn());
const settingsSnapshot = vi.hoisted(() => ({ experiments: true, featureToggles: {} }));
const realtimeStatus = vi.hoisted(() => ({ status: 'connected' }));

const pendingFireAndForget: Promise<unknown>[] = [];
const TEST_SERVER_ACCOUNT_SCOPE = { serverId: 'server-1', accountId: 'account-1' } as const;

function mainAttachmentDraftScope(serverId: string) {
    return {
        serverId,
        accountId: 'account-1',
        sessionId: 's1',
        occurrenceId: composerRefV1Key({ kind: 'session', sessionId: 's1' }),
    } as const;
}

/**
 * One running Session-owned Execution Run as the transcript actually records it.
 * The canonical subagent/participant-target owner derives the addressable recipient
 * from this row; nothing here substitutes for that derivation.
 */
function createRunningSubAgentRunMessage(runId: string) {
    const now = Date.now();
    return {
        kind: 'tool-call' as const,
        id: `tool-${runId}`,
        localId: null,
        createdAt: now,
        tool: {
            name: 'SubAgentRun',
            state: 'running' as const,
            input: { runId },
            createdAt: now,
            startedAt: now,
            completedAt: null,
            description: null,
        },
        children: [],
    };
}

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
    ...createReactNavigationNativeMock(),
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

vi.mock('@/agents/backendCatalog/useDaemonMergedProjectionInputs', () => ({
    useDaemonMergedProjectionInputs: () => daemonMergedProjectionState.value,
}));
vi.mock('@/sync/ops/pendingMessageComposerAdmission', () => ({
    preparePendingMessageComposerAdmission: (...args: unknown[]) => (
        preparePendingMessageComposerAdmissionMock(...args)
    ),
    acceptPendingMessageComposerAdmission: (...args: unknown[]) => (
        acceptPendingMessageComposerAdmissionMock(...args)
    ),
}));
vi.mock('@/voice/session/voiceSession', () => ({
    useVoiceSessionSnapshot: () => ({ status: 'disconnected' }),
    voiceSessionManager: {},
}));

const sendMessageSpy = vi.fn(async (..._args: any[]) => {});
const enqueuePendingMessageSpy = vi.fn(async (..._args: any[]) => ({ localId: 'pending-local-id' }));
type PendingUpdateOptions = Parameters<(typeof import('@/sync/sync'))['sync']['updatePendingMessage']>[4];
function acceptedPendingComposerFact(
    sessionId: string,
    pendingId: string,
    structuredInput: unknown,
    options?: PendingUpdateOptions,
) {
    return {
        sessionId,
        localId: options?.replacementLocalId ?? pendingId,
        structuredInput,
        stagedMediaHandles: options?.preparedComposerAdmission?.stagedMediaHandles ?? [],
    };
}
const updatePendingMessageSpy = vi.fn(async (
    sessionId: string,
    pendingId: string,
    _text: string,
    structuredInput: unknown,
    options?: Parameters<typeof acceptedPendingComposerFact>[3],
) => acceptedPendingComposerFact(sessionId, pendingId, structuredInput, options));
function pendingMessageAuthorityExpectation() {
    const options = updatePendingMessageSpy.mock.calls.at(-1)?.[4];
    if (!options?.accountLifetime) throw new Error('Pending update did not capture its Account lifetime');
    expect(options).toMatchObject({
        serverId: TEST_SERVER_ACCOUNT_SCOPE.serverId,
        accountLifetime: {
            scope: TEST_SERVER_ACCOUNT_SCOPE,
            serverId: TEST_SERVER_ACCOUNT_SCOPE.serverId,
            accountId: TEST_SERVER_ACCOUNT_SCOPE.accountId,
        },
    });
    expect(options.accountLifetime.isCurrent()).toBe(true);
    expect(options.session).toBe(sessionState.session);
    return {
        serverId: TEST_SERVER_ACCOUNT_SCOPE.serverId,
        accountLifetime: options.accountLifetime,
        session: options.session,
    };
}
function deferPendingComposerUpdate(gate: Promise<void>) {
    return async (
        sessionId: string,
        pendingId: string,
        _text: string,
        structuredInput: unknown,
        options?: Parameters<typeof acceptedPendingComposerFact>[3],
    ) => {
        await gate;
        return acceptedPendingComposerFact(sessionId, pendingId, structuredInput, options);
    };
}
const patchSessionMetadataWithRetrySpy = vi.fn(async (..._args: any[]) => {});

function setCurrentComposerAttachmentProjection(input: Readonly<{
    generation?: number;
    occurrenceId?: string;
}> = {}): void {
    const generation = input.generation ?? 7;
    const occurrenceId = input.occurrenceId ?? 'issue-generation-a';
    daemonMergedProjectionState.value = {
        phase: 'ready',
        inputs: {
            pluginProjectionById: {},
            pluginProjectionV2: PluginProjectionV2Schema.parse({
                v: 2,
                generation,
                installedPackagesById: {},
                agentsById: {},
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
                                occurrenceId,
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
let realSyncRuntime: (typeof import('@/sync/sync'))['sync'] | undefined;
vi.mock('@/sync/sync', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/sync/sync')>(),
    sync: {
        materializeExistingSessionDraft: (...args: Parameters<(typeof import('@/sync/sync'))['sync']['materializeExistingSessionDraft']>) => {
            if (!realSyncRuntime) throw new Error('Real Sync draft owner was not initialized');
            return realSyncRuntime.materializeExistingSessionDraft(...args);
        },
        getSessionAttachmentTransferContext: () => undefined,
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
        updatePendingMessage: (...args: Parameters<typeof updatePendingMessageSpy>) => updatePendingMessageSpy(...args),
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
    storage: async (importOriginal) => {
        const { createStorageModuleStub, createStorageStoreMock } = await import('@/dev/testkit/mocks/storage');
        const { createSessionAccessFixture, createSessionFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
        const { settingsDefaults } = await import('@/sync/domains/settings/settings');
        const { profileDefaults } = await import('@/sync/domains/profiles/profile');
        sessionState.session = createSessionFixture({
            ...sessionState.session,
            access: createSessionAccessFixture('edit'),
        });
        const fixture = createStorageModuleStub({
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
                    profile: profileDefaults,
                    deleteWorkspaceReviewCommentDraft: deleteWorkspaceReviewCommentDraftSpy,
            }),
            useSession: () => sessionState.session,
            // Keep the hook aligned with the same canonical session fixture used by useSession.
            useSessionMachineId: () => sessionState.session.metadata.machineId ?? null,
            useIsDataReady: () => true,
            useRealtimeStatus: () => realtimeStatus,
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
            useSessionSubagentSourceMessages: () => sessionSubagentSourceMessagesState.current,
            useSessionReviewCommentsDrafts: () => [],
            useWorkspaceReviewCommentsDrafts: () => reviewCommentDraftsState.current,
            useSessionCompanionPreferenceSlot: () => companionPreferenceSlot,
            useMutateSessionCompanionPreference: () => mutateCompanionPreference,
            useSessionUsage: () => null,
            useSetting: (key: keyof typeof settingsDefaults) => settingsDefaults[key],
            useMachineDisplayNamesById: () => machineDisplayNamesById,
            useSettings: () => settingsSnapshot,
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
            useLocalSettingMutable: () => [null, localSettingWriter],
            useSettingMutable: () => [null, settingWriter],
        });
        // Original storage hooks reach syncSettings, which imports this mocked
        // module. Publish the fixture first rather than await that cycle here.
        originalStorageModulePromise = importOriginal<StorageModule>().then((actual) => {
            originalStorageModule = actual;
            const initial = fixture.storage.getState();
            seedSessionStorage = () => actual.storage.setState({
                sessions: { s1: sessionState.session },
                sessionPending: canonicalSessionPendingState,
                machines: initial.machines,
                sessionListIndexByServerId: initial.sessionListIndexByServerId,
                settings: initial.settings,
                profile: initial.profile,
                deleteWorkspaceReviewCommentDraft: deleteWorkspaceReviewCommentDraftSpy,
            });
            seedSessionStorage();
            return actual;
        });
        return {
            ...fixture,
            // Import-cycle adapter only: once loaded, every store operation is
            // owned by the production store, including Account restoration.
            storage: new Proxy(fixture.storage, {
                get(target, property) {
                    return Reflect.get(originalStorageModule?.storage ?? target, property);
                },
                apply(target, thisArgument, argumentsList) {
                    return Reflect.apply(originalStorageModule?.storage ?? target, thisArgument, argumentsList);
                },
            }),
            clearSessionMessageDerivedCachesForServerScopeReset: (...args: Parameters<StorageModule['clearSessionMessageDerivedCachesForServerScopeReset']>) => {
                if (!originalStorageModule) throw new Error('Original store was not initialized');
                return originalStorageModule.clearSessionMessageDerivedCachesForServerScopeReset(...args);
            },
            readSessionMessagesSnapshot: (...args: Parameters<StorageModule['readSessionMessagesSnapshot']>) => {
                if (!originalStorageModule) throw new Error('Original transcript snapshot reader was not initialized');
                return originalStorageModule.readSessionMessagesSnapshot(...args);
            },
        };
    },
});

vi.mock('@/hooks/server/useAutomationsSupport', () => ({
    useAutomationsSupport: () => ({ enabled: false }),
}));

vi.mock('@/utils/system/versionUtils', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/utils/system/versionUtils')>(),
    isVersionSupported: () => true,
    MINIMUM_CLI_VERSION: '0.0.0',
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
vi.mock('@/utils/system/fireAndForget', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/utils/system/fireAndForget')>();
    return {
        ...actual,
        fireAndForget: (...args: Parameters<typeof actual.fireAndForget>) => {
            const [promise, options] = args;
            // Observe composer completion without replacing the owner's rejection handling.
            if (promise && options?.tag === 'SessionView.composer.dispatch') {
                pendingFireAndForget.push(promise);
            }
            return actual.fireAndForget(...args);
        },
    };
});
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
vi.mock('@/sync/domains/session/control/localControlSwitch', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/sync/domains/session/control/localControlSwitch')>(),
    shouldRenderChatTimelineForSession: () => true,
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
  countEnabledAutomationDefinitionsLinkedToSession: () => 0,
}));

const {
    applyComposerPresentationTransaction,
    createComposerPresentationTransactionApplier,
    createComposerPresentationHostHandlers,
    readComposerPresentationSnapshot,
} = await import('@/components/sessions/presentation/sessionComposerPresentationTargets');
// Keep draft adoption, persistence and compare/restore in the production owner.
vi.doUnmock('@/hooks/session/useDraft');
const { getSessionDraftSnapshot } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
function readSessionShellDraftTextForTest(sessionId: string) {
    return getSessionDraftSnapshot(TEST_SERVER_ACCOUNT_SCOPE, { kind: 'session', sessionId })?.document.composer.text.value;
}
const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
const { getInactiveSessionUiState } = await import('@/components/sessions/model/inactiveSessionUi');
const { SessionView } = await import('./SessionView');
if (!originalStorageModulePromise) throw new Error('Storage fixture was not initialized');
await originalStorageModulePromise;
const { prepareSessionDraftPersistenceStorage } = await import('@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage');
await prepareSessionDraftPersistenceStorage();
realSyncRuntime = (await import('@/sync/syncEngine')).sync;
let accountConnection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;

describe('SessionView (attachments.uploads resumable send)', () => {
    beforeEach(() => {
        chooseSubmitModeState.mode = 'agent_queue';
        clearSessionAttachmentDrafts(mainAttachmentDraftScope('server-1'));
        clearSessionAttachmentDrafts(mainAttachmentDraftScope('server-2'));
        sendMessageSpy.mockClear();
        ensureSessionVisibleSpy.mockReset().mockResolvedValue({ kind: 'available' });
        refreshSessionMessagesSpy.mockReset().mockResolvedValue(undefined);
        enqueuePendingMessageSpy.mockClear();
        updatePendingMessageSpy.mockClear();
        patchSessionMetadataWithRetrySpy.mockClear();
        preparePendingMessageComposerAdmissionMock.mockReset().mockImplementation(async (
            _sessionId: string,
            request: { text: string; structuredInput: unknown },
        ) => ({ ok: true, text: request.text, structuredInput: request.structuredInput }));
        acceptPendingMessageComposerAdmissionMock.mockReset().mockResolvedValue(undefined);
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
        seedSessionStorage?.();
        resetSessionShellDraftStateForTest();
        clearSessionDraftValuesForSession(TEST_SERVER_ACCOUNT_SCOPE, 's1', { reason: 'composerClear' });
        // The armed continuation has the same composer-clear lifetime as its
        // sibling routing fields; session deletion is still an idempotent
        // second cleanup path.
        clearSessionDraftValuesForSession(TEST_SERVER_ACCOUNT_SCOPE, 's1', { reason: 'sessionDelete' });
        pendingFireAndForget.length = 0;
    });

    beforeEach(activateSessionShellStorageBoundary);

    beforeEach(async () => {
        sessionState.session = createSessionFixture({
            ...sessionState.session,
            metadata: { host: 'test-home', ...sessionState.session.metadata },
            access: createSessionAccessFixture(sessionState.session.accessLevel),
        });
        const accountHttp = createHomeHubArtifactHttpBoundary(TEST_SERVER_ACCOUNT_SCOPE.accountId);
        accountConnection = await restoreServerAccountForTest({
            serverUrl: 'https://server-1',
            accountId: TEST_SERVER_ACCOUNT_SCOPE.accountId,
            request: async (input, init) => {
                const path = new URL(String(input)).pathname;
                if (path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
                if (path === AUTHORING_MEMORY_ROUTE_V1) return Response.json(AuthoringMemoryListResponseV1Schema.parse({ rows: [] }));
                if (path === '/v2/sessions/s1') return Response.json({ session: SessionCurrentProjectionRecordV1Schema.parse({
                    ...sessionState.session,
                    metadataLayoutVersion: 0, metadata: JSON.stringify(sessionState.session.metadata),
                    agentState: JSON.stringify(sessionState.session.agentState), dataEncryptionKey: null,
                    effectiveAccess: { v: 1, level: sessionState.session.access.level,
                        sources: [{ kind: 'owner' }], capabilities: sessionState.session.access.capabilities },
                    responsibleAccountId: null, responsibleAccount: null, share: null,
                    archivedAt: null, pendingCount: 0, pendingVersion: 0,
                }) });
                return accountHttp.request(input, init);
            },
        });
        seedSessionStorage?.();
        await activateSessionShellStorageBoundary();
    });

    afterEach(async () => {
        await accountConnection?.dispose();
        accountConnection = undefined;
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

    it('keeps the main composer attachment draft isolated by exact Home while preserving same-Home remounts', async () => {
        let firstHomeTree: renderer.ReactTestRenderer | undefined;
        let restoredFirstHomeTree: renderer.ReactTestRenderer | undefined;
        try {
            firstHomeTree = (await renderScreen(<AppPaneProvider>
                <SessionView id="s1" routeServerId="server-1" />
            </AppPaneProvider>)).tree;

            const mountedFirstHomeTree = firstHomeTree;
            if (!mountedFirstHomeTree) throw new Error('First Home SessionView did not mount');
            const firstHomeInput = findTestInstanceByTypeWithProps(mountedFirstHomeTree, 'AgentInput' as any, {}) as any;
            await act(async () => {
                invokeTestInstanceHandler(firstHomeInput, 'onAttachmentsAdded', [
                    { name: 'home-one.txt', size: 1, type: 'text/plain', slice: () => new Blob([new Uint8Array([97])]) } as any,
                ], 'AgentInput');
            });

            await act(async () => {
                sessionState.session.serverId = 'server-2';
                seedSessionStorage?.();
                await activateSessionShellStorageBoundary();
                mountedFirstHomeTree.update(<AppPaneProvider>
                    <SessionView id="s1" routeServerId="server-2" />
                </AppPaneProvider>);
            });
            const secondHomeInput = findTestInstanceByTypeWithProps(mountedFirstHomeTree, 'AgentInput' as any, {}) as any;
            expect(secondHomeInput.props.attachmentRowItems).toEqual([]);

            await act(async () => {
                sessionState.session.serverId = 'server-1';
                seedSessionStorage?.();
                mountedFirstHomeTree.update(<AppPaneProvider>
                    <SessionView id="s1" routeServerId="server-1" />
                </AppPaneProvider>);
            });
            const returnedFirstHomeInput = findTestInstanceByTypeWithProps(mountedFirstHomeTree, 'AgentInput' as any, {}) as any;
            expect(returnedFirstHomeInput.props.attachmentRowItems).toEqual([
                expect.objectContaining({ label: 'home-one.txt', status: 'pending' }),
            ]);

            act(() => {
                firstHomeTree?.unmount();
            });
            firstHomeTree = undefined;

            restoredFirstHomeTree = (await renderScreen(<AppPaneProvider>
                <SessionView id="s1" routeServerId="server-1" />
            </AppPaneProvider>)).tree;
            const mountedRestoredFirstHomeTree = restoredFirstHomeTree;
            if (!mountedRestoredFirstHomeTree) throw new Error('Restored first Home SessionView did not mount');
            const restoredFirstHomeInput = findTestInstanceByTypeWithProps(mountedRestoredFirstHomeTree, 'AgentInput' as any, {}) as any;
            expect(restoredFirstHomeInput.props.attachmentRowItems).toEqual([
                expect.objectContaining({ label: 'home-one.txt', status: 'pending' }),
            ]);
        } finally {
            act(() => {
                firstHomeTree?.unmount();
                restoredFirstHomeTree?.unmount();
            });
            sessionState.session.serverId = 'server-1';
            seedSessionStorage?.();
        }
    });

    it('hydrates recoverable attachment drafts so retry can reuse uploaded files', async () => {
        sendMessageSpy.mockClear();
        resumeSessionSpy.mockClear();
        uploadSpy.mockClear();
        modalAlertSpy.mockClear();
        resolveSessionComposerSendMock.mockClear();
        pendingFireAndForget.length = 0;

        writeSessionAttachmentDrafts(mainAttachmentDraftScope('server-1'), [{
            id: 'draft-retry',
            source: { kind: 'native', uri: 'file:///tmp/retry.txt', name: 'retry.txt', sizeBytes: 1, mimeType: 'text/plain' },
            status: 'uploaded', uploadedPath: 'p1', uploadedSizeBytes: 1,
            uploadedMimeType: 'text/plain', sha256: 'h1',
        }]);

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

    it('admits an attachment to the exact Execution Run target instead of refusing it', async () => {
        // A Session-owned Execution Run is an ordinary target of canonical Session input
        // admission: the same upload, the same encrypted Session media path, the same
        // settlement. The refusal this replaces existed only because the removed direct
        // `execution.run.send` route had no attachment channel of its own.
        featureEnabledState.reviewComments = false;
        chooseSubmitModeState.mode = 'agent_queue';
        sendMessageSpy.mockClear();
        enqueuePendingMessageSpy.mockClear();
        resumeSessionSpy.mockClear();
        uploadSpy.mockClear();
        modalAlertSpy.mockClear();
        resolveSessionComposerSendMock.mockClear();
        reviewCommentDraftsState.current = [];
        pendingFireAndForget.length = 0;

        sessionSubagentSourceMessagesState.current = [createRunningSubAgentRunMessage('run-a')];
        writeSessionDraftValue(
            TEST_SERVER_ACCOUNT_SCOPE,
            's1',
            'routing.recipient',
            { kind: 'execution_run', runId: 'run-a' },
        );
        writeSessionDraftValue(TEST_SERVER_ACCOUNT_SCOPE, 's1', 'routing.executionRunRequestedAction', { v: 1, kind: 'enqueue' });

        let tree: renderer.ReactTestRenderer | undefined;
        try {
            tree = (await renderScreen(<AppPaneProvider>
                        <SessionView id="s1" />
                    </AppPaneProvider>)).tree;
            pendingFireAndForget.length = 0;

            const renderedTree = tree;
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

            expect(modalAlertSpy).not.toHaveBeenCalled();
            expect(uploadSpy).toHaveBeenCalled();
            expect(sendMessageSpy).not.toHaveBeenCalled();
            // The parent Session's Agent is not this input's destination, so nothing
            // starts it on the run's behalf.
            expect(resumeSessionSpy).not.toHaveBeenCalled();
            expect(enqueuePendingMessageSpy).toHaveBeenCalledTimes(1);

            const [sentSessionId, sentText, , sentMetaOverrides, sentOptions] = enqueuePendingMessageSpy.mock.calls[0] ?? [];
            expect(sentSessionId).toBe('s1');
            expect(String(sentText)).toContain('a.txt');
            // The uploaded attachment envelope survives intact: the destination is the
            // durable pending target, not a second authored routing fact competing for
            // the same single `happier` slot.
            expect(sentMetaOverrides).toMatchObject({
                happier: { kind: 'attachments.v1' },
            });
            expect(sentOptions).toMatchObject({
                recipient: { kind: 'execution_run', runId: 'run-a' },
                requestedAction: { v: 1, kind: 'enqueue' },
            });
        } finally {
            act(() => {
                tree?.unmount();
            });
            sessionSubagentSourceMessagesState.current = [];
            pendingFireAndForget.length = 0;
        }
    });

    it('still refuses attachments addressed to an Agent-team recipient', async () => {
        // Agent-team recipients remain parent-runtime participant metadata rather than
        // independent runtime targets, so lifting the run refusal must not lift theirs.
        featureEnabledState.reviewComments = false;
        enqueuePendingMessageSpy.mockClear();
        sendMessageSpy.mockClear();
        uploadSpy.mockClear();
        modalAlertSpy.mockClear();
        reviewCommentDraftsState.current = [];
        pendingFireAndForget.length = 0;

        const previousFlavor = sessionState.session.metadata.flavor;
        sessionState.session.metadata.flavor = 'claude';
        const teamCreated = createRunningSubAgentRunMessage('team-a-create');
        const teammateSpawned = createRunningSubAgentRunMessage('team-a-alpha');
        sessionSubagentSourceMessagesState.current = [
            { ...teamCreated, tool: { ...teamCreated.tool, name: 'AgentTeamCreate', state: 'completed',
                completedAt: teamCreated.createdAt, input: { team_name: 'team-a' } } },
            { ...teammateSpawned, tool: { ...teammateSpawned.tool, name: 'Task', id: 'team-a-alpha',
                input: { team_name: 'team-a', name: 'alpha' },
                result: { tool_use_result: { status: 'teammate_spawned', agent_id: 'alpha@team-a', team_name: 'team-a', name: 'alpha' } } } },
        ];
        writeSessionDraftValue(
            TEST_SERVER_ACCOUNT_SCOPE,
            's1',
            'routing.recipient',
            { kind: 'agent_team_broadcast', teamId: 'team-a' },
        );

        let tree: renderer.ReactTestRenderer | undefined;
        try {
            tree = (await renderScreen(<AppPaneProvider>
                        <SessionView id="s1" />
                    </AppPaneProvider>)).tree;
            pendingFireAndForget.length = 0;

            const renderedTree = tree;
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
            for (const settled of pendingFireAndForget) await settled;

            expect(uploadSpy).not.toHaveBeenCalled();
            expect(enqueuePendingMessageSpy).not.toHaveBeenCalled();
            expect(sendMessageSpy).not.toHaveBeenCalled();
        } finally {
            act(() => {
                tree?.unmount();
            });
            sessionSubagentSourceMessagesState.current = [];
            pendingFireAndForget.length = 0;
            sessionState.session.metadata.flavor = previousFlavor;
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
                occurrenceId: 'generation-1',
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
                occurrenceId: 'generation-1',
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
        writeSessionAttachmentDrafts(mainAttachmentDraftScope('server-1'), [{
            id: 'draft-note',
            source: { kind: 'native', uri: 'file:///tmp/draft-note.txt', name: 'draft-note.txt', sizeBytes: 1, mimeType: 'text/plain' },
            status: 'pending',
        }]);
        writeSessionDraftValue(
            TEST_SERVER_ACCOUNT_SCOPE,
            's1',
            'routing.executionRunRequestedAction',
            { v: 1, kind: 'send_now' },
        );

        let refreshPendingMessages!: () => void;
        const PendingMessageHarness = () => {
            const [refresh, setRefresh] = React.useState(0);
            refreshPendingMessages = () => setRefresh((current) => current + 1);
            return <AppPaneProvider>
                <SessionView
                    id="s1"
                    jumpToSeq={refresh}
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
                'routing.executionRunRequestedAction',
            )).toEqual({ v: 1, kind: 'send_now' });

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
                'routing.executionRunRequestedAction',
            )).toEqual({ v: 1, kind: 'send_now' });
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
            'routing.executionRunRequestedAction',
            { v: 1, kind: 'send_now' },
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
                'routing.executionRunRequestedAction',
                { v: 1, kind: 'enqueue' },
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
                'routing.executionRunRequestedAction',
            )).toEqual({ v: 1, kind: 'enqueue' });
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
        writeSessionAttachmentDrafts(mainAttachmentDraftScope('server-1'), [{
            id: 'draft-note',
            source: { kind: 'native', uri: 'file:///tmp/draft-note.txt', name: 'draft-note.txt', sizeBytes: 1, mimeType: 'text/plain' },
            status: 'pending',
        }]);
        writeSessionDraftValue(
            TEST_SERVER_ACCOUNT_SCOPE,
            's1',
            'routing.executionRunRequestedAction',
            { v: 1, kind: 'send_now' },
        );

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
                'routing.executionRunRequestedAction',
            )).toEqual({ v: 1, kind: 'send_now' });

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
                's1', 'p-edit', 'Edited queued text', {
                    v: 1,
                    mentions: [],
                    composerAttachments: [],
                }, {
                    ...pendingMessageAuthorityExpectation(),
                    preparedComposerAdmission: { stagedMediaHandles: [] },
                },
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
        updatePendingMessageSpy.mockImplementationOnce(deferPendingComposerUpdate(updateGate));

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
                's1', queuedMessage.id, 'Edited queued text', {
                    v: 1,
                    mentions: [],
                    composerAttachments: [],
                }, {
                    ...pendingMessageAuthorityExpectation(),
                    preparedComposerAdmission: { stagedMediaHandles: [] },
                },
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
        updatePendingMessageSpy.mockImplementationOnce(deferPendingComposerUpdate(updateGate));

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
                's1', queuedMessage.id, 'Edited queued text', {
                    v: 1,
                    mentions: [],
                    composerAttachments: [],
                }, {
                    ...pendingMessageAuthorityExpectation(),
                    preparedComposerAdmission: { stagedMediaHandles: [] },
                },
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
        updatePendingMessageSpy.mockImplementationOnce(deferPendingComposerUpdate(updateGate));

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
                's1', queuedMessage.id, 'Edited queued text', {
                    v: 1,
                    mentions: [],
                    composerAttachments: [],
                }, {
                    ...pendingMessageAuthorityExpectation(),
                    preparedComposerAdmission: { stagedMediaHandles: [] },
                },
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
        updatePendingMessageSpy.mockImplementationOnce(deferPendingComposerUpdate(updateGate));

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
                's1', queuedMessage.id, 'Edited @new.ts text', {
                    v: 1,
                    mentions: [],
                    composerAttachments: [],
                }, {
                    ...pendingMessageAuthorityExpectation(),
                    preparedComposerAdmission: { stagedMediaHandles: [] },
                },
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
            )).toEqual([]);
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
            )).toEqual([]);
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
                    mentions: [{
                        ...mention,
                        start: 0,
                        end: 13,
                    }],
                    composerAttachments: [attachment],
                },
                {
                    ...pendingMessageAuthorityExpectation(),
                    preparedComposerAdmission: { stagedMediaHandles: [] },
                },
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
                    'acme.issues/issue': {
                        ...daemonMergedProjectionState.value.inputs.pluginProjectionV2
                            .familiesById.composerAttachments.entriesById['acme.issues/issue'],
                        valueValidator: () => true,
                    },
                },
            });
            await act(async () => {
                const current = readComposerPresentationSnapshot(pendingRef);
                if (!current) throw new Error('expected active pending Composer snapshot');
                expect(attachmentApplier.apply({
                    ref: pendingRef,
                    admittedContributor: {
                        identity: { pluginId: 'acme.issues', localId: 'pending-editor' },
                        occurrenceId: 'issue-generation-a',
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
            preparePendingMessageComposerAdmissionMock.mockImplementationOnce(async (
                _sessionId: string,
                request: { localId: string },
            ) => ({
                ok: true,
                text: queuedMessage.text,
                structuredInput: {
                    v: 1,
                    composerAttachments: [{
                        ...changedAttachment,
                        value: { issueId: 430 },
                        presentation: { label: 'Prepared issue #430', typeLabel: 'Issue' },
                    }],
                },
                stagedMediaHandles: [],
                localId: request.localId,
            }));
            updatePendingMessageSpy.mockImplementationOnce(async (
                sessionId: string,
                pendingId: string,
                _text: string,
                _structuredInput: unknown,
                options?: Parameters<typeof acceptedPendingComposerFact>[3],
            ) => acceptedPendingComposerFact(sessionId, pendingId, {
                v: 1,
                composerAttachments: [{
                    ...changedAttachment,
                    value: { issueId: 431 },
                    presentation: { label: 'Persisted issue #431', typeLabel: 'Issue' },
                }],
            }, options));

            const agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onSend', undefined, 'AgentInput');
            });

            expect(pendingFireAndForget).toHaveLength(1);
            await act(async () => {
                await pendingFireAndForget[0];
            });
            expect(preparePendingMessageComposerAdmissionMock).toHaveBeenCalledTimes(1);
            const prepareRequest = preparePendingMessageComposerAdmissionMock.mock.calls[0]?.[1];
            expect(prepareRequest).toMatchObject({
                localId: expect.any(String),
                text: queuedMessage.text,
                structuredInput: {
                    v: 1,
                    composerAttachments: [{
                        instanceId: attachment.instanceId,
                        key: attachment.key,
                        value: changedAttachment.value,
                    }],
                },
            });
            const replacementLocalId = prepareRequest.localId;
            expect(replacementLocalId).not.toBe(queuedMessage.localId);
            expect(updatePendingMessageSpy).toHaveBeenCalledWith('s1', queuedMessage.id, queuedMessage.text, {
                v: 1,
                composerAttachments: [{
                    ...changedAttachment,
                    value: { issueId: 430 },
                    presentation: { label: 'Prepared issue #430', typeLabel: 'Issue' },
                }],
            }, expect.objectContaining({
                replacementLocalId,
                preparedComposerAdmission: { stagedMediaHandles: [] },
                ...pendingMessageAuthorityExpectation(),
            }));
            expect(acceptPendingMessageComposerAdmissionMock).toHaveBeenCalledWith('s1', {
                sessionId: 's1',
                localId: replacementLocalId,
                structuredInput: {
                    v: 1,
                    composerAttachments: [{
                        ...changedAttachment,
                        value: { issueId: 431 },
                        presentation: { label: 'Persisted issue #431', typeLabel: 'Issue' },
                    }],
                },
                stagedMediaHandles: [],
            }, expect.objectContaining({ serverId: 'server-1' }));
            expect(updatePendingMessageSpy.mock.invocationCallOrder[0])
                .toBeLessThan(acceptPendingMessageComposerAdmissionMock.mock.invocationCallOrder[0]!);
            expect(modalAlertSpy).not.toHaveBeenCalled();
        } finally {
            act(() => {
                tree?.unmount();
            });
            pendingFireAndForget.length = 0;
        }
    });

    it('keeps the pending edit when canonical attachment admission rejects', async () => {
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
                    'acme.issues/issue': {
                        ...daemonMergedProjectionState.value.inputs.pluginProjectionV2
                            .familiesById.composerAttachments.entriesById['acme.issues/issue'],
                        valueValidator: () => true,
                    },
                },
            });
            await act(async () => {
                const current = readComposerPresentationSnapshot(pendingRef);
                if (!current) throw new Error('expected active pending Composer snapshot');
                expect(attachmentApplier.apply({
                    ref: pendingRef,
                    admittedContributor: {
                        identity: { pluginId: 'acme.issues', localId: 'pending-editor' },
                        occurrenceId: 'issue-generation-a',
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
            // The canonical Session admission owner rejects any transform or
            // finalization failure before the Pending writer sees a payload.
            preparePendingMessageComposerAdmissionMock.mockResolvedValueOnce({
                ok: false,
                error: 'composer_attachment_admission_failed',
                errorCode: 'composer_attachment_admission_failed',
            });

            const agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onSend', undefined, 'AgentInput');
            });

            expect(pendingFireAndForget).toHaveLength(1);
            await act(async () => {
                await pendingFireAndForget[0];
            });
            // Nothing is persisted, and the refusal is reported instead of the
            // message being dropped silently at the queue.
            expect(updatePendingMessageSpy).not.toHaveBeenCalled();
            expect(modalAlertSpy).toHaveBeenCalled();
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
        writeSessionAttachmentDrafts(mainAttachmentDraftScope('server-1'), [{
            id: 'draft-note',
            source: { kind: 'native', uri: 'file:///tmp/draft-note.txt', name: 'draft-note.txt', sizeBytes: 1, mimeType: 'text/plain' },
            status: 'pending',
        }]);
        writeSessionDraftValue(
            TEST_SERVER_ACCOUNT_SCOPE,
            's1',
            'routing.executionRunRequestedAction',
            { v: 1, kind: 'send_now' },
        );

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
                'routing.executionRunRequestedAction',
            )).toEqual({ v: 1, kind: 'send_now' });
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

    it('clears a reference-only edit with unchanged accepted Main Session text', async () => {
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
                token: '@newer.ts',
                start: 21,
                end: 30,
                label: 'Newer issue',
            } as const;
            await act(async () => {
                const current = readComposerPresentationSnapshot(sessionRef);
                if (!current) throw new Error('expected active Session Composer snapshot');
                expect(applyComposerPresentationTransaction({
                    ref: sessionRef,
                    transaction: {
                        expectedRevision: current.revision,
                        operations: [{ kind: 'reference.insert', reference: newerMention }],
                    },
                }).status).toBe('applied');
            });
            agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            expect(agentInput.props.value).toBe('Use @accepted.ts and @newer.ts');
            expect(readComposerPresentationSnapshot(sessionRef)?.references).toEqual(expect.arrayContaining([
                expect.objectContaining({ ref: newerMention.ref, token: newerMention.token }),
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
            // Both reference transactions are ranges in the unchanged accepted
            // text. The document owner clears those ranges with their text.
            expect(readComposerPresentationSnapshot(sessionRef)?.references).toEqual([]);
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

    it.each([false, true])('sends review comments and attachments with both metadata envelopes (execution run: %s)', async (executionRun) => {
        // The real shell only admits a session whose cached Home matches its route.
        const previousServerId = sessionState.session.serverId;
        sessionState.session.serverId = 'server-1';
        featureEnabledState.reviewComments = true;
        chooseSubmitModeState.mode = 'agent_queue';
        if (executionRun) {
            sessionSubagentSourceMessagesState.current = [createRunningSubAgentRunMessage('run-review')];
            writeSessionDraftValue(TEST_SERVER_ACCOUNT_SCOPE, 's1', 'routing.recipient', {
                kind: 'execution_run', runId: 'run-review',
            });
            writeSessionDraftValue(TEST_SERVER_ACCOUNT_SCOPE, 's1', 'routing.executionRunRequestedAction', { v: 1, kind: 'enqueue' });
        }
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
        enqueuePendingMessageSpy.mockClear();
        resumeSessionSpy.mockClear();
        uploadSpy.mockClear();
        modalAlertSpy.mockClear();
        resolveSessionComposerSendMock.mockClear();
        deleteWorkspaceReviewCommentDraftSpy.mockClear();
        pendingFireAndForget.length = 0;

        let tree: renderer.ReactTestRenderer | undefined;
        try {
            tree = (await renderScreen(<AppPaneProvider>
                        <SessionView id="s1" routeServerId="server-1" />
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

            const writer = executionRun ? enqueuePendingMessageSpy : sendMessageSpy;
            expect(writer).toHaveBeenCalledTimes(1);
            if (executionRun) {
                expect(sendMessageSpy).not.toHaveBeenCalled();
                expect(resumeSessionSpy).not.toHaveBeenCalled();
                expect(writer.mock.calls[0]?.[4]).toMatchObject({
                    recipient: { kind: 'execution_run', runId: 'run-review' },
                    requestedAction: { v: 1, kind: 'enqueue' },
                });
            }
            const [sentSessionId, sentText, sentDisplayText, sentMetaOverrides] = writer.mock.calls[0] ?? [];
            expect(sentSessionId).toBe('s1');
            expect(String(sentText)).toContain('Please verify this project change.');
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
            sessionState.session.serverId = previousServerId;
            featureEnabledState.reviewComments = false;
            reviewCommentDraftsState.current = [];
            sessionSubagentSourceMessagesState.current = [];
            act(() => {
                tree?.unmount();
            });
            pendingFireAndForget.length = 0;
        }
    });

    it('admits a pending seeded walkthrough through saved-result discussion without sending to the Session agent', async () => {
        // Real credential-resolution and draft owners; only credential custody and
        // the machine RPC transport are external boundaries in this composed case.
        const { upsertServerProfile } = await import('@/sync/domains/server/serverProfiles');
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const scmTransport = await import('@/sync/ops/sessionScm');
        const { getSessionDraftSnapshot, writeExistingSessionDraft } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
        const home = await upsertServerProfile({ name: 'Seeded walkthrough test', serverUrl: 'https://seeded-walkthrough.example.test' });
        const scope = { serverId: home.id, accountId: 'account-1' };
        const credentials = vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({
            token: `header.${Buffer.from(JSON.stringify({ sub: scope.accountId })).toString('base64url')}.signature`,
        });
        const transport = vi.spyOn(scmTransport, 'runSessionScmRpc');
        const conflictResponse = { success: false, errorCode: 'revision_conflict', error: 'Changed', latestRevision: 5 };
        const discussionResponse = { success: true, runId: 'seeded-run', result: { resultId: 'saved', revision: 5, canUndo: false,
            output: { success: true, resultId: 'saved', revision: 5, runId: 'seeded-run', sourceKey: 'comparison',
                metadata: { sourceKey: 'comparison', source: { kind: 'workingTree' } },
                comparison: { id: 'comparison', source: { kind: 'workingTree' }, repository: { rootPath: '/tmp' }, endpoints: {}, inventory: { state: 'complete', files: [], reasons: [] } },
                requestedOutputs: ['walkthrough'], outputs: { walkthrough: { state: 'pending' } },
                analysis: { suppliedChangeRefs: [], analysedChangeRefs: [], remainingChangeRefs: [] } } } };
        transport.mockResolvedValueOnce(conflictResponse);
        transport.mockResolvedValueOnce(discussionResponse);
        const previousServerId = sessionState.session.serverId;
        sessionState.session.serverId = home.id;
        featureEnabledState.reviewComments = false;
        const target = { cwd: '/tmp', resultId: 'saved', expectedRevision: 4, startNew: true };
        writeExistingSessionDraft({ scope, sessionId: 's1', patch: { text: '/compact explain this stop',
            routing: { recipient: { mode: 'scm_diff_summary', recipient: null, target } } }, materializationIntent: 'userEdit' });
        let tree: renderer.ReactTestRenderer | undefined;
        try {
            tree = (await renderScreen(<AppPaneProvider><SessionView id="s1" routeServerId={home.id} /></AppPaneProvider>)).tree;
            const mounted = tree;
            if (!mounted) throw new Error('SessionView did not mount');
            await vi.waitFor(() => {
                const input = findTestInstanceByTypeWithProps(mounted, 'AgentInput', {});
                expect(input?.props.extraActionChips?.some((chip: { controlId?: string; collapsedOptionsPopover?: { selectedOptionId?: string } }) => (
                    chip.controlId === 'recipient' && chip.collapsedOptionsPopover?.selectedOptionId === 'pending-scm-discussion'
                ))).toBe(true);
            });
            // This older shell harness intentionally substitutes useDraft's local
            // text projection. Enter through its real mounted input after binding.
            await act(async () => invokeTestInstanceHandler(findTestInstanceByTypeWithProps(mounted, 'AgentInput', {}),
                'onChangeText', '/compact explain this stop', 'AgentInput'));
            pendingFireAndForget.length = 0;
            resolveSessionComposerSendMock.mockClear();
            for (let attempt = 0; attempt < 2; attempt += 1) {
                const input = findTestInstanceByTypeWithProps(mounted, 'AgentInput', {});
                await act(async () => {
                    invokeTestInstanceHandler(input, 'onSend', undefined, 'AgentInput');
                    await pendingFireAndForget.at(-1);
                });
                const document = getSessionDraftSnapshot(scope, { kind: 'session', sessionId: 's1' })?.document;
                expect(document?.composer.text.value).toBe(attempt === 0 ? '/compact explain this stop' : '');
                expect(document?.target.kind === 'session' && document.target.routing.recipient.value).toEqual(attempt === 0
                    ? { mode: 'scm_diff_summary', recipient: null, target }
                    : { mode: 'manual', recipient: { kind: 'execution_run', runId: 'seeded-run' } });
            }
            expect(transport).toHaveBeenCalledTimes(2);
            expect(transport.mock.calls[0]?.[2]).toEqual({ ...target, message: '/compact explain this stop' });
            expect(resolveSessionComposerSendMock).not.toHaveBeenCalled();
            expect(sendMessageSpy).not.toHaveBeenCalled();
            expect(enqueuePendingMessageSpy).not.toHaveBeenCalled();
            expect(resumeSessionSpy).not.toHaveBeenCalled();
        } finally {
            act(() => tree?.unmount());
            transport.mockRestore();
            credentials.mockRestore();
            sessionState.session.serverId = previousServerId;
            clearSessionDraftValuesForSession(scope, 's1');
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
            sessionState.session.active = false;
            sessionState.session.presence = 0;
            syncPendingRowForLocalId('armed-local-id');
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
                expect(screen.findAllByTestId('session-pendingActivation').length)
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
            const row = {
                id: `pending-${localId}`,
                localId,
                createdAt: 1,
                updatedAt: 1,
                source: 'server_pending' as const,
                messageRole: 'user' as const,
                pendingDeliveryStatus: 'server_queued' as const,
                pendingRequestedAction: { v: 1 as const, kind: 'enqueue' as const },
                text: 'queued message',
                rawRecord: { role: 'user', content: { type: 'text', text: 'queued message' } },
            };
            canonicalSessionPendingState.s1 = {
                messages: [row],
                discarded: [],
                isLoaded: true,
            } as SessionPending;
            sessionPendingMessagesState.current = [row];
            act(() => {
                for (const listener of sessionPendingMessagesState.listeners) listener();
            });
        }

        it('keeps same-mount Agent switching in the composer send state until the transition answers', async () => {
            setCurrentComposerAttachmentProjection();
            armSecondAgent();
            resolveSessionComposerSendMock.mockImplementationOnce(() => ({
                kind: 'send',
                text: 'switch and send this',
            }));
            let settleTransition: (result: unknown) => void = () => {};
            runSessionAgentTransitionSpy.mockImplementationOnce(() => new Promise((resolve) => {
                settleTransition = resolve;
            }) as any);

            const screen = await renderScreen(<AppPaneProvider>
                        <SessionView id="s1" />
                    </AppPaneProvider>);
            pendingFireAndForget.length = 0;
            if (!screen.tree) throw new Error('SessionView test renderer did not mount');
            try {
                const agentInput = findTestInstanceByTypeWithProps(screen.tree, 'AgentInput' as any, {}) as any;
                await act(async () => {
                    invokeTestInstanceHandler(agentInput, 'onChangeText', 'switch and send this', 'AgentInput');
                });
                await act(async () => {
                    invokeTestInstanceHandler(agentInput, 'onSend', undefined, 'AgentInput');
                    await Promise.resolve();
                });

                expect(runSessionAgentTransitionSpy).toHaveBeenCalledTimes(1);
                expect(screen.getTextContent()).not.toContain('session.agentContinuation.transition.unknown');
                expect(screen.findAllByTestId('session.agentTransitionOutcome.banner')).toHaveLength(0);

                // The Pending row can synchronize before the transition RPC answers.
                // While the same-mount send still owns the operation, the generic
                // inactive-session recovery must not compete with its spinner or
                // imply that the reader needs to resume the source Agent.
                syncPendingRowForLocalId('armed-local-id');
                expect(screen.findAllByTestId('session-pendingActivation')).toHaveLength(0);
                const inFlightInput = findTestInstanceByTypeWithProps(screen.tree, 'AgentInput' as any, {}) as any;
                expect(inFlightInput.props.isSending).toBe(true);
                expect((inFlightInput.props.statusBadges as readonly { testID?: string }[])
                    .some((badge) => badge.testID === 'session.pendingActivation.badge')).toBe(false);

                await act(async () => {
                    settleTransition({ type: 'accepted', localId: 'armed-local-id' });
                    await pendingFireAndForget[0];
                });

                // Suppression is only for the live operation. If the target has
                // not become active yet, the existing pending-activation owner is
                // still the post-operation recovery surface.
                expect(screen.findAllByTestId('session-pendingActivation').length).toBeGreaterThan(0);
            } finally {
                act(() => { screen.tree?.unmount(); });
                pendingFireAndForget.length = 0;
            }
        });

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
                expect(screen.findAllByTestId('session-pendingActivation')).toHaveLength(0);

                sessionState.session.active = false;
                sessionState.session.presence = 0;
                syncPendingRowForLocalId('armed-local-id');

                expect(screen.findAllByTestId('session-pendingActivation').length)
                    .toBeGreaterThan(0);
                // Never an invitation to send the same input twice: the only action
                // is the Session's own resume owner, which drains the queue.
                expect(screen.findAllByTestId('session-pendingActivation-resume').length)
                    .toBeGreaterThan(0);
            } finally {
                act(() => { screen.tree?.unmount(); });
                pendingFireAndForget.length = 0;
            }
        });

        it('does not show a stale queued-input activation banner while the Session and machine are reachable', async () => {
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
                expect(screen.findAllByTestId('session-pendingActivation')).toHaveLength(0);
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
            sessionState.session.active = false;
            sessionState.session.presence = 0;
            syncPendingRowForLocalId('armed-local-id');
            const screen = await sendArmedAndReadBanner({ type: 'accepted', localId: 'armed-local-id' });
            try {
                expect(modalAlertSpy).not.toHaveBeenCalled();
                // Still no second banner of its own — the Session's existing
                // queued-message owner says it, exactly as for `target_start_failed`.
                expect(screen.findAllByTestId('session.agentTransitionOutcome.banner')).toHaveLength(0);
                expect(screen.findAllByTestId('session-pendingActivation').length)
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
                expect(screen.findAllByTestId('session-pendingActivation')).toHaveLength(0);
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
                meta: { [COMPOSER_SOURCE_REF_PRIVATE_META_FIELD_V1]: { kind: 'session', sessionId: 's1' } },
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
            ensureSessionVisibleSpy.mockImplementation(async () => {
                await canonicalRefresh;
                return { kind: 'available' };
            });
            refreshSessionMessagesSpy.mockImplementation(async () => {
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
            ensureSessionVisibleSpy.mockImplementation(async () => {
                await canonicalRefresh;
                return { kind: 'available' };
            });
            refreshSessionMessagesSpy.mockImplementation(async () => {
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
