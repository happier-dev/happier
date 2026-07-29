import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
const chooseSubmitModeState = vi.hoisted(() => ({
    mode: 'agent_queue',
}));
const reviewCommentDraftsState = vi.hoisted(() => ({
    current: [] as any[],
}));
const sessionPendingMessagesState = vi.hoisted(() => ({
    current: [] as any[],
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
    useFeatureEnabled: (featureId: string) =>
        featureId === 'attachments.uploads'
        || (featureId === 'files.reviewComments' && featureEnabledState.reviewComments),
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
vi.mock('@/voice/session/voiceSession', () => ({
    useVoiceSessionSnapshot: () => ({ status: 'disconnected' }),
    voiceSessionManager: {},
}));

const sendMessageSpy = vi.fn(async (..._args: any[]) => {});
const enqueuePendingMessageSpy = vi.fn(async (..._args: any[]) => ({ localId: 'pending-local-id' }));
const updatePendingMessageSpy = vi.fn(async (..._args: any[]) => {});
const patchSessionMetadataWithRetrySpy = vi.fn(async (..._args: any[]) => {});

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
        continueSessionWithReplay: vi.fn(),
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
            useIsDataReady: () => true,
            useRealtimeStatus: () => ({ status: 'connected' }),
            useSessionMessages: () => ({ messages: [], isLoaded: true }),
            useSessionTranscriptIds: () => ({ ids: [], isLoaded: true }),
            useSessionPendingMessages: () => ({ messages: sessionPendingMessagesState.current, discarded: [] }),
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
    isAgentId: (value: unknown) => value === 'codex',
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
        if (tag === 'SessionView.sendMessage.attachments' || tag === 'SessionView.pendingMessageEdit.save') {
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
        resumeSessionSpy.mockClear();
        uploadSpy.mockClear();
        modalAlertSpy.mockClear();
        resolveSessionComposerSendMock.mockClear();
        chatListPropsSpy.mockClear();
        deleteWorkspaceReviewCommentDraftSpy.mockClear();
        reviewCommentDraftsState.current = [];
        sessionPendingMessagesState.current = [];
        sessionState.session.seq = 0;
        resetSessionShellDraftStateForTest();
        clearSessionDraftValuesForSession(TEST_SERVER_ACCOUNT_SCOPE, 's1', { reason: 'composerClear' });
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

            agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            expect(agentInput.props.value).toBe('Queued edit text');
            expect(readSessionShellDraftTextForTest('s1')).toBe('Queued edit text');

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

        let tree: renderer.ReactTestRenderer | undefined;
        try {
            const element = <AppPaneProvider>
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
            </AppPaneProvider>;
            tree = (await renderScreen(element)).tree;

            const renderedTree = tree;
            expect(renderedTree).toBeDefined();
            if (!renderedTree) throw new Error('SessionView test renderer did not mount');

            let agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            expect(agentInput.props.attachments).toEqual([
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
            expect(agentInput.props.attachments).toEqual([]);
            expect(readSessionDraftValue(
                TEST_SERVER_ACCOUNT_SCOPE,
                's1',
                'routing.executionRunDelivery',
            )).toBeUndefined();

            await act(async () => {
                invokeTestInstanceHandler(agentInput, 'onChangeText', 'Edited queued text', 'AgentInput');
            });

            sessionPendingMessagesState.current = [];
            await act(async () => {
                renderedTree.update(<AppPaneProvider>
                    <SessionView id="s1" />
                </AppPaneProvider>);
                await Promise.resolve();
            });

            agentInput = findTestInstanceByTypeWithProps(renderedTree, 'AgentInput' as any, {}) as any;
            expect(agentInput.props.value).toBe('Edited queued text');
            expect(agentInput.props.attachments).toEqual([
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
            expect(agentInput.props.attachments).toEqual([
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

            expect(readSessionShellDraftTextForTest('s1')).toBe('Edited queued text');
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
            expect(updatePendingMessageSpy).toHaveBeenCalledWith('s1', 'p-edit', 'Edited queued text');
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
});
