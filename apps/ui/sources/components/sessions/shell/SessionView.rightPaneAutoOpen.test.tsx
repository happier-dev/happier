import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).__DEV__ = false;

const openRightSpy = vi.hoisted(() => vi.fn());
const setRightTabSpy = vi.hoisted(() => vi.fn());

let sessionsRightPaneDefaultOpen = false;
let editorFocusModeEnabled = false;
let rightScopeState: any = null;
let authCredentials: any = { token: 't', secret: 's' };
let uiMultiPanePanelsEnabledSetting: any = true;
let lastUrlSyncEnabled: boolean | null = null;

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
  modal: { border: '#ddd' },
  input: { background: '#f5f5f5' },
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
  useFocusEffect: () => {},
}));

vi.mock('expo-router', () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), setParams: vi.fn() }),
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
vi.mock('@/components/appShell/panes/AppPaneScopeHost', () => ({
  AppPaneScopeHost: (props: any) => React.createElement('AppPaneScopeHost', props, props.main ?? null),
}));
vi.mock('@/components/sessions/panes/useRegisterSessionPaneDriver', () => ({
  useRegisterSessionPaneDriver: () => 'session:s1',
}));
vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
  useAppPaneScope: () => ({
    openRight: openRightSpy,
    setRightTab: setRightTabSpy,
    closeRight: vi.fn(),
    openDetailsTab: vi.fn(),
    closeDetails: vi.fn(),
    pinDetailsTab: vi.fn(),
    closeDetailsTab: vi.fn(),
    setActiveDetailsTab: vi.fn(),
    setRightTabState: vi.fn(),
    scopeState: rightScopeState,
  }),
}));
vi.mock('@/components/sessions/panes/url/useSessionPaneUrlSync', () => ({
  useSessionPaneUrlSync: (input: any) => {
    lastUrlSyncEnabled = Boolean(input?.enabled);
  },
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
  getDeviceType: () => 'tablet',
  useDeviceType: () => 'tablet',
  useHeaderHeight: () => 0,
  useIsLandscape: () => false,
  useIsTablet: () => true,
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
  Modal: { alert: vi.fn(), confirm: vi.fn(), prompt: vi.fn(), show: vi.fn() },
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
      if (key === 'uiMultiPanePanelsEnabled') return uiMultiPanePanelsEnabledSetting;
      if (key === 'editorFocusModeEnabled') return editorFocusModeEnabled;
      if (key === 'detailsPaneTabsBehavior') return 'preview';
      if (key === 'rightPaneWidthPx') return 360;
      if (key === 'rightPaneWidthBasisPx') return 1200;
      if (key === 'detailsPaneWidthPx') return 520;
      if (key === 'detailsPaneWidthBasisPx') return 1200;
      if (key === 'sessionsRightPaneDefaultOpen') return sessionsRightPaneDefaultOpen;
      return null;
    },
    useLocalSettingMutable: () => [null, vi.fn()],
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
  supportsSessionModeOverrides: () => false,
}));
vi.mock('@/sync/domains/session/control/localControlSwitch', () => ({
  shouldRenderChatTimelineForSession: () => true,
  shouldRequestRemoteControlAfterPendingEnqueue: () => false,
}));

vi.mock('@/sync/runtime/time', () => ({
  nowServerMs: () => 0,
}));

vi.mock('@/utils/system/fireAndForget', () => ({
  fireAndForget: () => {},
}));

describe('SessionView (right pane auto-open)', () => {
  beforeEach(() => {
    sessionsRightPaneDefaultOpen = false;
    editorFocusModeEnabled = false;
    rightScopeState = { right: { isOpen: false, activeTabId: null, tabState: {} }, details: { isOpen: false, tabs: [], activeTabKey: null } };
    uiMultiPanePanelsEnabledSetting = true;
    lastUrlSyncEnabled = null;
    openRightSpy.mockClear();
    setRightTabSpy.mockClear();
  });

  it('opens right pane on first visit when sessionsRightPaneDefaultOpen is enabled and no prior tab state exists', async () => {
    sessionsRightPaneDefaultOpen = true;
    const { SessionView } = await import('./SessionView');
    let tree!: renderer.ReactTestRenderer;

    act(() => {
      tree = renderer.create(
        <AppPaneProvider>
          <SessionView id="s1" />
        </AppPaneProvider>
      );
    });
    // Flush effects.
    await act(async () => {});

    expect(openRightSpy).toHaveBeenCalledWith({ tabId: 'files' });
    act(() => {
      tree.unmount();
    });
  }, 60_000);

  it('does not force open right pane when the user previously interacted (activeTabId set)', async () => {
    sessionsRightPaneDefaultOpen = true;
    rightScopeState = { right: { isOpen: false, activeTabId: 'git', tabState: {} }, details: { isOpen: false, tabs: [], activeTabKey: null } };

    const { SessionView } = await import('./SessionView');

    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <AppPaneProvider>
          <SessionView id="s1" />
        </AppPaneProvider>
      );
    });
    await act(async () => {});

    expect(openRightSpy).toHaveBeenCalledTimes(0);
    act(() => {
      tree.unmount();
    });
  }, 60_000);

  it('does not open right pane when the setting is disabled', async () => {
    sessionsRightPaneDefaultOpen = false;
    const { SessionView } = await import('./SessionView');

    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <AppPaneProvider>
          <SessionView id="s1" />
        </AppPaneProvider>
      );
    });
    await act(async () => {});

    expect(openRightSpy).toHaveBeenCalledTimes(0);
    act(() => {
      tree.unmount();
    });
  }, 60_000);

  it('does not blank the main content when editor focus mode is enabled (AppPaneScopeHost handles hiding)', async () => {
    editorFocusModeEnabled = true;
    // Ensure at least one pane is open so focus mode is meaningful.
    rightScopeState = { right: { isOpen: true, activeTabId: 'files', tabState: {} }, details: { isOpen: false, tabs: [], activeTabKey: null } };

    const { SessionView } = await import('./SessionView');

    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <AppPaneProvider>
          <SessionView id="s1" />
        </AppPaneProvider>
      );
    });
    await act(async () => {});

    // Main should still be the normal session content tree (AgentContentView is mocked),
    // not an empty placeholder view.
    expect((tree as any).root.findAllByType('AgentContentView').length).toBeGreaterThan(0);

    act(() => {
      tree.unmount();
    });
  }, 60_000);

  it('keeps URL pane sync enabled when multi-pane setting is unset', async () => {
    uiMultiPanePanelsEnabledSetting = undefined;

    const { SessionView } = await import('./SessionView');

    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <AppPaneProvider>
          <SessionView id="s1" paneUrlState={{ rightTabId: 'git' } as any} />
        </AppPaneProvider>
      );
    });
    await act(async () => {});

    expect(lastUrlSyncEnabled).toBe(true);
    act(() => {
      tree.unmount();
    });
  }, 60_000);
});
