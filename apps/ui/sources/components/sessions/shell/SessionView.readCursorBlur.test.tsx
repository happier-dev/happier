import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).__DEV__ = false;

const markSessionViewedSpy = vi.hoisted(() => vi.fn(async () => {}));
const scheduledInteractionCallbacks = vi.hoisted<(() => void)[]>(() => []);
const sessionState = vi.hoisted(() => ({
    current: {
        id: 's1',
        seq: 2,
        presence: 'online',
        active: true,
        accessLevel: 'edit',
        modelMode: { defaultMode: 'build' },
        metadata: { machineId: 'm1', flavor: 'codex', version: '0.0.0', path: '/tmp', homeDir: '/tmp' },
        agentState: {},
    } as any,
}));
const focusCleanupState = vi.hoisted(() => ({ current: null as null | (() => void) }));

vi.mock('react-native-reanimated', () => ({}));
vi.mock('expo-linear-gradient', () => ({
    LinearGradient: 'LinearGradient',
}));
vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
    Octicons: 'Octicons',
}));
vi.mock('react-native', async (importOriginal) => {
    const actual = await importOriginal<any>();
    return {
        ...actual,
        View: 'View',
        Text: 'Text',
        Pressable: 'Pressable',
        ActivityIndicator: 'ActivityIndicator',
        Platform: {
            ...actual.Platform,
            OS: 'web',
            select: (spec: Record<string, unknown>) =>
                spec && Object.prototype.hasOwnProperty.call(spec, 'web') ? (spec as any).web : (spec as any).default,
        },
        useWindowDimensions: () => ({ width: 1200, height: 800 }),
    };
});
vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

const themeColors = {
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
    input: { background: '#f5f5f5', placeholder: '#999' },
    header: { tint: '#000' },
    status: { error: '#f00' },
    shadow: { color: '#000', opacity: 0.2 },
    groupped: { background: '#F5F5F5', chevron: '#C7C7CC', sectionTitle: '#8E8E93' },
    box: {
        warning: { background: '#fff4cc', border: '#f0d98a', text: '#000' },
    },
};

vi.mock('react-native-unistyles', () => ({
    __esModule: true,
    useUnistyles: () => ({
        theme: {
            dark: false,
            colors: themeColors,
        },
    }),
    StyleSheet: {
        create: (styles: any) =>
            typeof styles === 'function'
                ? styles({ colors: themeColors }, {})
                : styles,
        absoluteFillObject: {},
        hairlineWidth: 1,
    },
}));

vi.mock('@react-navigation/native', () => ({
    useFocusEffect: (effect: () => void | (() => void)) => {
        const cleanup = effect();
        focusCleanupState.current = typeof cleanup === 'function' ? cleanup : null;
    },
    useIsFocused: () => true,
}));

vi.mock('expo-router', () => ({
    useRouter: () => ({ push: vi.fn(), back: vi.fn(), setParams: vi.fn() }),
    usePathname: () => '/',
}));

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ credentials: { token: 't', secret: 's' } }),
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/components/sessions/transcript/AgentContentView', () => ({
    AgentContentView: (props: any) => React.createElement('AgentContentView', props, props.input ?? null),
}));
vi.mock('@/components/appShell/panes/AppPaneScopeHost', () => ({
    AppPaneScopeHost: (props: any) => React.createElement('AppPaneScopeHost', props, props.main ?? null),
}));
vi.mock('@/components/sessions/panes/useRegisterSessionPaneDriver', () => ({
    useRegisterSessionPaneDriver: () => 'session:s1',
}));
vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: () => ({
        openRight: vi.fn(),
        setRightTab: vi.fn(),
        closeRight: vi.fn(),
        openDetailsTab: vi.fn(),
        closeDetails: vi.fn(),
        pinDetailsTab: vi.fn(),
        closeDetailsTab: vi.fn(),
        setActiveDetailsTab: vi.fn(),
        setRightTabState: vi.fn(),
        scopeState: { right: { isOpen: false, activeTabId: null, tabState: {} }, details: { isOpen: false, tabs: [], activeTabKey: null } },
    }),
}));
vi.mock('@/components/sessions/panes/url/useSessionPaneUrlSync', () => ({
    useSessionPaneUrlSync: () => {},
}));
vi.mock('@/components/sessions/transcript/ChatHeaderView', () => ({
    ChatHeaderView: () => null,
}));
vi.mock('@/components/sessions/transcript/ChatList', () => ({
    ChatList: () => React.createElement('ChatList'),
}));
vi.mock('@/components/ui/empty/EmptyMessages', () => ({
    EmptyMessages: () => React.createElement('EmptyMessages'),
}));
vi.mock('@/components/ui/forms/Deferred', () => ({
    Deferred: (props: any) => React.createElement(React.Fragment, null, props.children),
}));
vi.mock('@/components/sessions/actions/SessionHeaderActionMenu', () => ({
    SessionHeaderActionMenu: () => null,
}));
vi.mock('@/components/sessions/actions/SessionHeaderSubagentsButton', () => ({
    SessionHeaderSubagentsButton: () => null,
}));
vi.mock('@/components/sessions/actions/SessionHeaderTerminalButton', () => ({
    SessionHeaderTerminalButton: () => null,
}));
vi.mock('@/components/voice/surface/VoiceSurface', () => ({
    VoiceSurface: () => null,
}));
vi.mock('@/components/sessions/attachments/AttachmentFilePicker', () => ({
    AttachmentFilePicker: () => null,
}));
vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => false,
}));
vi.mock('@/hooks/server/useSessionExecutionRunsSupported', () => ({
    useSessionExecutionRunsSupported: () => false,
}));
vi.mock('@/hooks/session/files/useWarmRepositoryDirectoryCacheOnSessionOpen', () => ({
    useWarmRepositoryDirectoryCacheOnSessionOpen: () => {},
}));
vi.mock('@/hooks/session/useDraft', () => ({
    useDraft: () => ({ clearDraft: vi.fn() }),
}));
vi.mock('@/utils/platform/responsive', () => ({
    getDeviceType: () => 'tablet',
    useDeviceType: () => 'tablet',
    useHeaderHeight: () => 0,
    useIsLandscape: () => false,
    useIsTablet: () => true,
}));
vi.mock('@/components/sessions/model/inactiveSessionUi', () => ({
    getInactiveSessionUiState: () => ({ noticeKind: 'none', inactiveStatusTextKey: null, shouldShowInput: true }),
}));
vi.mock('@/components/sessions/model/useSessionMachineReachability', () => ({
    useSessionMachineReachability: () => ({ machineReachable: true, machineOnline: true, machineRpcTargetAvailable: true }),
}));
vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => ({ serverId: 'server-1' }),
    subscribeActiveServer: () => () => {},
}));
vi.mock('@/voice/session/voiceSession', () => ({
    useVoiceSessionSnapshot: () => ({ status: 'disconnected' }),
    voiceSessionManager: {},
}));
vi.mock('@/sync/sync', () => ({
    sync: {
        markSessionViewed: markSessionViewedSpy,
        fetchPendingMessages: vi.fn(async () => {}),
        publishSessionPermissionModeToMetadata: async () => {},
        publishSessionAcpSessionModeOverrideToMetadata: async () => {},
        publishSessionAcpConfigOptionOverrideToMetadata: async () => {},
        publishSessionModelOverrideToMetadata: async () => {},
        refreshSessions: async () => {},
        onSessionVisible: () => {},
        sendMessage: async () => {},
        enqueuePendingMessage: async () => {},
        submitMessage: async () => {},
        encryption: { getMachineEncryption: () => null },
        onSessionViewportChange: () => {},
    },
}));
vi.mock('@/sync/ops', () => ({
    continueSessionWithReplay: vi.fn(),
    sessionAbort: vi.fn(),
    resumeSession: vi.fn(),
    sessionAttachmentsUploadFile: vi.fn(),
    sessionSwitch: vi.fn(async () => true),
}));
vi.mock('@/sync/ops/actions/defaultActionExecutor', () => ({
    createDefaultActionExecutor: () => ({ execute: vi.fn() }),
}));
vi.mock('@/components/sessions/agentInput', () => ({
    AgentInput: () => null,
}));
vi.mock('@/modal', () => ({
    Modal: { alert: vi.fn(), confirm: vi.fn(), prompt: vi.fn(), show: vi.fn() },
}));
vi.mock('@/utils/timing/runAfterInteractionsWithFallback', () => ({
    runAfterInteractionsWithFallback: (callback: () => void) => {
        scheduledInteractionCallbacks.push(callback);
        return () => {};
    },
}));

vi.mock('@/sync/domains/state/storage', () => ({
    storage: {
        getState: () => ({
            sessions: { s1: sessionState.current },
            settings: {},
            sessionListViewDataByServerId: {},
        }),
    },
    useSession: () => sessionState.current,
    useAutomations: () => [],
    useIsDataReady: () => true,
    useRealtimeStatus: () => ({ current: { status: 'connected' } as any }),
    useSessionMessages: () => ({ messages: [], isLoaded: true }),
    useSessionTranscriptIds: () => ({ ids: [], isLoaded: true }),
    useSessionPendingMessages: () => ({ messages: [] }),
    useSessionReviewCommentsDrafts: () => [],
    useSessionUsage: () => null,
    useSetting: () => null,
    useSettings: () => ({ experiments: true, featureToggles: {} }),
    useLocalSetting: (key: string) => {
        if (key === 'acknowledgedCliVersions') return {};
        if (key === 'detailsPaneTabsBehavior') return 'preview';
        if (key === 'rightPaneWidthPx') return 360;
        if (key === 'rightPaneWidthBasisPx') return 1200;
        if (key === 'detailsPaneWidthPx') return 520;
        if (key === 'detailsPaneWidthBasisPx') return 1200;
        if (key === 'sessionsRightPaneDefaultOpen') return false;
        if (key === 'sessionPermissionModeApplyTiming') return 'immediate';
        if (key === 'uiMultiPanePanelsEnabled') return true;
        if (key === 'editorFocusModeEnabled') return false;
        return null;
    },
}));
vi.mock('@/sync/store/settingsWriters', () => ({
    useApplyLocalSettings: () => vi.fn(),
}));
vi.mock('@/agents/catalog/catalog', () => ({
    AGENT_IDS: ['default'],
    DEFAULT_AGENT_ID: 'default',
    buildResumeSessionExtrasFromUiState: () => null,
    getAgentCore: () => ({ title: 'Agent', modelMode: { defaultMode: 'build' } }),
    resolveAgentIdFromFlavor: () => 'default',
}));
vi.mock('@/agents/runtime/resumeCapabilities', () => ({
    canResumeSessionWithOptions: () => false,
}));
vi.mock('@/agents/hooks/useResumeCapabilityOptions', () => ({
    useResumeCapabilityOptions: () => [],
}));
vi.mock('@/sync/domains/input/reviewComments/reviewCommentPrompt', () => ({
    buildReviewCommentsDisplayText: () => '',
    buildReviewCommentsPromptText: () => '',
}));
vi.mock('@/sync/domains/input/reviewComments/reviewCommentMeta', () => ({
    buildReviewCommentsV1MetaPayload: () => ({}),
}));
vi.mock('@/sync/domains/input/slashCommands/resolveSessionComposerSend', () => ({
    resolveSessionComposerSend: () => null,
}));
vi.mock('@/sync/domains/input/slashCommands/expandPromptTemplateInvocation', () => ({
    expandPromptTemplateInvocation: () => null,
}));
vi.mock('@/sync/domains/permissions/permissionModeApply', () => ({
    applyPermissionModeSelection: vi.fn(),
}));
vi.mock('@/sync/acp/sessionModeControl', () => ({
    supportsSessionModeOverrides: () => false,
}));
vi.mock('@/track', () => ({
    tracking: null,
    trackMessageSent: vi.fn(),
}));
vi.mock('@/utils/platform/platform', () => ({
    isRunningOnMac: () => false,
}));
vi.mock('@/platform/randomUUID', () => ({
    randomUUID: () => 'uuid',
}));
vi.mock('@/utils/sessions/sessionUtils', () => ({
    formatPathRelativeToHome: () => '/tmp',
    getSessionAvatarId: () => 'avatar',
    getSessionName: () => 'Session',
    listPendingPermissionRequests: () => [],
    listPendingUserActionRequests: () => [],
    shouldShowAbortButtonForSessionState: () => false,
    useSessionStatus: () => 'online',
}));
vi.mock('@/utils/sessions/deriveTranscriptInteraction', () => ({
    deriveTranscriptInteraction: () => ({
        canApprovePermissions: false,
        permissionDisabledReason: null,
        canAbort: false,
        canResume: false,
        resumeDisabledReason: null,
    }),
}));
vi.mock('@/utils/system/versionUtils', () => ({
    isVersionSupported: () => true,
    MINIMUM_CLI_VERSION: '0.0.0',
}));
vi.mock('@/utils/system/fireAndForget', () => ({
    fireAndForget: (promise: Promise<unknown> | void) => promise,
}));
vi.mock('@/capabilities/ensureAgentInstallablesBackground', () => ({
    ensureAgentInstallablesBackground: () => {},
}));
vi.mock('@/sync/domains/pending/pendingQueueWake', () => ({
    getPendingQueueWakeResumeOptions: () => null,
}));
vi.mock('@/sync/domains/permissions/permissionModeOverride', () => ({
    getPermissionModeOverrideForSpawn: () => null,
}));
vi.mock('@/sync/domains/models/modelOverride', () => ({
    getModelOverrideForSpawn: () => null,
}));
vi.mock('@/components/sessions/agentInput/recipient/RecipientChip', () => ({
    RecipientChip: () => null,
}));
vi.mock('@/components/sessions/agentInput/recipient/useSessionRecipientState', () => ({
    useSessionRecipientState: () => ({
        recipientId: null,
        recipientChipProps: null,
        participantSidechainIds: [],
        selectedParticipant: null,
    }),
}));
vi.mock('@/components/sessions/agentInput/recipient/ExecutionRunDeliveryChip', () => ({
    ExecutionRunDeliveryChip: () => null,
}));
vi.mock('@/sync/domains/input/participants/resolveParticipantRoutedSend', () => ({
    resolveParticipantRoutedSend: () => null,
}));
vi.mock('@/hooks/session/useEnsureSidechainsLoaded', () => ({
    useEnsureSidechainsLoaded: () => {},
}));
vi.mock('@/hooks/session/useSessionSubagents', () => ({
    useSessionSubagents: () => ({ subagents: [], participantTargets: [], sidechainIds: [] }),
}));
vi.mock('@/agents/registry/sessionSubagentUiBehavior', () => ({
    hasSessionSubagentLaunchCards: () => false,
}));
vi.mock('@/sync/ops/sessionExecutionRuns', () => ({
    isExecutionRunNotRunningSendError: () => false,
    sessionExecutionRunSend: vi.fn(),
}));
vi.mock('@/sync/runtime/time', () => ({
    nowServerMs: () => 0,
}));
vi.mock('@/sync/domains/session/resume/resumeSessionBase', () => ({
    buildResumeSessionBaseOptionsFromSession: () => null,
}));
vi.mock('@/sync/domains/session/resume/happierReplayPrompt', () => ({
    resolveHappierReplayConfig: () => null,
}));
vi.mock('@/sync/domains/session/control/submitMode', () => ({
    chooseSubmitMode: () => 'submit',
}));
vi.mock('@/sync/domains/session/control/sessionLocalControl', () => ({
    getSessionLocalControlState: () => null,
    isSessionLocallyAttached: () => true,
}));
vi.mock('@/sync/domains/session/subagents/deriveSessionSubagentCounts', () => ({
    deriveSessionSubagentCounts: () => ({ total: 0, active: 0 }),
}));
vi.mock('@/sync/domains/models/modelOptions', () => ({
    isModelSelectableForSession: () => true,
}));
vi.mock('@/sync/domains/session/control/localControlSwitch', () => ({
    shouldRenderChatTimelineForSession: () => true,
    shouldRequestRemoteControlAfterPendingEnqueue: () => false,
}));
vi.mock('@/sync/domains/session/control/controlSwitchUiTimeout', () => ({
    readControlSwitchUiTimeoutMsFromEnv: () => 1000,
}));

describe('SessionView read cursor on blur', () => {
    beforeEach(() => {
        sessionState.current.seq = 2;
        markSessionViewedSpy.mockClear();
        scheduledInteractionCallbacks.length = 0;
        focusCleanupState.current = null;
    });

    it('bounds the blur read mark to the seq visible when leaving the session', async () => {
        const { SessionView } = await import('./SessionView');

        let tree: renderer.ReactTestRenderer | undefined;
        await act(async () => {
            tree = renderer.create(
                <AppPaneProvider>
                    <SessionView id="s1" />
                </AppPaneProvider>,
            );
        });

        expect(focusCleanupState.current).toBeTypeOf('function');

        // Ignore work scheduled on initial focus; we care about the blur path.
        scheduledInteractionCallbacks.length = 0;
        markSessionViewedSpy.mockClear();

        act(() => {
            focusCleanupState.current?.();
        });

        expect(scheduledInteractionCallbacks).toHaveLength(1);

        // Simulate a later assistant message landing after navigation away.
        sessionState.current.seq = 4;

        await act(async () => {
            const callback = scheduledInteractionCallbacks.shift();
            callback?.();
        });

        expect(markSessionViewedSpy).toHaveBeenCalledTimes(1);
        expect(markSessionViewedSpy).toHaveBeenCalledWith('s1', { sessionSeq: 2 });

        act(() => {
            tree?.unmount();
        });
    });
});
