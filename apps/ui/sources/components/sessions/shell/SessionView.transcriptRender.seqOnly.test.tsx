import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).__DEV__ = false;

vi.mock('react-native-reanimated', () => ({}));
vi.mock('expo-linear-gradient', () => ({
  LinearGradient: 'LinearGradient',
}));
vi.mock('@expo/vector-icons', () => ({
  Ionicons: 'Ionicons',
}));
vi.mock('react-native', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    View: 'View',
    Text: 'Text',
    Pressable: 'Pressable',
    ActivityIndicator: 'ActivityIndicator',
    AppState: actual.AppState ?? {
      addEventListener: () => ({ remove: () => {} }),
    },
    Platform: {
      ...actual.Platform,
      OS: 'web',
      select: (spec: Record<string, unknown>) =>
        spec && Object.prototype.hasOwnProperty.call(spec, 'web') ? (spec as any).web : (spec as any).default,
    },
  };
});
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
  AgentContentView: (props: any) =>
    React.createElement(
      'AgentContentView',
      props,
      props.placeholder ?? null,
      props.content ?? null,
      props.input ?? null,
    ),
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
vi.mock('@/components/voice/surface/VoiceSurface', () => ({
  VoiceSurface: () => null,
}));
vi.mock('@/components/sessions/attachments/AttachmentFilePicker', () => ({
  AttachmentFilePicker: () => null,
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
  useFeatureEnabled: () => false,
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
    sendMessage: async () => {},
    enqueuePendingMessage: async () => {},
    submitMessage: async () => {},
    encryption: {
      getMachineEncryption: () => null,
    },
  },
}));

vi.mock('@/sync/ops', () => ({
  continueSessionWithReplay: vi.fn(),
  sessionAbort: vi.fn(),
  resumeSession: vi.fn(),
  sessionAttachmentsUploadFile: vi.fn(),
  sessionSwitch: vi.fn(),
}));

vi.mock('@/sync/ops/actions/defaultActionExecutor', () => ({
  createDefaultActionExecutor: () => ({ execute: vi.fn() }),
}));

vi.mock('@/components/sessions/agentInput', () => ({
  AgentInput: () => null,
}));

vi.mock('@/modal', () => ({
  Modal: { alert: vi.fn(), confirm: vi.fn(), prompt: vi.fn() },
}));

vi.mock('@/utils/system/versionUtils', () => ({
  isVersionSupported: () => true,
  MINIMUM_CLI_VERSION: '0.0.0',
}));

vi.mock('@/agents/catalog/catalog', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    getAgentCore: () => ({ model: { defaultMode: 'default' }, resume: { vendorResumeIdField: null, runtimeGate: null } }),
    resolveAgentIdFromFlavor: () => 'codex',
    DEFAULT_AGENT_ID: 'codex',
  };
});

vi.mock('@/agents/hooks/useResumeCapabilityOptions', () => ({
  useResumeCapabilityOptions: () => ({ resumeCapabilityOptions: {} }),
}));
vi.mock('@/agents/runtime/resumeCapabilities', () => ({
  canResumeSessionWithOptions: () => true,
  getAgentVendorResumeId: () => '',
}));
vi.mock('@/hooks/server/useMachineCapabilitiesCache', () => ({
  prefetchMachineCapabilities: async () => {},
  getMachineCapabilitiesSnapshot: () => null,
  useMachineCapabilitiesCache: () => ({ state: { status: 'idle' } }),
}));

vi.mock('@/utils/sessions/machineUtils', () => ({
  isMachineOnline: () => true,
}));

vi.mock('@/track', () => ({
  tracking: { track: vi.fn() },
  trackMessageSent: vi.fn(),
}));

vi.mock('@/platform/randomUUID', () => ({
  randomUUID: () => 'uuid',
}));

vi.mock('@/sync/domains/state/storage', () => {
  const session: any = {
    id: 's1',
    seq: 25,
    presence: 'online',
    active: true,
    accessLevel: 'edit',
    metadata: { machineId: 'm1', flavor: 'codex', version: '0.0.0', path: '/tmp', homeDir: '/tmp' },
    agentState: {},
  };
  const storage = {
    getState: () => ({
      sessions: { s1: session },
      settings: { sessionMessageSendMode: 'direct', sessionBusySteerSendPolicy: 'steerImmediately' },
      sessionListViewDataByServerId: {},
    }),
  };
  return {
    storage,
    useSession: () => session,
    useIsDataReady: () => true,
    useRealtimeStatus: () => ({ status: 'connected' }),
    useSessionMessages: () => ({ messages: [], isLoaded: true }),
    useSessionPendingMessages: () => ({ messages: [] }),
    useSessionReviewCommentsDrafts: () => [],
    useSessionUsage: () => null,
    useLocalSetting: () => ({}),
    useSetting: () => null,
    useSettings: () => ({ experiments: true, featureToggles: {} }),
    useAutomations: () => [],
    useMachine: () => null,
  };
});

vi.mock('@/hooks/server/useAutomationsSupport', () => ({
  useAutomationsSupport: () => ({ enabled: false }),
}));

vi.mock('@/scm/scmStatusSync', () => ({
  scmStatusSync: { run: async () => {}, invalidateFromAutoRefresh: () => {} },
}));

vi.mock('@/sync/ops/actions/sessionActionExecutor', () => ({
  createSessionActionExecutor: () => ({ execute: vi.fn() }),
}));

vi.mock('@/sync/domains/input/slashCommands/resolveSessionComposerSend', () => ({
  resolveSessionComposerSend: () => ({ kind: 'send', text: '' }),
}));

vi.mock('@/sync/domains/permissions/permissionModeApply', () => ({
  applyPermissionModeSelection: async () => {},
}));

vi.mock('@/sync/acp/sessionModeControl', () => ({
  supportsAcpAgentModeOverrides: () => false,
}));

vi.mock('@/sync/runtime/time', () => ({
  nowServerMs: () => 0,
}));

vi.mock('@/utils/system/fireAndForget', () => ({
  fireAndForget: (p: any) => p,
}));

describe('SessionView (transcript rendering for seq-only sessions)', () => {
  it('renders ChatList when session.seq > 0 even if visible committed messages are empty', async () => {
    const { SessionView } = await import('./SessionView');
    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<SessionView id="s1" />);
    });

    expect(tree!.root.findAllByType('ChatList')).toHaveLength(1);
    expect(tree!.root.findAllByType('EmptyMessages')).toHaveLength(0);

    await act(async () => {
      tree!.unmount();
    });
  });
});
