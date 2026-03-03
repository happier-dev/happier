import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).__DEV__ = false;
let authCredentials: any = { token: 't', secret: 's' };

const pendingFireAndForget: Promise<unknown>[] = [];

const resolveSessionComposerSendMock = vi.fn((..._args: any[]) => ({ kind: 'send', text: 'hello' }));

vi.mock('react-native-reanimated', () => ({}));
vi.mock('expo-linear-gradient', () => ({
    LinearGradient: 'LinearGradient',
}));
vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

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

vi.mock('react-native', () => ({
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
        Value: MockAnimatedValue,
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
}));
vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('react-native-unistyles', () => ({
    __esModule: true,
    useUnistyles: () => ({
        theme: {
            dark: false,
            colors: {
                text: '#000',
                textSecondary: '#666',
                textLink: '#00f',
                surface: '#fff',
                surfaceHigh: '#f5f5f5',
                divider: '#ddd',
                input: { background: '#f5f5f5' },
                header: { tint: '#000' },
                modal: { border: '#ddd' },
                status: { error: '#f00' },
                shadow: { color: '#000', opacity: 0.2 },
                groupped: { background: '#F5F5F5', chevron: '#C7C7CC', sectionTitle: '#8E8E93' },
            },
        },
    }),
    StyleSheet: {
        create: (styles: any) =>
            typeof styles === 'function'
                ? styles(
                      {
                          colors: {
                              text: '#000',
                              textSecondary: '#666',
                              textLink: '#00f',
                              surface: '#fff',
                              surfaceHigh: '#f5f5f5',
                              divider: '#ddd',
                              input: { background: '#f5f5f5' },
                              header: { tint: '#000' },
                              modal: { border: '#ddd' },
                              status: { error: '#f00' },
                              shadow: { color: '#000', opacity: 0.2 },
                              groupped: { background: '#F5F5F5', chevron: '#C7C7CC', sectionTitle: '#8E8E93' },
                          },
                      },
                      {}
                  )
                : styles,
        absoluteFillObject: {},
    },
}));

vi.mock('@react-navigation/native', () => ({
    useFocusEffect: () => {},
}));

vi.mock('expo-router', () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn() }),
  usePathname: () => '/',
}));

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ credentials: authCredentials }),
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
    getDeviceType: () => 'phone',
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
vi.mock('@/components/sessions/model/useSessionMachineReachability', () => ({
    useSessionMachineReachability: () => ({ machineReachable: true, machineOnline: true }),
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
            updateSessionProjectScmSnapshotError: () => {},
        }),
        subscribe: () => () => {},
    };
      return {
          storage,
          useSession: () => session,
          useIsDataReady: () => true,
          useRealtimeStatus: () => ({ status: 'connected' }),
          useSessionMessages: () => ({ messages: [], isLoaded: true }),
          useSessionTranscriptIds: () => ({ ids: [], isLoaded: true }),
          useSessionPendingMessages: () => ({ messages: [] }),
          useSessionReviewCommentsDrafts: () => [],
          useSessionUsage: () => null,
          useSetting: () => null,
        useSettings: () => ({ experiments: true, featureToggles: {} }),
        useAutomations: () => [],
        useMachine: () => null,
        useLocalSetting: (key: string) => {
            if (key === 'acknowledgedCliVersions') return {};
            if (key === 'uiMultiPanePanelsEnabled') return false;
            if (key === 'editorFocusModeEnabled') return false;
            if (key === 'detailsPaneTabsBehavior') return 'preview';
            if (key === 'rightPaneWidthPx') return 360;
            if (key === 'rightPaneWidthBasisPx') return 1200;
            if (key === 'detailsPaneWidthPx') return 520;
            if (key === 'detailsPaneWidthBasisPx') return 1200;
            return null;
        },
        useLocalSettingMutable: () => [null, vi.fn()],
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
    fireAndForget: (p: any, opts?: { tag?: string }) => {
        const tag = typeof opts?.tag === 'string' ? opts.tag : '';
        // This test is validating the resumable attachment send flow; ignore unrelated
        // fire-and-forget work (analytics, mount-time prefetch, etc).
        if (tag.startsWith('SessionView.sendMessage')) {
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
    chooseSubmitMode: () => 'server_pending',
}));
vi.mock('@/sync/domains/session/control/localControlSwitch', () => ({
    shouldRenderChatTimelineForSession: () => true,
    shouldRequestRemoteControlAfterPendingEnqueue: () => false,
}));
vi.mock('@/sync/acp/sessionModeControl', () => ({
    supportsSessionModeOverrides: () => false,
}));
vi.mock('@/sync/ops/sessionSwitch', () => ({
    sessionSwitch: vi.fn(),
}));
vi.mock('@/sync/domains/automations/automationSessionLink', () => ({
    countEnabledAutomationsLinkedToSession: () => 0,
}));

describe('SessionView (attachments.uploads resumable send)', () => {
    it('resumes and sends attachments even when chooseSubmitMode selects server_pending', async () => {
        const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
        const { getInactiveSessionUiState } = await import('@/components/sessions/model/inactiveSessionUi');
        expect(getInactiveSessionUiState({ isSessionActive: true, isResumable: true, isMachineOnline: true })).toMatchObject({ shouldShowInput: true });
        const { SessionView } = await import('./SessionView');

        sendMessageSpy.mockClear();
        resumeSessionSpy.mockClear();
        uploadSpy.mockClear();
        modalAlertSpy.mockClear();
        resolveSessionComposerSendMock.mockClear();
        pendingFireAndForget.length = 0;

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <AppPaneProvider>
                    <SessionView id="s1" />
                </AppPaneProvider>
            );
        });

        // Ignore mount-time fire-and-forget work; we only care about the send flow.
        pendingFireAndForget.length = 0;

        const agentInputCandidates = tree.root.findAll(
            (node) => typeof node.props?.onSend === 'function' && typeof node.props?.onAttachmentsAdded === 'function',
        );
        expect(agentInputCandidates.length).toBeGreaterThan(0);
        const agentInput = agentInputCandidates[0]!;
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
        expect(sendMessageSpy).toHaveBeenCalledTimes(1);

        const [sentSessionId, sentText, sentDisplayText, sentMetaOverrides] = sendMessageSpy.mock.calls[0] ?? [];
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
    });
});
