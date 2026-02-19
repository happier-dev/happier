import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).__DEV__ = false;

const pendingFireAndForget: Promise<unknown>[] = [];

const resolveSessionComposerSendMock = vi.fn((..._args: any[]) => ({ kind: 'send', text: 'hello' }));

vi.mock('react-native-reanimated', () => ({}));
vi.mock('expo-linear-gradient', () => ({
    LinearGradient: 'LinearGradient',
}));
vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));
vi.mock('react-native', () => ({
    View: 'View',
    Text: 'Text',
    Pressable: 'Pressable',
    ActivityIndicator: 'ActivityIndicator',
    Platform: {
        OS: 'ios',
        select: (spec: Record<string, unknown>) =>
            spec && Object.prototype.hasOwnProperty.call(spec, 'ios') ? (spec as any).ios : (spec as any).default,
    },
}));
vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            dark: false,
            colors: {
                text: '#000',
                textSecondary: '#666',
                surface: '#fff',
                header: { tint: '#000' },
                status: { error: '#f00' },
                shadow: { color: '#000', opacity: 0.2 },
            },
        },
    }),
    StyleSheet: {
        create: (styles: any) => (typeof styles === 'function' ? styles({ colors: {} }) : styles),
        absoluteFillObject: {},
    },
}));

vi.mock('@react-navigation/native', () => ({
    useFocusEffect: () => {},
}));

vi.mock('expo-router', () => ({
    useRouter: () => ({ push: vi.fn(), back: vi.fn() }),
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
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
vi.mock('@/components/sessions/attachments/AttachmentFilePicker', () => ({
    AttachmentFilePicker: () => null,
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (featureId: string) => featureId === 'attachments.uploads',
}));

vi.mock('@/utils/platform/responsive', () => ({
    useDeviceType: () => 'phone',
    useHeaderHeight: () => 0,
    useIsLandscape: () => false,
    useIsTablet: () => false,
}));
vi.mock('@/hooks/session/useDraft', () => ({
    useDraft: () => ({ clearDraft: vi.fn() }),
}));
vi.mock('@/components/sessions/model/inactiveSessionUi', () => ({
    getInactiveSessionUiState: () => ({ noticeKind: 'none', inactiveStatusTextKey: null, shouldShowInput: true }),
}));
vi.mock('@/components/sessions/model/resolveSessionMachineReachability', () => ({
    resolveSessionMachineReachability: () => true,
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => ({ serverId: 'server-1' }),
}));
vi.mock('@/voice/session/voiceSession', () => ({
    useVoiceSessionSnapshot: () => ({ status: 'disconnected' }),
    voiceSessionManager: {},
}));

const sendMessageSpy = vi.fn(async (..._args: any[]) => {});

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
        sendMessage: (...args: any[]) => sendMessageSpy(...args),
        enqueuePendingMessage: async () => {},
        submitMessage: async () => {},
        encryption: {
            getMachineEncryption: () => null,
        },
    },
}));

const resumeSessionSpy = vi.fn(async (..._args: any[]) => ({ type: 'success' }));
const uploadSpy = vi.fn(async (..._args: any[]) => ({ success: true, path: 'p1', sizeBytes: 1, sha256: 'h1' }));

vi.mock('@/sync/ops', () => ({
    continueSessionWithReplay: vi.fn(),
    sessionAbort: vi.fn(),
    resumeSession: (...args: any[]) => resumeSessionSpy(...args),
    sessionAttachmentsUploadFile: (...args: any[]) => uploadSpy(...args),
}));

vi.mock('@/sync/ops/sessionAttachmentsUpload', () => ({
    sessionAttachmentsUploadFile: (...args: any[]) => uploadSpy(...args),
}));

vi.mock('@/sync/ops/actions/defaultActionExecutor', () => ({
    createDefaultActionExecutor: () => ({ execute: vi.fn() }),
}));

vi.mock('@/components/sessions/agentInput', () => ({
    AgentInput: (props: any) => React.createElement('AgentInput', props),
}));

const modalAlertSpy = vi.fn();
vi.mock('@/modal', () => ({
    Modal: { alert: (...args: any[]) => modalAlertSpy(...args), confirm: vi.fn(), prompt: vi.fn() },
}));

const session: any = {
    id: 's1',
    seq: 0,
    presence: 'offline',
    active: false,
    accessLevel: 'edit',
    metadata: { machineId: 'm1', flavor: 'codex', codexSessionId: 'codex-session-1', version: '0.0.0', path: '/tmp', homeDir: '/tmp' },
    agentState: {},
};

vi.mock('@/sync/domains/state/storage', () => {
    const storage = {
        getState: () => ({
            sessions: { s1: session },
            settings: { sessionMessageSendMode: 'server_pending', sessionBusySteerSendPolicy: 'server_pending' },
            sessionListViewDataByServerId: {},
        }),
        subscribe: () => () => {},
    };
    return {
        storage,
        useSession: () => session,
        useIsDataReady: () => true,
        useRealtimeStatus: () => ({ status: 'connected' }),
        useSessionMessages: () => ({ messages: [], isLoaded: true }),
        useLocalSetting: () => ({}),
        useSessionPendingMessages: () => ({ messages: [] }),
        useSessionReviewCommentsDrafts: () => [],
        useSessionUsage: () => null,
        useSetting: () => null,
        useSettings: () => ({ experiments: true, featureToggles: {} }),
        useAutomations: () => [],
        useMachine: () => null,
        useLocalSettingMutable: () => [false, vi.fn()],
        useSettingMutable: () => [null, vi.fn()],
    };
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
                runtimeGate: null,
                supportsVendorResume: true,
                experimental: true,
            },
            connectedService: { name: 'Provider' },
        }),
        resolveAgentIdFromFlavor: () => 'codex',
        DEFAULT_AGENT_ID: 'codex',
    };
});

vi.mock('@/agents/hooks/useResumeCapabilityOptions', () => ({
    useResumeCapabilityOptions: () => ({ resumeCapabilityOptions: { allowExperimentalResumeByAgentId: { codex: true } } }),
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
vi.mock('@/utils/sessions/sessionUtils', () => ({
    useSessionStatus: () => ({ statusText: '', statusColor: '#000', statusDotColor: '#000' }),
    shouldShowAbortButtonForSessionState: () => false,
    getSessionAvatarId: () => '1',
    getSessionName: () => 'Session',
    listPendingPermissionRequests: () => [],
    formatPathRelativeToHome: () => '',
    getSessionSubtitle: () => '',
}));
vi.mock('@/utils/platform/platform', () => ({
    isRunningOnMac: () => false,
}));
vi.mock('@/utils/system/fireAndForget', () => ({
    fireAndForget: (p: any) => {
        pendingFireAndForget.push(p);
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
    chooseSubmitMode: () => 'server_pending',
}));
vi.mock('@/sync/domains/session/control/localControlSwitch', () => ({
    shouldRenderChatTimelineForSession: () => true,
    shouldRequestRemoteControlAfterPendingEnqueue: () => false,
}));
vi.mock('@/sync/acp/sessionModeControl', () => ({
    supportsAcpAgentModeOverrides: () => false,
}));
vi.mock('@/sync/ops/sessionSwitch', () => ({
    sessionSwitch: vi.fn(),
}));
vi.mock('@/sync/domains/automations/automationSessionLink', () => ({
    countEnabledAutomationsLinkedToSession: () => 0,
}));

describe('SessionView (attachments.uploads resumable send)', () => {
    it('resumes and sends attachments even when chooseSubmitMode selects server_pending', async () => {
        const { SessionView } = await import('./SessionView');

        sendMessageSpy.mockClear();
        resumeSessionSpy.mockClear();
        uploadSpy.mockClear();
        modalAlertSpy.mockClear();
        resolveSessionComposerSendMock.mockClear();
        pendingFireAndForget.length = 0;

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(<SessionView id="s1" />);
        });

        // Ignore mount-time fire-and-forget work; we only care about the send flow.
        pendingFireAndForget.length = 0;

        const agentInput = tree.root.findByType('AgentInput' as any);
        expect(typeof agentInput.props.onAttachmentsAdded).toBe('function');

        await act(async () => {
            agentInput.props.onAttachmentsAdded([
                { name: 'a.txt', size: 1, type: 'text/plain', slice: () => new Blob([new Uint8Array([97])]) } as any,
            ]);
        });

        await act(async () => {
            agentInput.props.onSend();
        });

        expect(pendingFireAndForget.length).toBe(1);
        await pendingFireAndForget[0];

        // Should not show the legacy "attachments require direct sending" error anymore.
        expect(modalAlertSpy.mock.calls.some((c) => String(c?.[1] ?? '').includes('Attachments require direct sending'))).toBe(false);
        expect(resumeSessionSpy).toHaveBeenCalled();
        expect(uploadSpy).toHaveBeenCalled();
        expect(sendMessageSpy).toHaveBeenCalled();
    });
});
