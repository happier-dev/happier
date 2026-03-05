import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).__DEV__ = false;

const headerActionMenuSpy = vi.hoisted(() => vi.fn());

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
  useAuth: () => ({ credentials: { token: 't', secret: 's' } }),
}));
vi.mock('@/text', () => ({
  t: (key: string) => key,
}));

vi.mock('@/components/sessions/transcript/AgentContentView', () => ({
  AgentContentView: () => null,
}));
vi.mock('@/components/appShell/panes/AppPaneScopeHost', () => ({
  AppPaneScopeHost: (props: any) => React.createElement('AppPaneScopeHost', props, props.main ?? null),
}));
vi.mock('@/components/sessions/panes/useRegisterSessionPaneDriver', () => ({
  useRegisterSessionPaneDriver: () => 'pane-scope-test',
}));
vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
  useAppPaneScope: () => ({
    scopeState: null,
    openRight: vi.fn(),
    setRightTab: vi.fn(),
  }),
}));
vi.mock('@/components/sessions/panes/url/useSessionPaneUrlSync', () => ({
  useSessionPaneUrlSync: () => {},
}));
vi.mock('@/components/sessions/transcript/ChatHeaderView', () => ({
  ChatHeaderView: (props: any) => React.createElement('ChatHeaderView', props, props.rightElement ?? null),
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
  SessionHeaderActionMenu: (props: any) => {
    headerActionMenuSpy(props);
    return React.createElement('SessionHeaderActionMenu');
  },
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
vi.mock('@/hooks/server/useAutomationsSupport', () => ({
  useAutomationsSupport: () => ({ enabled: false }),
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
vi.mock('@/sync/sync', () => ({
  sync: {
    markSessionViewed: async () => {},
    fetchPendingMessages: async () => {},
    refreshSessions: async () => {},
    onSessionVisible: () => () => {},
    sendMessage: async () => {},
    enqueuePendingMessage: async () => {},
    submitMessage: async () => {},
    encryption: { getMachineEncryption: () => null },
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

vi.mock('@/sync/domains/state/storage', () => {
  const session: any = {
    id: 's1',
    seq: 1,
    presence: 'online',
    active: true,
    accessLevel: 'edit',
    metadata: { machineId: 'm1', flavor: 'codex', version: '0.0.0', path: '/tmp', homeDir: '/tmp' },
    agentState: {},
  };
  return {
    storage: { getState: () => ({ sessions: { s1: session }, settings: {}, sessionListViewDataByServerId: {} }) },
    useSession: () => session,
    useIsDataReady: () => true,
    useRealtimeStatus: () => ({ current: { status: 'connected' } as any }),
    useSessionMessages: () => ({ messages: [], isLoaded: true }),
    useSessionTranscriptIds: () => ({ ids: [], isLoaded: true }),
    useSessionPendingMessages: () => ({ messages: [] }),
    useSessionReviewCommentsDrafts: () => [],
    useSessionUsage: () => null,
    useLocalSetting: (key: string) => {
      if (key === 'acknowledgedCliVersions') return {};
      if (key === 'uiMultiPanePanelsEnabled') return false;
      if (key === 'detailsPaneTabsBehavior') return 'preview';
      if (key === 'rightPaneWidthPx') return 360;
      if (key === 'rightPaneWidthBasisPx') return 1200;
      if (key === 'detailsPaneWidthPx') return 520;
      if (key === 'detailsPaneWidthBasisPx') return 1200;
      return {};
    },
    useLocalSettingMutable: () => [null, vi.fn()],
    useSetting: () => null,
    useSettings: () => ({ experiments: true, featureToggles: {} }),
    useAutomations: () => [],
  };
});

vi.mock('@/sync/domains/session/control/localControlSwitch', () => ({
  getSwitchToLocalControlDisabledReason: () => null,
  shouldRenderChatTimelineForSession: () => true,
  shouldRequestRemoteControlAfterPendingEnqueue: () => false,
}));

vi.mock('@/sync/domains/input/slashCommands/resolveSessionComposerSend', () => ({
  resolveSessionComposerSend: () => ({ kind: 'send', text: '' }),
}));

vi.mock('@/utils/system/fireAndForget', () => ({
  fireAndForget: (p: any) => p,
}));

describe('SessionView header action menu visibility', () => {
  it('renders SessionHeaderActionMenu even when automations and execution runs are disabled', async () => {
    headerActionMenuSpy.mockClear();
    const { SessionView } = await import('./SessionView');

    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <AppPaneProvider>
          <SessionView id="s1" />
        </AppPaneProvider>
      );
    });

    expect(headerActionMenuSpy).toHaveBeenCalledTimes(1);

    await act(async () => {
      tree!.unmount();
    });
  });
});
