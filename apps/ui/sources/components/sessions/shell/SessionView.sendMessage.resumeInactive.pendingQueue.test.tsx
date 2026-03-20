import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import type { ResumeSessionResult } from '@/sync/ops/sessions';
import { emitSessionResumeRequest } from '@/components/sessions/model/sessionResumeRequests';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const previousDev = (globalThis as { __DEV__?: boolean }).__DEV__;
(globalThis as { __DEV__?: boolean }).__DEV__ = false;

let authCredentials: any = { token: 't', secret: 's' };

const pendingFireAndForget: Promise<unknown>[] = [];
const mountedTrees: renderer.ReactTestRenderer[] = [];

const enqueuePendingMessageSpy = vi.hoisted(() => vi.fn(async (..._args: any[]) => {}));
const resumeSessionSpy = vi.hoisted(() =>
  vi.fn<(..._args: any[]) => Promise<ResumeSessionResult>>(async (..._args: any[]) => ({
    type: 'error' as const,
    errorCode: 'DAEMON_RPC_UNAVAILABLE' as const,
    errorMessage: 'Daemon RPC is not available',
  })),
);
const continueSessionWithReplaySpy = vi.hoisted(() =>
  vi.fn(async (..._args: any[]) => ({
    type: 'success' as const,
    sessionId: 's2',
  })),
);
const canResumeSessionWithOptionsSpy = vi.hoisted(() =>
  vi.fn((_metadata: unknown, options: { machineId?: string | null } | null | undefined) => options?.machineId === 'm-target'),
);
const resumeCapabilityMachineIds = vi.hoisted(() => [] as string[]);
const modalAlertSpy = vi.hoisted(() => vi.fn());
const modalConfirmSpy = vi.hoisted(() =>
  vi.fn(async (_title?: string, _message?: string, _options?: Record<string, unknown>) => true),
);
const settingsState = vi.hoisted(() => ({
  current: { experiments: true, featureToggles: {}, codexBackendMode: 'acp' } as Record<string, unknown>,
}));

const resolveSessionComposerSendMock = vi.hoisted(() =>
  vi.fn((...args: any[]) => {
    const first = args[0] as { input?: unknown } | undefined;
    return { kind: 'send' as const, text: String(first?.input ?? '') };
  }),
);

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
  Easing: {
    bezier: vi.fn(() => ({})),
    linear: {},
  },
  Animated: {
    View: 'Animated.View',
    Value: class {
      private _v: number;
      constructor(v: number) {
        this._v = v;
      }
      interpolate() {
        return this;
      }
    },
    timing: () => ({
      start: (cb?: any) => cb?.({ finished: true }),
    }),
  },
  AccessibilityInfo: {
    isReduceMotionEnabled: vi.fn(async () => false),
    addEventListener: vi.fn(() => ({ remove: vi.fn() })),
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
        radio: { active: '#007AFF' },
        shadow: { color: '#000', opacity: 0.2 },
        box: {
          warning: {
            background: '#fffbe6',
            border: '#ffe58f',
            text: '#8c6d1f',
          },
        },
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
                radio: { active: '#007AFF' },
                shadow: { color: '#000', opacity: 0.2 },
                box: {
                  warning: {
                    background: '#fffbe6',
                    border: '#ffe58f',
                    text: '#8c6d1f',
                  },
                },
                groupped: { background: '#F5F5F5', chevron: '#C7C7CC', sectionTitle: '#8E8E93' },
              },
            },
            {},
          )
        : styles,
    absoluteFillObject: {},
  },
}));

vi.mock('@react-navigation/native', () => ({
  useFocusEffect: () => {},
  useIsFocused: () => true,
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
vi.mock('@/components/sessions/agentInput', () => ({
  AgentInput: (props: any) => React.createElement('AgentInput', props),
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
  useFeatureEnabled: () => false,
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
  useSessionMachineReachability: () => ({ machineReachable: true, machineOnline: true, machineRpcTargetAvailable: true }),
}));
vi.mock('@/sync/domains/server/serverRuntime', () => ({
  getActiveServerSnapshot: () => ({ serverId: 'server-1' }),
  subscribeActiveServer: (listener: any) => {
    listener({ serverId: 'server-1' });
    return () => {};
  },
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
    enqueuePendingMessage: (...args: any[]) => enqueuePendingMessageSpy(...args),
    submitMessage: async () => {},
    encryption: {
      getMachineEncryption: () => null,
    },
  },
}));
vi.mock('@/sync/ops', () => ({
  continueSessionWithReplay: (...args: any[]) => continueSessionWithReplaySpy(...args),
  sessionAbort: vi.fn(),
  resumeSession: (...args: any[]) => resumeSessionSpy(...args),
  sessionAttachmentsUploadFile: vi.fn(),
}));
vi.mock('@/sync/ops/actions/defaultActionExecutor', () => ({
  createDefaultActionExecutor: () => ({ execute: vi.fn() }),
}));
vi.mock('@/agents/hooks/useResumeCapabilityOptions', () => ({
  useResumeCapabilityOptions: (input: { machineId?: string | null }) => {
    resumeCapabilityMachineIds.push(typeof input?.machineId === 'string' ? input.machineId : '');
    return {
      resumeCapabilityOptions: {
        machineId: typeof input?.machineId === 'string' ? input.machineId : null,
      },
    };
  },
}));
vi.mock('@/agents/runtime/resumeCapabilities', () => ({
  canResumeSessionWithOptions: (metadata: unknown, options: { machineId?: string | null } | null | undefined) =>
    canResumeSessionWithOptionsSpy(metadata, options),
  getAgentVendorResumeId: () => null,
}));

vi.mock('@/sync/domains/input/slashCommands/resolveSessionComposerSend', () => ({
  resolveSessionComposerSend: (...args: any[]) => resolveSessionComposerSendMock(...args),
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
vi.mock('@/capabilities/ensureAgentInstallablesBackground', () => ({
  ensureAgentInstallablesBackground: async () => {},
}));
vi.mock('@/utils/system/fireAndForget', () => ({
  fireAndForget: (p: any) => {
    pendingFireAndForget.push(p);
    return p;
  },
}));
vi.mock('@/utils/timing/runAfterInteractionsWithFallback', () => ({
  runAfterInteractionsWithFallback: () => () => {},
}));
vi.mock('@/modal', () => ({
  Modal: {
    alert: (...args: any[]) => modalAlertSpy(...args),
    confirm: (title: string, message: string, options?: Record<string, unknown>) =>
      modalConfirmSpy(title, message, options),
    prompt: vi.fn(),
  },
}));

vi.mock('@/sync/domains/state/storage', () => {
  const session: any = {
    id: 's1',
    seq: 0,
    presence: Date.now() - 60_000,
    active: false,
    accessLevel: 'edit',
    pendingVersion: 2,
    metadata: {
      machineId: 'm-stale',
      flavor: 'codex',
      version: '0.0.0',
      path: '/tmp/target',
      homeDir: '/tmp',
      codexSessionId: 'codex-session-1',
    },
    agentState: {},
  };
  const storage = {
    getState: () => ({
      sessions: { s1: session },
      machines: {
        'm-target': {
          id: 'm-target',
          active: true,
          activeAt: 10,
          metadata: { host: 'workstation.local' },
        },
      },
      getProjectForSession: (sessionId: string) =>
        sessionId === 's1'
          ? {
              key: {
                machineId: 'm-target',
                path: '/tmp/target',
              },
            }
          : null,
      settings: {
        sessionMessageSendMode: 'direct',
        sessionBusySteerSendPolicy: 'steerImmediately',
        codexBackendMode: 'acp',
      },
      sessionListViewDataByServerId: {},
    }),
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
    useSettings: () => settingsState.current,
    useAutomations: () => [],
    useMachine: () => null,
  };
});

describe('SessionView (sendMessage resumeInactive pendingQueue)', () => {
  afterEach(() => {
    (globalThis as { __DEV__?: boolean }).__DEV__ = previousDev;
    while (mountedTrees.length > 0) {
      const tree = mountedTrees.pop();
      if (!tree) continue;
      act(() => {
        tree.unmount();
      });
    }
  });

  it('shows a non-blocking warning (no modal) when resume fails after enqueueing a pending message', async () => {
    enqueuePendingMessageSpy.mockClear();
    resumeCapabilityMachineIds.length = 0;
    settingsState.current = { experiments: true, featureToggles: {}, codexBackendMode: 'acp' };
    canResumeSessionWithOptionsSpy.mockImplementation((_metadata: unknown, options: { machineId?: string | null } | null | undefined) => options?.machineId === 'm-target');
    resumeSessionSpy
      .mockClear()
      .mockImplementation(async () => ({
        type: 'error' as const,
        errorCode: 'DAEMON_RPC_UNAVAILABLE' as const,
        errorMessage: 'Daemon RPC is not available',
      }));
    modalAlertSpy.mockClear();
    resolveSessionComposerSendMock.mockClear();
    pendingFireAndForget.length = 0;

    const { SessionView } = await import('./SessionView');

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <AppPaneProvider>
          <SessionView id="s1" />
        </AppPaneProvider>,
      );
    });
    mountedTrees.push(tree);

    // Ignore mount-time fire-and-forget work.
    pendingFireAndForget.length = 0;

    const agentInputCandidates = tree.root.findAll((node) => typeof node.props?.onSend === 'function' && typeof node.props?.onChangeText === 'function');
    expect(agentInputCandidates.length).toBeGreaterThan(0);
    const agentInput = agentInputCandidates[0]!;

    await act(async () => {
      agentInput.props.onChangeText('hello');
    });
    await act(async () => {
      agentInput.props.onSend();
    });

    expect(pendingFireAndForget.length).toBeGreaterThan(0);
    await act(async () => {
      await pendingFireAndForget[0];
    });

    expect(enqueuePendingMessageSpy).toHaveBeenCalledTimes(1);
    expect(enqueuePendingMessageSpy.mock.calls[0]?.[0]).toBe('s1');
    expect(enqueuePendingMessageSpy.mock.calls[0]?.[1]).toBe('hello');
    expect(resumeCapabilityMachineIds).toContain('m-target');

    expect(resumeSessionSpy).toHaveBeenCalledTimes(1);
    expect(resumeSessionSpy).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'm-target',
      directory: '/tmp/target',
    }));
    expect(modalAlertSpy).not.toHaveBeenCalled();

    const updatedAgentInput = tree.root.findAll((node) => typeof node.props?.onSend === 'function' && typeof node.props?.onChangeText === 'function')[0]!;
    expect(updatedAgentInput.props.value).toBe('');

    const banner = tree.root.findByProps({ testID: 'session-pendingQueue-resumeFailed' });
    expect(banner).toBeTruthy();
  });

  it('retries resume from the warning banner and clears it on success', async () => {
    enqueuePendingMessageSpy.mockClear();
    resumeCapabilityMachineIds.length = 0;
    settingsState.current = { experiments: true, featureToggles: {}, codexBackendMode: 'acp' };
    canResumeSessionWithOptionsSpy.mockImplementation((_metadata: unknown, options: { machineId?: string | null } | null | undefined) => options?.machineId === 'm-target');
    resumeSessionSpy
      .mockClear()
      .mockImplementationOnce(async () => ({
        type: 'error' as const,
        errorCode: 'DAEMON_RPC_UNAVAILABLE' as const,
        errorMessage: 'Daemon RPC is not available',
      }))
      .mockImplementationOnce(async () => ({ type: 'success' as const }));
    modalAlertSpy.mockClear();
    resolveSessionComposerSendMock.mockClear();
    pendingFireAndForget.length = 0;

    const { SessionView } = await import('./SessionView');

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <AppPaneProvider>
          <SessionView id="s1" />
        </AppPaneProvider>,
      );
    });
    mountedTrees.push(tree);

    // Ignore mount-time fire-and-forget work.
    pendingFireAndForget.length = 0;

    const agentInputCandidates = tree.root.findAll((node) => typeof node.props?.onSend === 'function' && typeof node.props?.onChangeText === 'function');
    expect(agentInputCandidates.length).toBeGreaterThan(0);
    const agentInput = agentInputCandidates[0]!;

    await act(async () => {
      agentInput.props.onChangeText('hello');
    });
    await act(async () => {
      agentInput.props.onSend();
    });

    expect(pendingFireAndForget.length).toBeGreaterThan(0);
    await act(async () => {
      await pendingFireAndForget[0];
    });

    expect(resumeSessionSpy).toHaveBeenCalledTimes(1);
    expect(resumeCapabilityMachineIds).toContain('m-target');
    expect(modalAlertSpy).not.toHaveBeenCalled();

    const retryButton = tree.root.findByProps({ testID: 'session-pendingQueue-resumeFailed-retry' });
    await act(async () => {
      await retryButton.props.onPress();
    });

    expect(resumeSessionSpy).toHaveBeenCalledTimes(2);
    expect(modalAlertSpy).not.toHaveBeenCalled();

    const remainingBanners = tree.root.findAllByProps({ testID: 'session-pendingQueue-resumeFailed' });
    expect(remainingBanners.length).toBe(0);
  });

  it('shows a retry error when the user explicitly retries resume from the banner', async () => {
    enqueuePendingMessageSpy.mockClear();
    resumeCapabilityMachineIds.length = 0;
    settingsState.current = { experiments: true, featureToggles: {}, codexBackendMode: 'acp' };
    canResumeSessionWithOptionsSpy.mockImplementation((_metadata: unknown, options: { machineId?: string | null } | null | undefined) => options?.machineId === 'm-target');
    resumeSessionSpy
      .mockClear()
      .mockImplementation(async () => ({
        type: 'error' as const,
        errorCode: 'DAEMON_RPC_UNAVAILABLE' as const,
        errorMessage: 'Daemon RPC is not available',
      }));
    modalAlertSpy.mockClear();
    resolveSessionComposerSendMock.mockClear();
    pendingFireAndForget.length = 0;

    const { SessionView } = await import('./SessionView');

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <AppPaneProvider>
          <SessionView id="s1" />
        </AppPaneProvider>,
      );
    });
    mountedTrees.push(tree);

    pendingFireAndForget.length = 0;

    const agentInput = tree.root.findAll((node) => typeof node.props?.onSend === 'function' && typeof node.props?.onChangeText === 'function')[0]!;

    await act(async () => {
      agentInput.props.onChangeText('hello');
    });
    await act(async () => {
      agentInput.props.onSend();
    });

    await act(async () => {
      await pendingFireAndForget[0];
    });

    expect(resumeCapabilityMachineIds).toContain('m-target');

    modalAlertSpy.mockClear();

    const retryButton = tree.root.findByProps({ testID: 'session-pendingQueue-resumeFailed-retry' });
    await act(async () => {
      await retryButton.props.onPress();
    });

    expect(modalAlertSpy).toHaveBeenCalledWith('common.error', 'Daemon RPC is not available');
  });

  it('uses the reachable machine target for replay resume when direct resume is unavailable', async () => {
    resumeCapabilityMachineIds.length = 0;
    settingsState.current = {
      experiments: true,
      featureToggles: {},
      codexBackendMode: 'acp',
      sessionReplayEnabled: true,
      sessionReplayStrategy: 'recent_messages',
      sessionReplayRecentMessagesCount: 100,
      sessionReplayMaxSeedChars: 120000,
      sessionReplaySummaryRunnerV1: null,
    };
    canResumeSessionWithOptionsSpy.mockReturnValue(false);
    continueSessionWithReplaySpy.mockClear().mockResolvedValue({
      type: 'success',
      sessionId: 's-replayed',
    });
    modalConfirmSpy.mockClear().mockResolvedValue(true);
    modalAlertSpy.mockClear();

    const { SessionView } = await import('./SessionView');

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <AppPaneProvider>
          <SessionView id="s1" />
        </AppPaneProvider>,
      );
    });
    mountedTrees.push(tree);

    await act(async () => {
      emitSessionResumeRequest('s1');
      await Promise.resolve();
    });

    expect(resumeCapabilityMachineIds).toContain('m-target');
    expect(modalConfirmSpy).toHaveBeenCalledTimes(1);
    expect(continueSessionWithReplaySpy).toHaveBeenCalledTimes(1);
    expect(continueSessionWithReplaySpy).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'm-target',
      directory: '/tmp/target',
    }));
    expect(modalAlertSpy).not.toHaveBeenCalled();
  });
});
