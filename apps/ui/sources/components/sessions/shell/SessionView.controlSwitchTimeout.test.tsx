import 'fake-indexeddb/auto';
import * as React from 'react';
import { createReactNavigationNativeMock } from '@/dev/testkit/mocks/reactNavigation';
import { act } from 'react-test-renderer';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { DaemonContributionRegistryProjectionDescribeResponseSchema} from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { SESSION_RUNNER_RUNTIME_METADATA_KEY } from '@happier-dev/protocol/sessions/control/sessionRunnerRuntimeV1';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { RpcError, RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';

import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createMachineFixture, createPlainMachineRowFixture, createReadyMachineAgentInventoryFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { SessionRunnerRuntimeStatusV2Schema } from '@happier-dev/protocol/sessions/control/sessionRunnerRuntimeV2';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { sessionRunnerRuntimeStatusRetention } from '@/sync/domains/sessionRunnerRuntime/sessionRunnerRuntimeStatusRetention';
import { createSessionMessagesFixture } from '@/dev/testkit/fixtures/transcriptFixtures';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('socket.io-client', async (importOriginal) => (
  (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal)
));

const previousDev = (globalThis as { __DEV__?: boolean }).__DEV__;
const controlSwitchTimeoutMs = 25;

const switchReply = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => true));
const modalAlertSpy = vi.hoisted(() => vi.fn());
const chatListPropsSpy = vi.hoisted(() => vi.fn());
const agentInputPropsSpy = vi.hoisted(() => vi.fn());
const warningActionBannerPropsSpy = vi.hoisted(() => vi.fn());
const sessionUsageLimitWaitResumeEnableSpy = vi.hoisted(() => vi.fn());
const runnerRestartReply = vi.hoisted(() => vi.fn());
const runnerStatusReply = vi.hoisted(() =>
  vi.fn<(request?: unknown) => Promise<unknown | null>>(async () => null),
);
const cliDetectionState = vi.hoisted(() => ({
  authStatus: {} as Record<string, { state: 'logged_in' | 'logged_out' | 'unknown'; checkedAt: number } | null>,
}));
const featureGateState = vi.hoisted(() => {
  const enabledFeatureIds = new Set<string>();
  const useFeatureEnabledSpy = vi.fn((featureId: string, scope?: { serverId?: string | null }) => {
    const scopedKey = typeof scope?.serverId === 'string' && scope.serverId.trim().length > 0
      ? `${scope.serverId.trim()}:${featureId}`
      : null;
    return Boolean((scopedKey && enabledFeatureIds.has(scopedKey)) || enabledFeatureIds.has(featureId));
  });
  return { enabledFeatureIds, useFeatureEnabledSpy };
});
const enabledFeatureIds = featureGateState.enabledFeatureIds;
const useFeatureEnabledSpy = featureGateState.useFeatureEnabledSpy;
const sessionState = vi.hoisted(() => ({
  session: {
    id: 's1',
    metadata: null,
    accessLevel: 'edit',
    canApprovePermissions: true,
    agentState: { controlledByUser: true },
  } as any,
}));

vi.mock('expo-linear-gradient', () => ({
  LinearGradient: 'LinearGradient',
}));
vi.mock('@expo/vector-icons', () => ({
  Ionicons: 'Ionicons',
  Octicons: 'Octicons',
}));
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
  radio: { active: '#007AFF' },
  header: { tint: '#000' },
  status: { error: '#f00' },
  shadow: { color: '#000', opacity: 0.2 },
  groupped: { background: '#F5F5F5', chevron: '#C7C7CC', sectionTitle: '#8E8E93' },
  box: {
    warning: { background: '#fff4cc', border: '#f0d98a', text: '#000' },
  },
};

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
      View: 'View',
      Text: 'Text',
      Pressable: 'Pressable',
      ActivityIndicator: 'ActivityIndicator',
      useWindowDimensions: () => ({ width: 1200, height: 800 }),
    });
  });
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
      theme: themeColors,
    });
  });
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return (await import('@/dev/testkit/mocks/text')).createTextModuleMock({
      translate: (key: string) => key,
    });
});
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    const modalMock = createModalModuleMock();
    modalMock.spies.alert.mockImplementation((...args) => modalAlertSpy(...args));
    return modalMock.module;
  });
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});

vi.mock('@react-navigation/native', () => ({
    ...createReactNavigationNativeMock(),
  useFocusEffect: () => {},
  useIsFocused: () => true,
}));


vi.mock('@/components/sessions/transcript/AgentContentView', () => ({
  AgentContentView: (props: any) =>
    React.createElement(
      'AgentContentView',
      props,
      React.createElement(React.Fragment, null, props.content ?? null, props.input ?? null),
    ),
}));
vi.mock('@/components/appShell/panes/AppPaneScopeHost', () => ({
  AppPaneScopeHost: (props: any) => React.createElement('AppPaneScopeHost', props, props.main ?? null),
}));
vi.mock('@/components/sessions/panes/useRegisterSessionPaneDriver', () => ({
  useRegisterSessionPaneDriver: () => 'session:s1',
}));
vi.mock('@/components/sessions/panes/url/useSessionPaneUrlSync', () => ({
  useSessionPaneUrlSync: () => {},
}));
vi.mock('@/components/sessions/shell/view/SessionPaneHeader', () => ({
  SessionPaneHeader: () => null,
}));
// The Session's control banner stands in the composer seat (owner 2026-11-11); its props are the control contract.
const sessionChatFooterPropsSpy = vi.hoisted(() => vi.fn());
vi.mock('@/components/sessions/transcript/ChatFooter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/sessions/transcript/ChatFooter')>();
  const React = await import('react');
  return {
    ...actual,
    SessionChatFooter: (props: React.ComponentProps<typeof actual.SessionChatFooter>) => {
      sessionChatFooterPropsSpy(props);
      return React.createElement(actual.SessionChatFooter, props);
    },
  };
});
vi.mock('@/components/sessions/transcript/ChatList', () => ({
  ChatList: (props: any) => {
    chatListPropsSpy(props);
    return React.createElement('ChatList', { ...props, testID: 'transcript-chat-list' });
  },
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
  useFeatureEnabled: useFeatureEnabledSpy,
}));
vi.mock('@/utils/platform/responsive', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/utils/platform/responsive')>(),
  getDeviceType: () => 'tablet',
  useDeviceType: () => 'tablet',
  useHeaderHeight: () => 0,
  useIsLandscape: () => false,
  useIsTablet: () => true,
}));
vi.mock('@/components/sessions/model/inactiveSessionUi', () => ({
  getInactiveSessionUiState: () => ({ noticeKind: 'none', inactiveStatusTextKey: null, shouldShowInput: true }),
}));
vi.mock('@/voice/session/voiceSession', () => ({
  useVoiceSessionSnapshot: () => ({ status: 'disconnected' }),
  voiceSessionManager: {},
}));

vi.mock('@/components/sessions/agentInput', () => ({
  AgentInput: (props: any) => {
    agentInputPropsSpy(props);
    return null;
  },
}));
vi.mock('./view/WarningActionBanner', () => ({
  WarningActionBanner: (props: any) => {
    warningActionBannerPropsSpy(props);
    return React.createElement('WarningActionBanner', props);
  },
}));

vi.mock('@/sync/domains/session/control/localControlSwitch', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
  };
});

vi.doUnmock('@/sync/domains/state/storage');
vi.doUnmock('@/hooks/session/useDraft');
vi.doUnmock('@/agents/registry/registryUiBehavior');
const { storage: shellStorage } = await import('@/sync/domains/state/storage');
const sessionSwitchSpy = vi.spyOn(await import('@/sync/ops'), 'sessionSwitch');
const runnerOperations = await import('@/sync/ops/sessionRunnerRestart');
const sessionRunnerStatusGetSpy = vi.spyOn(runnerOperations, 'getSessionRunnerRuntimeStatusSnapshot');
const sessionRunnerRestartSpy = vi.spyOn(runnerOperations, 'restartSessionRunnerOnCurrentRuntime');
const { installSessionPaneRuntimeTestHarness } = await import('../panes/sessionPaneRuntimeTestHarness');
const runtime = installSessionPaneRuntimeTestHarness({
  request: async (url, init) => {
    const path = new URL(String(url)).pathname;
    if ((init?.method ?? 'GET') !== 'GET' || !['/v1/machines', '/v1/machines/m1'].includes(path)) return null;
    const machine = createPlainMachineRowFixture({ id: 'm1', accountId: 'account-a' });
    return Response.json(path === '/v1/machines' ? [machine] : { machine });
  },
  rpc: async (method, _input, _targetId) => {
    if (method === SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_WAIT_RESUME_ENABLE) return await sessionUsageLimitWaitResumeEnableSpy(_input);
    if (method === 'switch') return await switchReply(_input);
    if (method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) {
      const inventory = createReadyMachineAgentInventoryFixture([{ agentId: 'claude', title: 'Claude' }]);
      return DaemonContributionRegistryProjectionDescribeResponseSchema.parse({ protocolVersion: 1, projection: inventory.projection });
    }
    if (method === RPC_METHODS.CAPABILITIES_DETECT) {
      const inventory = createReadyMachineAgentInventoryFixture([{ agentId: 'claude', title: 'Claude' }]);
      const probe = inventory.capabilities.results['cli.claude'];
      if (!probe?.ok) throw new Error('Expected a successful native CLI probe fixture');
      const authStatus = cliDetectionState.authStatus.claude;
      return { ...inventory.capabilities, results: { ...inventory.capabilities.results, 'cli.claude': {
        ...probe, data: { ...probe.data, isLoggedIn: authStatus?.state === 'logged_in', authStatus,
          signIn: { status: authStatus?.state === 'logged_out' ? 'signedOut' : 'signedIn', loginSupport: 'status_only' } },
      } } };
    }
    if (method === RPC_METHODS.DAEMON_SESSION_RUNNER_STATUS_V2_GET) {
      const state = await runnerStatusReply();
      if (!state) throw new RpcError('Runner status unavailable', RPC_ERROR_CODES.METHOD_NOT_AVAILABLE);
      return SessionRunnerRuntimeStatusV2Schema.parse({ v: 2, state, runnerProcessIdentity: null });
    }
    if (method === RPC_METHODS.DAEMON_SESSION_RUNNER_STATUS_GET) return await runnerStatusReply();
    if (method === RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART) {
      const result = await runnerRestartReply();
      if (result?.ok) runnerStatusReply.mockResolvedValue(null);
      return result;
    }
    throw new RpcError('Daemon method unavailable', RPC_ERROR_CODES.METHOD_NOT_AVAILABLE);
  },
});

// Keep cold real-UI graph loading in collection after the Socket/Account ports.
await (await import('@/dev/testkit/harness/syncSingletonLoader')).loadSyncSingletonForTests();
(globalThis as { __DEV__?: boolean }).__DEV__ = false;
const { SessionView } = await import('./SessionView');
(globalThis as { __DEV__?: boolean }).__DEV__ = previousDev;

describe('SessionView (control switch timeout)', () => {
  const AppPaneProviderWrapper = runtime.Wrapper;

  function resetSession(overrides: Partial<ReturnType<typeof createSessionFixture>> = {}) {
    Object.assign(sessionState.session, createSessionFixture({
      id: 's1',
      serverId: runtime.serverId,
      active: true,
      metadata: { path: '/tmp', homeDir: '/tmp', host: 'test-home', machineId: 'm1', flavor: 'claude' },
      canApprovePermissions: true,
      agentState: { controlledByUser: true },
      ...overrides,
    }));
  }

  async function renderSessionView(options: Readonly<{ routeServerId?: string | null }> = {}) {
    const metadata = sessionState.session.metadata;
    if (metadata) sessionState.session.metadata = { path: '/tmp', homeDir: '/tmp', host: 'test-home', ...metadata };
    shellStorage.setState({
      isDataReady: true,
      settings: { ...settingsDefaults, experiments: true },
      localSettings: { ...shellStorage.getState().localSettings, uiMultiPanePanelsEnabled: true },
      sessionMessages: { s1: createSessionMessagesFixture({ messageIdsOldestFirst: ['m1'], isLoaded: true }) },
    });
    shellStorage.getState().applySessions([sessionState.session]);
    const serverId = sessionState.session.serverId;
    if (serverId !== runtime.serverId) {
      const { upsertServerProfile } = await import('@/sync/domains/server/serverProfiles');
      const { TokenStorage } = await import('@/auth/storage/tokenStorage');
      const serverUrl = `https://${serverId}`;
      await upsertServerProfile({ serverUrl, name: serverId });
      await TokenStorage.setCredentialsForServerUrl(serverUrl, { serverId }, runtime.credentials);
    }
    shellStorage.getState().applyMachines([createMachineFixture({
      id: metadata?.machineId ?? 'm1', active: true, activeAt: Date.now(),
    })], true, { sourceServerId: serverId });
    if (serverId === runtime.serverId) {
      const { sync } = await import('@/sync/sync');
      expect((await sync.ensureSessionVisibleForMessageRoute('s1', {
        serverId, forceRefresh: true, hydrateMessages: false,
      })).kind).toBe('available');
      const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
      const lifetime = captureActiveServerAccountScopeLifetime();
      if (!lifetime) throw new Error('Expected the restored Account lifetime');
      const { refreshMachineAgents } = await import('@/agents/machineAgents/useMachineAgents');
      await refreshMachineAgents({ serverId, machineId: metadata?.machineId ?? 'm1', accountLifetime: lifetime, agentId: 'claude', force: true });
    }
    return renderScreen(
      <SessionView id="s1" routeServerId={options.routeServerId} />,
      {
        wrapper: AppPaneProviderWrapper,
      },
    );
  }

  function getChatListProps() {
    // The control-switch contract is the Session control banner's (composer seat), no longer the transcript's.
    const calls = sessionChatFooterPropsSpy.mock.calls;
    const footerProps = calls[calls.length - 1]?.[0];
    if (!footerProps) {
      throw new Error('Expected SessionChatFooter props to be captured');
    }
    return footerProps;
  }

  function getAgentInputProps() {
    const calls = agentInputPropsSpy.mock.calls;
    const props = calls[calls.length - 1]?.[0];
    if (!props) {
      throw new Error('Expected AgentInput props to be captured');
    }
    return props;
  }

  function getWarningActionBannerProps() {
    const calls = warningActionBannerPropsSpy.mock.calls;
    const props = calls[calls.length - 1]?.[0];
    if (!props) {
      throw new Error('Expected WarningActionBanner props to be captured');
    }
    return props;
  }

  function getWarningActionBannerPropsByTestId(testID: string) {
    const props = warningActionBannerPropsSpy.mock.calls
      .map((call) => call[0])
      .filter((candidate: { testID?: string }) => candidate?.testID === testID).at(-1);
    if (!props) {
      throw new Error(`Expected WarningActionBanner props for ${testID}`);
    }
    return props;
  }

  function findStatusBadge(key: string) {
    return getAgentInputProps().statusBadges?.find((item: { key?: string }) => item.key === key);
  }

  function getBannerHideAction(testID: string) {
    const action = getWarningActionBannerPropsByTestId(testID).secondaryActions
      ?.find((candidate: { testID?: string }) => candidate.testID === `${testID}-hide`);
    if (!action) {
      throw new Error(`Expected a Hide action on ${testID}`);
    }
    return action;
  }

  function getUsageLimitStatusBadge() {
    const badge = getAgentInputProps().statusBadges?.find((item: { key?: string }) => item.key === 'usage-limit-recovery');
    if (!badge) {
      throw new Error('Expected usage-limit status badge');
    }
    return badge;
  }

  function getStaleRunnerStatusBadge() {
    const badge = getAgentInputProps().statusBadges?.find((item: { key?: string }) => item.key === 'stale-session-runner');
    if (!badge) {
      throw new Error('Expected stale runner status badge');
    }
    return badge;
  }

  function buildStaleRunnerMetadata() {
    return {
      path: '/repo',
      host: 'host-1',
      machineId: 'm1',
      [SESSION_RUNNER_RUNTIME_METADATA_KEY]: {
        v: 1,
        sessionId: 's1',
        machineId: 'm1',
        daemonId: 'd1',
        observedAtMs: 1_700_000_000_000,
        runner: {
          pid: 123,
          runtimeId: 'runner-runtime-old',
          cliVersion: '1.0.0',
          entrypointVersion: 'entry-old',
          processCommandHash: 'hash-old',
          entrypointSource: 'process_command',
          startedBy: 'daemon',
          startingMode: 'remote',
        },
        daemon: {
          cliVersion: '1.1.0',
          startedWithCliVersion: '1.1.0',
          currentEntrypointVersion: 'runner-runtime-new',
          currentEntrypointSource: 'packaged_runtime',
        },
        versionState: 'stale',
        statusSource: 'daemon_tracking',
        plannedRestart: {
          supported: true,
          eligible: true,
          disabledReason: null,
        },
      },
    };
  }

  async function waitForControlSwitchTimeout() {
    await act(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, controlSwitchTimeoutMs + 25);
      });
    });
  }

  beforeEach(() => {
    sessionChatFooterPropsSpy.mockReset();
  });

  beforeEach(async () => {
    (globalThis as { __DEV__?: boolean }).__DEV__ = false;
    resetSession();
    sessionSwitchSpy.mockClear();
    switchReply.mockReset().mockResolvedValue(true);
    modalAlertSpy.mockClear();
    chatListPropsSpy.mockClear();
    agentInputPropsSpy.mockClear();
    warningActionBannerPropsSpy.mockClear();
    sessionUsageLimitWaitResumeEnableSpy.mockReset();
    sessionRunnerRestartSpy.mockClear();
    sessionRunnerStatusGetSpy.mockClear();
    runnerRestartReply.mockReset();
    runnerStatusReply.mockReset().mockResolvedValue(null);
    sessionRunnerRuntimeStatusRetention.clearForTests();
    useFeatureEnabledSpy.mockClear();
    enabledFeatureIds.clear();
    cliDetectionState.authStatus = {
      claude: {
        state: 'logged_in',
        checkedAt: 1,
      },
    };
    process.env.EXPO_PUBLIC_HAPPIER_CONTROL_SWITCH_UI_TIMEOUT_MS = String(controlSwitchTimeoutMs);
  });

  afterEach(() => {
    vi.useRealTimers();
    (globalThis as { __DEV__?: boolean }).__DEV__ = previousDev;
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete process.env.EXPO_PUBLIC_HAPPIER_CONTROL_SWITCH_UI_TIMEOUT_MS;
  });

  it('keeps local-control UI hidden and clears remote switching state after a timeout when controlledByUser never updates', async () => {
    const issued = createDeferred<void>();
    switchReply.mockImplementationOnce(() => {
      issued.resolve();
      return new Promise(() => {});
    });
    await renderSessionView();
    const chatList = getChatListProps();
    expect(chatList.controlSwitchTo).toBeNull();
    expect(typeof chatList.onRequestSwitchToRemote).toBe('function');

    await act(async () => {
      chatList.onRequestSwitchToRemote();
      await issued.promise;
    });

    expect(getChatListProps().controlSwitchTo).toBe('remote');

    await waitForControlSwitchTimeout();
    await flushHookEffects({ cycles: 1, turns: 1 });

    expect(getChatListProps().controlSwitchTo).toBeNull();
    expect(modalAlertSpy).toHaveBeenCalledWith('common.error', 'errors.failedToSwitchControl');
  });

  it('cancels a retained hidden Session observation and permits switching again when presented', async () => {
    vi.stubEnv('EXPO_PUBLIC_HAPPIER_CONTROL_SWITCH_UI_TIMEOUT_MS', '0');
    let release: (() => void) | undefined;
    const issued = createDeferred<void>();
    switchReply.mockImplementationOnce(() => {
      issued.resolve();
      return new Promise<boolean>(resolve => { release = () => resolve(true); });
    });
    const screen = await renderSessionView();
    try {
      await act(async () => { getChatListProps().onRequestSwitchToRemote(); await issued.promise; });
      expect(getChatListProps().controlSwitchTo).toBe('remote');
      await screen.update(<SessionView id="s1" surfaceVisibleOverride={false} />);
      await vi.waitFor(() => expect(getChatListProps().controlSwitchTo).toBeNull());
      expect(modalAlertSpy).not.toHaveBeenCalled();

      await screen.update(<SessionView id="s1" surfaceVisibleOverride={true} surfaceFocusedOverride={false} />);
      act(() => { getChatListProps().onRequestSwitchToRemote(); });
      await vi.waitFor(() => expect(switchReply).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(getChatListProps().controlSwitchTo).toBeNull());
      expect(modalAlertSpy).not.toHaveBeenCalled();
    } finally { await act(async () => { release?.(); }); await screen.unmount(); }
  });

  it('does not surface app-side switch-to-local for attachable exclusive local-control sessions in remote mode', async () => {
    Object.assign(sessionState.session, {
      agentState: {
        controlledByUser: false,
        localControl: {
          attached: false,
          topology: 'exclusive',
          remoteWritable: true,
          canAttach: true,
          canDetach: false,
        },
      },
    });

    const screen = await renderSessionView();
    const chatList = getChatListProps();
    // Remote -> local takeover must remain terminal-driven. The app can switch local
    // sessions back to remote, but it must not expose a transcript button/handler that
    // tries to launch local terminal control from the UI.
    expect(chatList.onRequestSwitchToLocal).toBeUndefined();
    expect(chatList.controlSwitchTo).toBeNull();
    expect(sessionSwitchSpy).not.toHaveBeenCalledWith('s1', 'local');

    await screen.unmount();
  });

  it('hides switch-to-remote when the local Claude CLI is logged out', async () => {
    Object.assign(sessionState.session, {
      metadata: {
        machineId: 'machine-1',
        host: 'mac-mini',
        flavor: 'claude',
      },
    });
    cliDetectionState.authStatus = {
      claude: {
        state: 'logged_out',
        checkedAt: 1,
      },
    };

    const screen = await renderSessionView();
    const chatList = getChatListProps();

    expect(chatList.onRequestSwitchToRemote).toBeUndefined();

    await screen.unmount();
  });

  it('shows only one failure alert when a timed-out switch later fails', async () => {
    let rejectSwitch: ((reason?: unknown) => void) | undefined;
    switchReply.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectSwitch = reject;
        }),
    );

    const screen = await renderSessionView();
    const chatList = getChatListProps();
    act(() => {
      chatList.onRequestSwitchToRemote();
    });

    await waitForControlSwitchTimeout();
    await flushHookEffects({ cycles: 1, turns: 1 });

    const rejectPendingSwitch = rejectSwitch;
    if (rejectPendingSwitch === undefined) {
      throw new Error('Expected pending session switch rejection handler');
    }
    rejectPendingSwitch(new Error('slow failure'));
    await flushHookEffects({ cycles: 1, turns: 1 });

    expect(modalAlertSpy).toHaveBeenCalledTimes(1);
    expect(modalAlertSpy).toHaveBeenCalledWith('common.error', 'errors.failedToSwitchControl');

    await screen.unmount();
  });

  it('lets the usage-limit status badge collapse and reopen the recovery banner', async () => {
    enabledFeatureIds.add('sessions.usageLimitRecovery');
    const futureResetAtMs = Date.now() + 60_000;
    resetSession({
      latestTurnStatus: 'failed' as any,
      lastRuntimeIssue: {
        v: 1,
        scope: 'primary_session',
        status: 'failed',
        code: 'usage_limit',
        source: 'usage_limit',
        occurredAt: 1_700_000_000_000,
        usageLimit: {
          v: 1,
          resetAtMs: futureResetAtMs,
          retryAfterMs: null,
          quotaScope: 'account',
          recoverability: 'wait',
        },
      } as any,
    });

    const screen = await renderSessionView();

    // One message per state: the expanded banner speaks alone and carries its own Hide.
    expect(screen.findByTestId('session-usageLimit-recovery')).toBeTruthy();
    expect(findStatusBadge('usage-limit-recovery')).toBeUndefined();

    await act(async () => {
      getBannerHideAction('session-usageLimit-recovery').onPress();
    });
    await flushHookEffects({ cycles: 1, turns: 1 });

    expect(screen.findByTestId('session-usageLimit-recovery')).toBeNull();
    const collapsedBadge = getUsageLimitStatusBadge();
    expect(collapsedBadge).toEqual(expect.objectContaining({
      testID: 'session-usageLimit-status-badge',
      accessibilityState: { expanded: false },
      onPress: expect.any(Function),
    }));

    await act(async () => {
      collapsedBadge.onPress();
    });
    await flushHookEffects({ cycles: 1, turns: 1 });

    expect(screen.findByTestId('session-usageLimit-recovery')).toBeTruthy();
    expect(findStatusBadge('usage-limit-recovery')).toBeUndefined();

    await screen.unmount();
  });

  it('shows the stale runner banner or its badge, one at a time, and clears after successful restart', async () => {
    resetSession({
      active: true,
      metadata: buildStaleRunnerMetadata(),
    });
    runnerRestartReply.mockResolvedValueOnce({
      ok: true,
      status: 'restarted',
      sessionId: 's1',
    });

    const screen = await renderSessionView();

    expect(screen.findByTestId('session-staleRunner-version')).toBeTruthy();
    expect(findStatusBadge('stale-session-runner')).toBeUndefined();

    await act(async () => {
      getBannerHideAction('session-staleRunner-version').onPress();
    });
    await flushHookEffects({ cycles: 1, turns: 1 });

    expect(screen.findByTestId('session-staleRunner-version')).toBeNull();
    expect(getStaleRunnerStatusBadge()).toEqual(expect.objectContaining({
      key: 'stale-session-runner',
      testID: 'session-staleRunner-status-badge',
      onPress: expect.any(Function),
    }));

    await act(async () => {
      getStaleRunnerStatusBadge().onPress();
    });
    await flushHookEffects({ cycles: 1, turns: 1 });
    expect(findStatusBadge('stale-session-runner')).toBeUndefined();

    const staleRunnerBanner = getWarningActionBannerPropsByTestId('session-staleRunner-version');
    await act(async () => {
      await staleRunnerBanner.onActionPress();
    });
    await flushHookEffects({ cycles: 1, turns: 1 });

    expect(sessionRunnerRestartSpy).toHaveBeenCalledWith({
      signal: expect.any(AbortSignal),
      runtimeState: expect.objectContaining({
        sessionId: 's1',
        runner: expect.objectContaining({
          pid: 123,
          processCommandHash: 'hash-old',
          runtimeId: 'runner-runtime-old',
        }),
      }),
      serverId: runtime.serverId,
    });
    expect(screen.findByTestId('session-staleRunner-version')).toBeNull();
    expect(getAgentInputProps().statusBadges?.some((badge: { key?: string }) => badge.key === 'stale-session-runner')).toBe(false);

    await screen.unmount();
  });

  it('withholds owner-only stale-runner controls for view-only shared sessions', async () => {
    resetSession({
      active: true,
      accessLevel: 'view',
      canApprovePermissions: false,
      agentState: null,
      metadata: buildStaleRunnerMetadata(),
    });

    const screen = await renderSessionView();
    // Current shared-recipient HTTP projections tombstone full Agent state and
    // disclose no owner-only Machine/runner metadata, even if this device had it cached.
    const recipient = shellStorage.getState().sessions.s1;
    expect(recipient?.agentState).toBeNull();
    expect(recipient && readSessionOwnerMetadataView(recipient)).toBeNull();
    expect(screen.findByTestId('session-staleRunner-version')).toBeNull();
    expect(sessionRunnerRestartSpy).not.toHaveBeenCalled();

    await screen.unmount();
  });

  it('shows stale runner banner from daemon status RPC when metadata is not seeded', async () => {
    const staleRuntimeState = (buildStaleRunnerMetadata() as Record<string, unknown>)[SESSION_RUNNER_RUNTIME_METADATA_KEY];
    resetSession({
      active: true,
      serverId: runtime.serverId,
      metadata: {
        path: '/repo',
        host: 'host-1',
        machineId: 'm1',
      },
    });
    runnerStatusReply.mockResolvedValue(staleRuntimeState);
    runnerRestartReply.mockResolvedValueOnce({
      ok: true,
      status: 'restarted',
      sessionId: 's1',
    });

    const screen = await renderSessionView({ routeServerId: runtime.serverId });
    await flushHookEffects({ cycles: 1, turns: 2 });

    expect(sessionRunnerStatusGetSpy).toHaveBeenCalledWith({
      sessionId: 's1',
      machineId: 'm1',
      serverId: runtime.serverId,
      signal: expect.any(AbortSignal),
    });
    await vi.waitFor(() => expect(sessionRunnerRuntimeStatusRetention.read({
      serverId: runtime.serverId, sessionId: 's1', machineId: 'm1',
    })?.state).toEqual(staleRuntimeState));
    await vi.waitFor(() => expect(screen.findByTestId('session-staleRunner-version')).toBeTruthy());

    const staleRunnerBanner = getWarningActionBannerPropsByTestId('session-staleRunner-version');
    await act(async () => {
      await staleRunnerBanner.onActionPress();
    });
    await flushHookEffects({ cycles: 1, turns: 1 });

    expect(sessionRunnerRestartSpy).toHaveBeenCalledWith({
      signal: expect.any(AbortSignal),
      runtimeState: expect.objectContaining({
        sessionId: 's1',
        machineId: 'm1',
        runner: expect.objectContaining({
          pid: 123,
          processCommandHash: 'hash-old',
          runtimeId: 'runner-runtime-old',
        }),
      }),
      serverId: runtime.serverId,
    });

    await screen.unmount();
  });

  it('keeps usage-limit badge ordering ahead of stale-runner and work-state badges', async () => {
    enabledFeatureIds.add('sessions.usageLimitRecovery');
    resetSession({
      active: true,
      metadata: buildStaleRunnerMetadata(),
      latestTurnStatus: 'failed' as any,
      lastRuntimeIssue: {
        v: 1,
        scope: 'primary_session',
        status: 'failed',
        code: 'usage_limit',
        source: 'usage_limit',
        occurredAt: 1_700_000_000_000,
        usageLimit: {
          v: 1,
          resetAtMs: Date.now() + 60_000,
          retryAfterMs: null,
          quotaScope: 'account',
          recoverability: 'wait',
        },
      } as any,
    });

    const screen = await renderSessionView();
    // Badges stand in for collapsed banners only.
    for (const bannerTestID of ['session-usageLimit-recovery', 'session-staleRunner-version']) {
      await act(async () => {
        getBannerHideAction(bannerTestID).onPress();
      });
      await flushHookEffects({ cycles: 1, turns: 1 });
    }
    const badgeKeys = getAgentInputProps().statusBadges?.map((badge: { key: string }) => badge.key);

    expect(badgeKeys).toEqual(expect.arrayContaining(['usage-limit-recovery', 'stale-session-runner']));
    expect(badgeKeys.indexOf('usage-limit-recovery')).toBeLessThan(badgeKeys.indexOf('stale-session-runner'));

    await screen.unmount();
  });

  it.each([false, true])('clears optimistic usage-limit checking state after a recovery failure (Action disabled: %s)', async disabled => {
    enabledFeatureIds.add('sessions.usageLimitRecovery');
    const futureResetAtMs = Date.now() + 60_000;
    sessionUsageLimitWaitResumeEnableSpy.mockResolvedValueOnce({
      ok: false,
      error: 'temporary control failure',
    });
    resetSession({
      latestTurnStatus: 'failed' as any,
      lastRuntimeIssue: {
        v: 1,
        scope: 'primary_session',
        status: 'failed',
        code: 'usage_limit',
        source: 'usage_limit',
        occurredAt: 1_700_000_000_000,
        usageLimit: {
          v: 1,
          resetAtMs: futureResetAtMs,
          retryAfterMs: null,
          quotaScope: 'account',
          recoverability: 'wait',
        },
      } as any,
    });

    const screen = await renderSessionView();
    if (disabled) {
      await act(async () => shellStorage.setState({ settings: { ...shellStorage.getState().settings,
        actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1, actions: { 'session.usageLimit.waitResume.enable': { disabledSurfaces: ['ui'] } } }),
      } }));
    }
    expect(getWarningActionBannerProps().actionTestID).toBe('session-usageLimit-recovery-enable');

    await act(async () => {
      await getWarningActionBannerProps().onActionPress();
    });
    await flushHookEffects({ cycles: 1, turns: 1 });

    if (disabled) expect(sessionUsageLimitWaitResumeEnableSpy).not.toHaveBeenCalled();
    else expect(sessionUsageLimitWaitResumeEnableSpy).toHaveBeenCalledWith(expect.objectContaining({
      // The recovery is armed for this exact failure (agent, turn, occurrence and reset).
      sessionId: 's1', issueFingerprint: `usage-limit:unknown-agent:unknown-turn:1700000000000:${futureResetAtMs}`,
    }));
    expect(modalAlertSpy).toHaveBeenCalledWith('common.error', 'errors.operationFailed', undefined);
    expect(getWarningActionBannerProps().actionTestID).toBe('session-usageLimit-recovery-enable');

    await screen.unmount();
  });

  it('gates usage-limit recovery against the session route server instead of the main selected server', async () => {
    enabledFeatureIds.add('session-server:sessions.usageLimitRecovery');
    const futureResetAtMs = Date.now() + 60_000;
    resetSession({
      serverId: 'session-server',
      latestTurnStatus: 'failed' as any,
      lastRuntimeIssue: {
        v: 1,
        scope: 'primary_session',
        status: 'failed',
        code: 'usage_limit',
        source: 'usage_limit',
        occurredAt: 1_700_000_000_000,
        usageLimit: {
          v: 1,
          resetAtMs: futureResetAtMs,
          retryAfterMs: null,
          quotaScope: 'account',
          recoverability: 'wait',
        },
      } as any,
    });

    const screen = await renderSessionView({ routeServerId: 'session-server' });

    expect(useFeatureEnabledSpy).toHaveBeenCalledWith(
      'sessions.usageLimitRecovery',
      expect.objectContaining({ scopeKind: 'spawn', serverId: 'session-server' }),
    );
    expect(getWarningActionBannerProps().actionTestID).toBe('session-usageLimit-recovery-enable');

    await screen.unmount();
  });

  it('does not advertise resume-now for an active reset-elapsed issue when no interrupted work remains', async () => {
    enabledFeatureIds.add('sessions.usageLimitRecovery');
    resetSession({
      active: true as any,
      latestTurnStatus: 'failed' as any,
      metadata: null,
      lastRuntimeIssue: {
        v: 1,
        scope: 'primary_session',
        status: 'failed',
        code: 'usage_limit',
        source: 'usage_limit',
        occurredAt: 1_700_000_000_000,
        usageLimit: {
          v: 1,
          resetAtMs: 1,
          retryAfterMs: null,
          quotaScope: 'account',
          recoverability: 'wait',
        },
      } as any,
    });

    const screen = await renderSessionView();

    expect(getWarningActionBannerProps().actionTestID).toBe('session-usageLimit-recovery-enable');

    await screen.unmount();
  });
});
