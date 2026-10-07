import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { FindController } from '@happier-dev/plugin-ui/presentation';
import {
  createDeferred,
  createSessionAccessFixture,
  flattenTestStyle,
  flushHookEffects,
  renderScreen,
} from '@/dev/testkit';
import {
  installSessionActionsCommonModuleMocks,
  resetSessionActionsCommonModuleMockState,
  sessionActionsModuleState,
} from './sessionActionsTestHelpers';
import {
  SESSION_ACTION_MARK_READ_ID,
  SESSION_ACTION_MARK_UNREAD_ID,
  SESSION_ACTION_RENAME_ID,
  SESSION_ACTION_RESUME_ID,
} from './sessionActionIds';
import {
  EMPTY_PLUGIN_UI_PROJECTION,
  normalizePluginUiProjection,
} from '@/sync/domains/plugins/ui/projection';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const runSessionHandoffPickerFlowMock = vi.hoisted(() => vi.fn());
const createDefaultActionExecutorMock = vi.hoisted(() => vi.fn());
const openSessionForkStrategyFlowMock = vi.hoisted(() => vi.fn());
const modalAlertMock = vi.hoisted(() => vi.fn());
const modalPromptMock = vi.hoisted(() => vi.fn(async () => null as string | null));
const resolveSessionTargetServerIdMock = vi.hoisted(() => vi.fn());
const preferredServerIdState = vi.hoisted(() => ({
  current: 'server_a' as string | null,
}));
const fireAndForgetMock = vi.hoisted(() => vi.fn());
const createSessionActionDraftMock = vi.hoisted(() => vi.fn());
const buildActionDraftInputMock = vi.hoisted(() => vi.fn());
const teleportVoiceAgentToSessionRootMock = vi.hoisted(() => vi.fn());
const resolveSessionActionDefaultBackendMock = vi.hoisted(() => vi.fn());
const readMachineTargetForSessionMock = vi.hoisted(() => vi.fn());
const machineRpcWithServerScopeMock = vi.hoisted(() => vi.fn());
const sessionSetManualReadStateWithServerScopeMock = vi.hoisted(() => vi.fn(async (
  _sessionId: string,
  _readState: 'read' | 'unread',
  _opts?: { serverId?: string | null },
) => ({ success: true })));
const emitSessionResumeRequestMock = vi.hoisted(() => vi.fn());
const dropdownRenderCount = vi.hoisted(() => ({
  current: 0,
}));
const mutateSessionCompanionPreferenceMock = vi.hoisted(() => vi.fn());
const patchSessionMetadataWithRetryMock = vi.hoisted(() => vi.fn(async (sessionId: string, updater: (metadata: any) => any, _options?: { serverId?: string }) => {
  const session = storageState.current.sessions[sessionId];
  if (session) {
    session.metadata = updater(session.metadata);
  }
}));
const applySessionMetadataLocallyMock = vi.hoisted(() => vi.fn((sessionId: string, updater: (metadata: any) => any) => {
  const session = storageState.current.sessions[sessionId];
  if (session) {
    session.metadata = updater(session.metadata);
  }
}));
const voiceSettingState = vi.hoisted(() => ({
  current: null as any,
}));
const serverSnapshotState = vi.hoisted(() => ({
  current: { status: 'ready', features: { features: { sessions: { enabled: true, handoff: { enabled: true } }, machines: { enabled: true, transfer: { enabled: true, directPeer: { enabled: true }, serverRouted: { enabled: false } } } }, capabilities: {} } } as any,
}));
const voiceSessionSnapshotState = vi.hoisted(() => ({
  current: {
    adapterId: null,
    sessionId: null,
    status: 'disconnected',
    mode: 'idle',
    canStop: false,
  } as any,
}));
const accountCurrentnessState = vi.hoisted(() => ({ current: true }));
const actionsSettingsState = vi.hoisted(() => ({
  current: { v: 1, actions: {} } as any,
}));
const allMachinesState = vi.hoisted(() => ({
  current: [] as any[],
}));
const allSessionsState = vi.hoisted(() => ({
  current: [] as any[],
}));
const reachableMachineTargetState = vi.hoisted(() => ({
  current: null as { machineId: string; basePath: string } | null,
}));
const canForkConversationState = vi.hoisted(() => ({
  current: false,
}));
const daemonMergedProjectionState = vi.hoisted(() => ({
  current: { phase: 'ready', inputs: null } as any,
}));
const storageState = vi.hoisted(() => ({
  current: {
    settings: { voice: null as any } as any,
    sessions: {} as Record<string, any>,
    sessionMessages: {} as Record<string, any>,
    sessionListRowsByServerId: {} as Record<string, Record<string, any>>,
    ordinarySessionListMembershipByServerId: {} as Record<string, readonly string[]>,
    machines: {} as Record<string, any>,
    machineListByServerId: {} as Record<string, any>,
    createSessionActionDraft: createSessionActionDraftMock,
  },
}));
const storageListeners = vi.hoisted(() => ({
  current: new Set<() => void>(),
}));

function notifyStorageListeners() {
  for (const listener of [...storageListeners.current]) {
    listener();
  }
}

function createHeaderTestStorageStore() {
  const readSnapshot = () => storageState.current as any;
  const store = ((selector?: (state: any) => unknown) => React.useSyncExternalStore(
    (listener) => {
      storageListeners.current.add(listener);
      return () => {
        storageListeners.current.delete(listener);
      };
    },
    () => (typeof selector === 'function' ? selector(readSnapshot()) : readSnapshot()),
    () => (typeof selector === 'function' ? selector(readSnapshot()) : readSnapshot()),
  )) as any;
  store.getState = readSnapshot;
  store.getInitialState = readSnapshot;
  store.setState = (updater: any) => {
    const next = typeof updater === 'function' ? updater(storageState.current) : updater;
    storageState.current = {
      ...storageState.current,
      ...next,
    };
    notifyStorageListeners();
  };
  store.subscribe = (listener: any) => {
    const wrapped = () => listener(readSnapshot(), readSnapshot());
    storageListeners.current.add(wrapped);
    return () => {
      storageListeners.current.delete(wrapped);
    };
  };
  store.destroy = () => {
    storageListeners.current.clear();
  };
  return store;
}

/**
 * A codex Agent whose `codexHome` source is declared by the current projection
 * and carries no terminal-follow classification opt-in. Observation-backed
 * background follow must not depend on that contract.
 */
function createDeclaredCodexSourceProjection() {
  return {
    generation: 1,
    installedPackagesById: {
      'test.follow': { id: 'test.follow', enabled: true },
    },
    agentsById: {
      codex: {
        id: 'codex',
        externalSessions: {
          agent: { pluginId: 'test.follow', localId: 'codex' },
          generation: 1,
          operations: {},
          sources: [{
            sourceKind: 'codexHome',
            schema: {
              fields: [
                { name: 'kind', kind: 'literal', value: 'codexHome' },
                { name: 'home', kind: 'enum', values: ['user', 'connectedService'] },
              ],
            },
            key: { segments: [{ kind: 'literal', value: 'codexHome' }] },
            instances: [{ kind: 'default', constants: { home: 'user' } }],
          }],
        },
      },
    },
  };
}

function buildConfiguredInactiveDaemonTransferState() {
  return {
    transfer: {
      supported: {
        import: true,
        export: true,
      },
      listenerClasses: {
        loopback_http: {
          enabled: true,
          configured: true,
          active: false,
        },
        lan_http: {
          enabled: false,
          configured: false,
          active: false,
        },
        tailscale_serve_https: {
          enabled: false,
          configured: false,
          active: false,
          available: false,
        },
      },
      lifecycle: {
        mode: 'lazy_idle_shutdown',
        version: 1,
      },
    },
  };
}

const EXTERNAL_SESSION_RPC_METHOD_PREFIX = 'daemon.externalSessions.';
const EXTERNAL_SESSION_FOLLOW_SET_METHOD = 'daemon.externalSessions.backgroundFollow.set';

/**
 * The header's handoff source-reachability probe issues its own unrelated
 * `machineRpcWithServerScope` traffic through the same mocked transport, so a
 * bare "was this transport used" assertion cannot distinguish it from the
 * follow behavior under test. Name the method instead of counting every call.
 */
function machineRpcCallsWithMethodPrefix(prefix: string): readonly unknown[][] {
  return machineRpcWithServerScopeMock.mock.calls.filter(
    (call) => String((call[0] as { method?: unknown } | undefined)?.method ?? '').startsWith(prefix),
  );
}

/**
 * Answer exactly one method through the shared transport. `mockResolvedValueOnce`
 * is not usable here: the reachability probe can consume the queued value before
 * the action under test ever reaches the transport.
 */
function respondToMachineRpcMethod(
  method: string,
  respond: () => unknown,
): void {
  machineRpcWithServerScopeMock.mockImplementation(async (request: unknown) => {
    if ((request as { method?: unknown } | undefined)?.method === method) return await respond();
    throw new Error('unreachable');
  });
}

installSessionActionsCommonModuleMocks({
  modal: async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
      spies: {
        alert: modalAlertMock,
        prompt: modalPromptMock,
      },
    }).module;
  },
  reactNative: async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
      Pressable: (props: any) =>
        React.createElement(
          'Pressable',
          props,
          typeof props.children === 'function' ? props.children({ pressed: false }) : props.children,
        ),
      View: (props: any) => React.createElement('View', props, props.children),
      Platform: {
        OS: 'web',
      },
      AppState: {
        currentState: 'active',
        addEventListener: vi.fn(() => ({ remove: vi.fn() })),
      },
    });
  },
  storage: async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
      storage: createHeaderTestStorageStore(),
      useSettings: () => storageState.current.settings,
      useActiveServerAccountScope: () => ({ serverId: 'server_a', accountId: 'account_a' }),
      useSessionCompanionPreferenceSlot: (_sessionId: string | null, serverId?: string | null) => ({
        stored: undefined,
        storageKey: serverId ? `${serverId}:test-account:test-session` : null,
      }),
      useMutateSessionCompanionPreference: () => mutateSessionCompanionPreferenceMock,
      useSession: (sessionId: string) => storageState.current.sessions[sessionId] ?? null,
      useSetting: (key: string) => {
        if (key === 'actionsSettingsV1') return actionsSettingsState.current;
        if (key === 'sessionReplayEnabled') return true;
        if (key === 'voice') return voiceSettingState.current;
        return null;
      },
      useAllMachines: () => allMachinesState.current,
      useAllSessions: () => allSessionsState.current,
      useProjectForSession: () => null,
    });
  },
  unistyles: async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
      theme: {
        colors: {
          header: { tint: '#fff' },
        },
      },
    });
  },
});

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react');
  return {
    ...actual,
    useMemo: actual.useMemo,
    useState: actual.useState,
  };
});

vi.mock('@happier-dev/protocol', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@happier-dev/protocol')>();
  return {
    ...actual,
    listActionSpecs: () => [
      {
        id: 'session.fork',
        title: 'Fork session',
        description: 'Create a child session',
        surfaces: { ui: true },
        placements: ['session_action_menu'],
      },
      {
        id: 'session.handoff',
        title: 'Hand off session',
        description: 'Move the current session',
        surfaces: { ui: true },
        placements: ['session_action_menu'],
      },
      {
        id: 'subagents.plan.start',
        title: 'Start plan run',
        description: 'Plan changes',
        surfaces: { ui: true },
        placements: ['session_action_menu'],
      },
    ],
  };
});

vi.mock('@/agents/hooks/useEnabledAgentIds', () => ({
  useEnabledAgentIds: () => ['claude'],
}));

vi.mock('@/agents/backendCatalog/useDaemonMergedProjectionInputs', () => ({
  useDaemonMergedProjectionInputs: () => daemonMergedProjectionState.current,
}));

vi.mock('@/components/sessions/model/sessionResumeRequests', () => ({
  emitSessionResumeRequest: (sessionId: string) => emitSessionResumeRequestMock(sessionId),
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
  DropdownMenu: (props: any) => {
    dropdownRenderCount.current += 1;
    return React.createElement('DropdownMenu', props);
  },
}));

vi.mock('@/sync/domains/actions/buildActionDraftInput', () => ({
  buildActionDraftInput: buildActionDraftInputMock,
}));

vi.mock('@/utils/system/fireAndForget', () => ({
  fireAndForget: (promise: Promise<unknown>, _opts?: unknown) => {
    fireAndForgetMock(promise, _opts);
  },
}));

vi.mock('@/sync/ops/actions/defaultActionExecutor', () => ({
  createDefaultActionExecutor: (...args: unknown[]) => createDefaultActionExecutorMock(...args),
}));

vi.mock('@/components/sessions/model/resolveSessionTargetServerId', () => ({
  resolveSessionTargetServerId: (...args: unknown[]) => resolveSessionTargetServerIdMock(...args),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession', () => ({
  usePreferredServerIdForSession: () => preferredServerIdState.current,
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId', () => ({
  resolvePreferredServerIdForSessionId: () => {
    throw new Error('legacy direct resolver should not be used in SessionHeaderActionMenu');
  },
}));

vi.mock('@/sync/domains/sessionFork/forkUiSupport', () => ({
  canForkConversation: () => canForkConversationState.current,
}));

vi.mock('@/components/sessions/fork/openSessionForkStrategyFlow', () => ({
  openSessionForkStrategyFlow: (...args: unknown[]) => openSessionForkStrategyFlowMock(...args),
}));

vi.mock('@/sync/domains/sessionHandoff/runSessionHandoffPickerFlow', () => ({
  runSessionHandoffPickerFlow: (...args: unknown[]) => runSessionHandoffPickerFlowMock(...args),
}));

vi.mock('@/sync/ops/sessionMachineTarget', () => ({
  readMachineTargetForSession: (...args: unknown[]) => readMachineTargetForSessionMock(...args),
}));

vi.mock('@/sync/ops', () => ({
  sessionSetManualReadStateWithServerScope: (
    sessionId: string,
    readState: 'read' | 'unread',
    opts?: { serverId?: string | null },
  ) => sessionSetManualReadStateWithServerScopeMock(sessionId, readState, opts),
}));

vi.mock('@/components/sessions/model/useSessionMachineReachability', () => ({
  useSessionReachableMachineTarget: () => reachableMachineTargetState.current,
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
  machineRpcWithServerScope: (...args: unknown[]) => machineRpcWithServerScopeMock(...args),
}));

vi.mock('@/sync/sync', () => ({
  sync: {
    patchSessionMetadataWithRetry: (
      sessionId: string,
      updater: (metadata: any) => any,
      options?: { serverId?: string },
    ) => patchSessionMetadataWithRetryMock(sessionId, updater, options),
    applySessionMetadataLocally: (
      sessionId: string,
      updater: (metadata: any) => any,
    ) => applySessionMetadataLocallyMock(sessionId, updater),
  },
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
  useFeatureEnabled: () => true,
}));

vi.mock('@/sync/domains/features/featureDecisionRuntime', () => ({
  useServerFeaturesSnapshotForServerId: () => serverSnapshotState.current,
}));

vi.mock('@/sync/domains/scope/activeServerAccountScope', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/sync/domains/scope/activeServerAccountScope')>(),
  captureActiveServerAccountScopeCurrentness: () => ({
    isCurrent: () => accountCurrentnessState.current,
    onRetire: () => ({ dispose() {} }),
  }),
}));

vi.mock('@/sync/domains/session/resolveSessionActionDefaultBackend', async (importOriginal) => {
  // Only the resolver itself is a test-controlled boundary; the target
  // projection over its result stays real so callers keep the canonical
  // agentTarget-before-backendTarget precedence.
  const original = await importOriginal<typeof import('@/sync/domains/session/resolveSessionActionDefaultBackend')>();
  return {
    ...original,
    resolveSessionActionDefaultBackend: (...args: unknown[]) => resolveSessionActionDefaultBackendMock(...args),
  };
});

vi.mock('@/voice/session/voiceSession', () => ({
  useVoiceSessionSnapshot: () => voiceSessionSnapshotState.current,
}));

vi.mock('@/voice/agent/teleportVoiceAgentToSessionRoot', () => ({
  teleportVoiceAgentToSessionRoot: (args: any) => teleportVoiceAgentToSessionRootMock(args),
}));

describe('SessionHeaderActionMenu handoff', () => {
  beforeEach(async () => {
    resetSessionActionsCommonModuleMockState();
    runSessionHandoffPickerFlowMock.mockReset();
    createDefaultActionExecutorMock.mockReset();
    openSessionForkStrategyFlowMock.mockReset();
    modalAlertMock.mockReset();
    modalPromptMock.mockReset();
    modalPromptMock.mockResolvedValue(null);
    resolveSessionTargetServerIdMock.mockReset();
    resolveSessionTargetServerIdMock.mockImplementation((_sessionId: string, fallbackServerId?: string | null) => fallbackServerId ?? null);
    preferredServerIdState.current = 'server_a';
    fireAndForgetMock.mockReset();
    createSessionActionDraftMock.mockReset();
    buildActionDraftInputMock.mockReset();
    teleportVoiceAgentToSessionRootMock.mockReset();
    resolveSessionActionDefaultBackendMock.mockReset();
    readMachineTargetForSessionMock.mockReset();
    machineRpcWithServerScopeMock.mockReset();
    sessionSetManualReadStateWithServerScopeMock.mockReset();
    emitSessionResumeRequestMock.mockReset();
    dropdownRenderCount.current = 0;
    mutateSessionCompanionPreferenceMock.mockReset();
    mutateSessionCompanionPreferenceMock.mockImplementation((
      _sessionId: string,
      project: (stored: unknown) => unknown,
    ) => project(undefined) !== null);
    storageListeners.current.clear();
    patchSessionMetadataWithRetryMock.mockReset();
    applySessionMetadataLocallyMock.mockReset();
    readMachineTargetForSessionMock.mockReturnValue(null);
    machineRpcWithServerScopeMock.mockRejectedValue(new Error('unreachable'));
    canForkConversationState.current = false;
    accountCurrentnessState.current = true;
    serverSnapshotState.current = { status: 'ready', features: { features: { sessions: { enabled: true, handoff: { enabled: true } }, machines: { enabled: true, transfer: { enabled: true, directPeer: { enabled: true }, serverRouted: { enabled: false } } } }, capabilities: {} } } as any;

    createDefaultActionExecutorMock.mockReturnValue({
      execute: vi.fn(),
    });
    buildActionDraftInputMock.mockReturnValue({ draft: true });
    preferredServerIdState.current = 'server_a';
    runSessionHandoffPickerFlowMock.mockResolvedValue({ ok: true, handoffId: 'handoff_1' });
    resolveSessionActionDefaultBackendMock.mockReturnValue({
      backendTarget: { kind: 'agent', agentId: 'claude' },
      defaultBackendId: 'claude',
    });
    voiceSettingState.current = null;
    reachableMachineTargetState.current = null;
    daemonMergedProjectionState.current = { phase: 'ready', inputs: null };
    storageState.current = {
      settings: {
        voice: null,
        experiments: true,
        featureToggles: { 'execution.runs': true },
      },
      sessions: {},
      sessionMessages: {},
      sessionListRowsByServerId: {},
      ordinarySessionListMembershipByServerId: {},
      machines: {},
      machineListByServerId: {},
      createSessionActionDraft: createSessionActionDraftMock,
    };
    allMachinesState.current = [];
    allSessionsState.current = [];
    voiceSessionSnapshotState.current = {
      adapterId: null,
      sessionId: null,
      status: 'disconnected',
      mode: 'idle',
      canStop: false,
    };

    vi.resetModules();
    // `storageStore` claims the storage-state reader bridge at module load, and
    // this suite only replaces `@/sync/domains/state/storage`. Import the real
    // store first so its registration happens before this fixture claims the
    // bridge; otherwise the component graph's own transitive import silently
    // replaces the test store and every bridge-backed reader — renderable
    // row read-state, the External Session follow link fence — sees an empty
    // Home instead of the fixture.
    await import('@/sync/domains/state/storageStore');
    const { registerStorageStateReader } = await import('@/sync/domains/state/storageStateReaderBridge');
    registerStorageStateReader(() => storageState.current as any);
    const { voiceSessionBindingStore } = await import('@/voice/binding/voiceConversationBindingStore');
    for (const binding of voiceSessionBindingStore.getState().list()) {
      voiceSessionBindingStore.getState().unbind(binding.conversationSessionId);
    }
  });

  it('opens Find in chat on the exact mounted session surface without keyboard preferences', async () => {
    // DOM event registration is a platform boundary; this node renderer has no window.
    vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} });
    const { SessionHeaderActionMenu } = await import('./SessionHeaderActionMenu');
    const { KeyboardShortcutProvider, useFindSurfaceRegistration } = await import('@/keyboard/KeyboardShortcutProvider');
    let opened = false;
    const controller: FindController = {
      query: '', options: { matchCase: false, regex: false }, status: { kind: 'idle' },
      capabilities: { regex: true, stop: false },
      setQuery() {}, setOptions() {}, step() {}, stop() {}, close() { opened = false; },
    };
    function MountedTranscript() {
      useFindSurfaceRegistration({
        surfaceId: 'transcript:server_a:session-find-entry',
        containsFocus: () => false,
        open: () => { opened = true; },
        isOpen: () => opened,
        isInputFocused: () => false,
        controller,
      });
      return null;
    }
    // Existing header harness uses the platform/storage boundary fixture shape.
    const session = {
      id: 'session-find-entry', serverId: 'server_a', active: true, seq: 1,
      metadataLayoutVersion: 1, metadata: {}, ownerMetadataView: {}, agentState: null, access: null,
    } as any;
    const screen = await renderScreen(
      <KeyboardShortcutProvider handlers={{}}>
        <MountedTranscript />
        <SessionHeaderActionMenu sessionId={session.id} session={session} />
      </KeyboardShortcutProvider>,
    );
    try {
      const dropdown = screen.findByType('DropdownMenu' as any);
      expect(dropdown.props.items.map((item: { id: string }) => item.id)).toContain('header.findChat');
      await act(async () => { dropdown.props.onSelect('header.findChat'); });
      expect(opened).toBe(true);
    } finally {
      await act(async () => { screen.unmount(); });
      vi.unstubAllGlobals();
    }
  });

  it('keeps an untouched empty Companion reachable through the incumbent overflow menu', async () => {
    const { SessionHeaderActionMenu } = await import('./SessionHeaderActionMenu');
    const { SessionCompanionRevealPortProvider } = await import(
      '@/components/sessions/companion/presentation/SessionCompanionRevealPort'
    );
    const session = {
      id: 'session-companion-entry',
      serverId: 'server_a',
      active: true,
      seq: 1,
      metadataLayoutVersion: 1,
      metadata: {},
      ownerMetadataView: {},
      agentState: null,
      access: null,
    } as any;

    const screen = await renderScreen(
      <SessionCompanionRevealPortProvider
        address={{ serverId: 'server_a', sessionId: session.id }}
        openFullSurface={() => undefined}
        revealAfterMutation={() => undefined}
        revealBoardItem={() => undefined}
      >
        <SessionHeaderActionMenu
          sessionId={session.id}
          session={session}
          companionHeaderActionPlacement="overflow"
          companionHeaderIntent={{
            operation: 'show',
            accessibility: 'show',
            itemCount: 0,
            expanded: false,
            checked: false,
          }}
        />
      </SessionCompanionRevealPortProvider>,
    );

    const dropdown = screen.findByType('DropdownMenu' as any);
    expect(dropdown.props.items.map((item: { id: string }) => item.id)).toContain('header.openCompanion');
    expect(dropdown.props.items).toEqual(expect.arrayContaining([expect.objectContaining({
      id: 'header.openCompanion',
      title: 'sessionBoard.companion.a11y.headerAction',
    })]));
  });

  it('hands a first show to the exact mounted reveal owner after the preference applies', async () => {
    const { SessionHeaderActionMenu } = await import('./SessionHeaderActionMenu');
    const { SessionCompanionRevealPortProvider } = await import(
      '@/components/sessions/companion/presentation/SessionCompanionRevealPort'
    );
    const session = {
      id: 'session-companion-first-show',
      serverId: 'server_a',
      active: true,
      seq: 1,
      metadataLayoutVersion: 1,
      metadata: {},
      ownerMetadataView: {},
      agentState: null,
      access: null,
    } as any;
    const revealAfterMutation = vi.fn();
    const screen = await renderScreen(
      <SessionCompanionRevealPortProvider
        address={{ serverId: 'server_a', sessionId: session.id }}
        openFullSurface={() => undefined}
        revealAfterMutation={revealAfterMutation}
        revealBoardItem={() => undefined}
      >
        <SessionHeaderActionMenu
          sessionId={session.id}
          session={session}
          companionHeaderActionPlacement="direct"
          companionHeaderIntent={{
            operation: 'show',
            accessibility: 'show',
            itemCount: 0,
            expanded: false,
            checked: false,
          }}
        />
      </SessionCompanionRevealPortProvider>,
    );

    const companionButton = screen.findByTestId('session-header-companion');
    if (!companionButton) throw new Error('Expected the direct Companion action');
    act(() => companionButton.props.onPress());

    expect(mutateSessionCompanionPreferenceMock).toHaveBeenCalledTimes(1);
    expect(revealAfterMutation).toHaveBeenCalledTimes(1);
    expect(revealAfterMutation).toHaveBeenCalledWith(expect.objectContaining({
      applied: expect.objectContaining({ visible: true }),
    }));
    expect(sessionActionsModuleState.routerPushSpy).not.toHaveBeenCalled();
  });

  it('does not publish a Companion header action without the exact mounted reveal owner', async () => {
    const { SessionHeaderActionMenu } = await import('./SessionHeaderActionMenu');
    const { SessionCompanionRevealPortProvider } = await import(
      '@/components/sessions/companion/presentation/SessionCompanionRevealPort'
    );
    const session = {
      id: 'session-companion-wrong-home',
      serverId: 'server_a',
      active: true,
      seq: 1,
      metadataLayoutVersion: 1,
      metadata: {},
      ownerMetadataView: {},
      agentState: null,
      access: null,
    } as any;
    const screen = await renderScreen(
      <SessionCompanionRevealPortProvider
        address={{ serverId: 'server_b', sessionId: session.id }}
        openFullSurface={() => undefined}
        revealAfterMutation={() => undefined}
        revealBoardItem={() => undefined}
      >
        <SessionHeaderActionMenu
          sessionId={session.id}
          session={session}
          companionHeaderActionPlacement="direct"
          companionHeaderIntent={{
            operation: 'show',
            accessibility: 'show',
            itemCount: 0,
            expanded: false,
            checked: false,
          }}
        />
      </SessionCompanionRevealPortProvider>,
    );

    expect(screen.findByTestId('session-header-companion')).toBeNull();
    expect(screen.findByType('DropdownMenu' as any).props.items.map((item: { id: string }) => item.id))
      .not.toContain('header.openCompanion');
  });

  it('does not open the full Companion when a show-and-open mutation was not applied', async () => {
    mutateSessionCompanionPreferenceMock.mockImplementation(() => false);
    const { SessionHeaderActionMenu } = await import('./SessionHeaderActionMenu');
    const { SessionCompanionRevealPortProvider } = await import(
      '@/components/sessions/companion/presentation/SessionCompanionRevealPort'
    );
    const session = {
      id: 'session-companion-noop-show',
      serverId: 'server_a',
      active: true,
      seq: 1,
      metadataLayoutVersion: 1,
      metadata: {},
      ownerMetadataView: {},
      agentState: null,
      access: null,
    } as any;
    const openFullSurface = vi.fn();
    const screen = await renderScreen(
      <SessionCompanionRevealPortProvider
        address={{ serverId: 'server_a', sessionId: session.id }}
        openFullSurface={openFullSurface}
        revealAfterMutation={() => undefined}
        revealBoardItem={() => undefined}
      >
        <SessionHeaderActionMenu
          sessionId={session.id}
          session={session}
          companionHeaderActionPlacement="direct"
          companionHeaderIntent={{
            operation: 'show_and_open_full',
            accessibility: 'open_full',
            itemCount: 0,
            expanded: false,
            checked: false,
          }}
        />
      </SessionCompanionRevealPortProvider>,
    );

    const companionButton = screen.findByTestId('session-header-companion');
    if (!companionButton) throw new Error('Expected the direct Companion action');
    act(() => companionButton.props.onPress());

    expect(mutateSessionCompanionPreferenceMock).toHaveBeenCalledTimes(1);
    expect(openFullSurface).not.toHaveBeenCalled();
  });

  it('projects one Companion descriptor in exactly one direct or overflow placement', async () => {
    const { SessionHeaderActionMenu } = await import('./SessionHeaderActionMenu');
    const { SessionCompanionRevealPortProvider } = await import(
      '@/components/sessions/companion/presentation/SessionCompanionRevealPort'
    );
    const session = {
      id: 'session-companion-placement',
      serverId: 'server_a',
      active: true,
      seq: 1,
      metadataLayoutVersion: 1,
      metadata: {},
      ownerMetadataView: {},
      agentState: null,
      access: null,
    } as any;
    const intent = {
      operation: 'show' as const,
      accessibility: 'show' as const,
      itemCount: 0,
      expanded: false,
      checked: false,
    };
    const wrap = (child: React.ReactElement) => (
      <SessionCompanionRevealPortProvider
        address={{ serverId: 'server_a', sessionId: session.id }}
        openFullSurface={() => undefined}
        revealAfterMutation={() => undefined}
        revealBoardItem={() => undefined}
      >
        {child}
      </SessionCompanionRevealPortProvider>
    );
    const direct = await renderScreen(wrap(<SessionHeaderActionMenu
      sessionId={session.id}
      session={session}
      companionHeaderActionPlacement="direct"
      companionHeaderIntent={intent}
    />));

    expect(direct.findByTestId('session-header-companion')).not.toBeNull();
    expect(direct.findByType('DropdownMenu' as any).props.items.map((item: { id: string }) => item.id))
      .not.toContain('header.openCompanion');

    const overflow = await renderScreen(wrap(<SessionHeaderActionMenu
      sessionId={session.id}
      session={session}
      companionHeaderActionPlacement="overflow"
      companionHeaderIntent={intent}
    />));

    expect(overflow.findByTestId('session-header-companion')).toBeNull();
    expect(overflow.findByType('DropdownMenu' as any).props.items)
      .toEqual(expect.arrayContaining([expect.objectContaining({
        id: 'header.openCompanion',
        title: 'sessionBoard.companion.a11y.headerAction',
        checked: false,
        accessibilityLabel: 'sessionBoard.companion.a11y.show',
      })]));
  });

  it('offers one standalone resume request for an inactive resumable session', async () => {
    const { SessionHeaderActionMenu } = await import('./SessionHeaderActionMenu');
    const resumeRequest = createDeferred<boolean>();
    emitSessionResumeRequestMock.mockReturnValue(resumeRequest.promise);
    const session = {
      id: 'sess_resumable',
      active: false,
      seq: 4,
      // `createSessionActionTarget` reads resume/rename authority from the
      // canonical access projection, never from a legacy `accessLevel`.
      access: createSessionAccessFixture(),
      metadataLayoutVersion: 1,
      metadata: { path: '/shared', host: 'shared' },
      agentState: null,
      ownerMetadataView: {
        path: '/workspace',
        host: 'machine',
        flavor: 'claude',
        claudeSessionId: 'claude_vendor_session',
        claudeTranscriptPath: '/tmp/claude_vendor_session.jsonl',
      },
    } as any;

    const screen = await renderScreen(<SessionHeaderActionMenu
      sessionId={session.id}
      session={session}
    />);

    const dropdown = screen.findByType('DropdownMenu' as any);
    expect(dropdown.props.items.map((item: { id: string }) => item.id)).toContain(SESSION_ACTION_RESUME_ID);

    await act(async () => {
      dropdown.props.onSelect(SESSION_ACTION_RESUME_ID);
      await Promise.resolve();
    });

    expect(emitSessionResumeRequestMock).toHaveBeenCalledTimes(1);
    expect(emitSessionResumeRequestMock).toHaveBeenCalledWith(session.id);
    const resumeAction = fireAndForgetMock.mock.calls.at(-1)?.[0] as Promise<unknown> | undefined;
    expect(resumeAction).toBeInstanceOf(Promise);
    let settled = false;
    void resumeAction?.then(() => {
      settled = true;
    });
    await flushHookEffects();
    expect(settled).toBe(false);

    resumeRequest.resolve(true);
    await act(async () => {
      await resumeAction;
    });
    expect(settled).toBe(true);
    expect(modalAlertMock).not.toHaveBeenCalled();
  });

  it('keeps the closed trigger stable when only the session sequence changes', async () => {
    const metadata = {
      machineId: 'machine_source',
      flavor: 'claude',
    };
    const { SessionHeaderActionMenu } = await import('./SessionHeaderActionMenu');

    const screen = await renderScreen(<SessionHeaderActionMenu
      sessionId="sess_1"
      session={{
        id: 'sess_1',
        seq: 10,
        metadata,
      } as any}
    />);

    const initialRenderCount = dropdownRenderCount.current;
    expect(initialRenderCount).toBeGreaterThan(0);

    await screen.update(<SessionHeaderActionMenu
      sessionId="sess_1"
      session={{
        id: 'sess_1',
        seq: 11,
        metadata,
      } as any}
    />);

    expect(dropdownRenderCount.current).toBe(initialRenderCount);
  });

  it('keeps the closed trigger stable when metadata only changes freshness timestamps', async () => {
    const { SessionHeaderActionMenu } = await import('./SessionHeaderActionMenu');

    const screen = await renderScreen(<SessionHeaderActionMenu
      sessionId="sess_1"
      session={{
        id: 'sess_1',
        seq: 10,
        metadata: {
          machineId: 'machine_source',
          flavor: 'claude',
          summary: { text: 'same summary', updatedAt: 100 },
          sessionModesV1: {
            v: 1,
            agentId: 'claude',
            updatedAt: 100,
            currentModeId: 'default',
            availableModes: [{ id: 'default', name: 'Default' }],
          },
          sessionModelsV1: {
            v: 1,
            agentId: 'claude',
            updatedAt: 100,
            currentModelId: 'model-a',
            availableModels: [{ id: 'model-a', name: 'Model A' }],
          },
        },
      } as any}
    />);

    const initialRenderCount = dropdownRenderCount.current;
    expect(initialRenderCount).toBeGreaterThan(0);

    await screen.update(<SessionHeaderActionMenu
      sessionId="sess_1"
      session={{
        id: 'sess_1',
        seq: 10,
        metadata: {
          machineId: 'machine_source',
          flavor: 'claude',
          summary: { text: 'same summary', updatedAt: 200 },
          sessionModesV1: {
            v: 1,
            agentId: 'claude',
            updatedAt: 200,
            currentModeId: 'default',
            availableModes: [{ id: 'default', name: 'Default' }],
          },
          sessionModelsV1: {
            v: 1,
            agentId: 'claude',
            updatedAt: 200,
            currentModelId: 'model-a',
            availableModels: [{ id: 'model-a', name: 'Model A' }],
          },
        },
      } as any}
    />);

    expect(dropdownRenderCount.current).toBe(initialRenderCount);
  });

  it('refreshes closed menu props when active or owner changes action availability', async () => {
    const { SessionHeaderActionMenu } = await import('./SessionHeaderActionMenu');

    const screen = await renderScreen(<SessionHeaderActionMenu
      sessionId="sess_1"
      session={{
        id: 'sess_1',
        seq: 10,
        active: true,
        owner: 'user_1',
        accessLevel: undefined,
        metadata: {
          machineId: 'machine_source',
          flavor: 'claude',
        },
      } as any}
    />);

    const initialRenderCount = dropdownRenderCount.current;
    expect(initialRenderCount).toBeGreaterThan(0);

    await screen.update(<SessionHeaderActionMenu
      sessionId="sess_1"
      session={{
        id: 'sess_1',
        seq: 10,
        active: false,
        owner: 'user_2',
        accessLevel: undefined,
        metadata: {
          machineId: 'machine_source',
          flavor: 'claude',
        },
      } as any}
    />);

    expect(dropdownRenderCount.current).toBeGreaterThan(initialRenderCount);
  });

  it('prefers the reachable source machine id for handoff gating and flow context when session metadata is stale', async () => {
    reachableMachineTargetState.current = {
      machineId: 'machine_rebound',
      basePath: '/workspace/repo',
    };
    readMachineTargetForSessionMock.mockReturnValue(null);
    const { SessionHeaderActionMenu } = await import('./SessionHeaderActionMenu');
    const { recordCachedMachineRpcDirectRouteViable } = await import('@/sync/domains/transfers/runtime/transferRouteCache');
    recordCachedMachineRpcDirectRouteViable({
      serverId: 'server_a',
      remoteMachineId: 'machine_rebound',
    });

    const screen = await renderScreen(<SessionHeaderActionMenu
          sessionId="sess_1"
          session={{
            id: 'sess_1',
            serverId: 'server_a',
            metadata: {
              machineId: 'machine_source',
              flavor: 'claude',
            },
          } as any}
        />);

    const dropdown = screen.findByType('DropdownMenu' as any);
    expect(dropdown.props.items.some((item: any) => item?.id === 'session.handoff')).toBe(true);
    vi.useFakeTimers();
    try {
      await act(async () => {
        dropdown.props.onSelect('session.handoff');
      });
      await act(async () => {
        await vi.runAllTimersAsync();
      });
    } finally {
      vi.useRealTimers();
    }
    await flushHookEffects({ cycles: 1 });

    expect(runSessionHandoffPickerFlowMock).toHaveBeenCalledWith({
      execute: expect.any(Function),
      sessionId: 'sess_1',
      sourceMachineId: 'machine_rebound',
      serverId: 'server_a',
      placement: 'session_action_menu',
    });
  });

  it('renders the session action menu trigger with the expected accessibility contract when actions are available', async () => {
    const { SessionHeaderActionMenu } = await import('./SessionHeaderActionMenu');

    const screen = await renderScreen(<SessionHeaderActionMenu
          sessionId="sess_1"
          session={{
            id: 'sess_1',
            metadata: {
              machineId: 'machine_source',
              flavor: 'claude',
            },
          } as any}
        />);

    const dropdown = screen.findByType('DropdownMenu' as any);
    const trigger = dropdown.props.trigger({
      open: false,
      toggle: vi.fn(),
      openMenu: vi.fn(),
      closeMenu: vi.fn(),
      selectedItem: null,
    }) as any;

    expect(trigger.props['data-testid']).toBe('session-header-action-menu-trigger');
    expect(trigger.props['aria-label']).toBe('session.actionMenu.openA11y');
    expect(trigger.props.testID).toBeUndefined();
    expect(trigger.props.accessibilityLabel).toBeUndefined();
  });

  it('exposes a web click fallback for opening the session action menu trigger', async () => {
    const { SessionHeaderActionMenu } = await import('./SessionHeaderActionMenu');

    const screen = await renderScreen(<SessionHeaderActionMenu
          sessionId="sess_1"
          session={{
            id: 'sess_1',
            metadata: {
              machineId: 'machine_source',
              flavor: 'claude',
            },
          } as any}
        />);

    const dropdown = screen.findByType('DropdownMenu' as any);
    const toggle = vi.fn();
    const trigger = dropdown.props.trigger({
      open: false,
      toggle,
      openMenu: vi.fn(),
      closeMenu: vi.fn(),
      selectedItem: null,
    }) as any;

    expect(trigger.type).toBe('button');
    expect(trigger.props['data-testid']).toBe('session-header-action-menu-trigger');
    expect(trigger.props.testID).toBeUndefined();
    expect(typeof trigger.props.onClick).toBe('function');

    trigger.props.onClick({ stopPropagation: vi.fn() });

    expect(toggle).toHaveBeenCalledTimes(1);
  });

  function normalizedPluginHeaderActionPresentation(
    projection: ReturnType<typeof normalizePluginUiProjection>,
    actionId: string,
    title: string,
  ) {
    const action = projection.sessionHeaderActionsById[actionId];
    if (!action) throw new Error(`Missing projected plugin header action ${actionId}`);
    return {
      action,
      menuActionId: `plugin-ui:${action.id}`,
      title,
      iconName: 'puzzle-piece' as const,
      enabled: true,
    };
  }

  it('uses the Android physical 48dp target instead of overlapping hit slop for direct and menu header controls', async () => {
    const { Platform } = await import('react-native');
    const previousPlatform = Platform.OS;
    (Platform as { OS: string }).OS = 'android';
    try {
      const { SessionHeaderActionMenu } = await import('./SessionHeaderActionMenu');
      const screen = await renderScreen(<SessionHeaderActionMenu
        sessionId="sess_1"
        session={{
          id: 'sess_1',
          metadata: { machineId: 'machine_source', flavor: 'claude' },
        } as any}
        extraItems={[{ id: 'test.extra', title: 'Extra' }]}
        pluginHeaderActions={[{
          action: {} as never,
          menuActionId: 'plugin-ui:sessionHeaderAction:acme.preview:run-preview',
          title: 'Preview',
          iconName: 'puzzle-piece',
          enabled: true,
        }]}
        pluginHeaderActionPlacement="direct"
      />);

      const directAction = screen.findByProps({
        testID: 'session-header-plugin-action-plugin-ui:sessionHeaderAction:acme.preview:run-preview',
      });
      expect(flattenTestStyle(directAction.props.style({ pressed: false }))).toMatchObject({
        width: 48,
        height: 48,
      });
      expect(directAction.props.hitSlop).toBeUndefined();

      const dropdown = screen.findByType('DropdownMenu' as any);
      const menuTrigger = dropdown.props.trigger({
        open: false,
        toggle: vi.fn(),
        openMenu: vi.fn(),
        closeMenu: vi.fn(),
        selectedItem: null,
      }) as any;
      expect(menuTrigger.props.testID).toBe('session-header-action-menu-trigger');
      expect(flattenTestStyle(menuTrigger.props.style({ pressed: false }))).toMatchObject({
        width: 48,
        height: 48,
      });
      expect(menuTrigger.props.hitSlop).toBeUndefined();
    } finally {
      (Platform as { OS: string }).OS = previousPlatform;
    }
  });

  it('does not transport a header action after its captured scope lifetime retires before either press arm', async () => {
    machineRpcWithServerScopeMock.mockResolvedValue({
      ok: true,
      result: { opened: true },
    });
    const pluginUiProjection = normalizePluginUiProjection({
      v: 2,
      generation: 7,
      installedPackagesById: {},
      agentsById: {},
      actionsById: {
        'acme.preview/run': {
          id: 'run',
          pluginId: 'acme.preview',
          occurrenceId: 'acme-preview-occurrence-7',
          title: 'Preview',
          scopes: ['session'],
          surfaces: ['ui'],
          execution: { target: 'daemon' },
          placementBindings: ['detailsPanel'],
          dangerLevel: 'safe',
          available: true,
        },
      },
      toolsById: {},
      commandsById: {},
      resourcesById: {},
      settingsById: {},
      familiesById: {
        pluginUi: {
          family: 'pluginUi',
          entriesById: {
            'sessionHeaderAction:acme.preview:run-preview': {
              id: 'sessionHeaderAction:acme.preview:run-preview',
              pluginId: 'acme.preview',
              occurrenceId: 'acme-preview-occurrence-7',
              contributionKind: 'sessionHeaderAction',
              descriptorId: 'run-preview',
              title: {
                key: 'title',
                fallback: 'Preview',
              },
              command: {
                kind: 'executeAction',
                action: { pluginId: 'acme.preview', localId: 'run' },
              },
            },
          },
        },
      },
      diagnostics: [],
    });
    const headerAction = normalizedPluginHeaderActionPresentation(
      pluginUiProjection,
      'sessionHeaderAction:acme.preview:run-preview',
      'Preview',
    );
    const pluginHeaderScope = {
      serverId: 'server-projection',
      machineId: 'machine-projection',
      generation: 7,
      interactionEnabled: true,
    } as const;
    const createRetirableScopeLifetime = () => {
      let current = true;
      return {
        retire: () => {
          current = false;
        },
        isCurrent: () => current,
      };
    };
    const overflowLifetime = createRetirableScopeLifetime();
    const directLifetime = createRetirableScopeLifetime();
    const { SessionHeaderActionMenu } = await import('./SessionHeaderActionMenu');

    const screen = await renderScreen(<SessionHeaderActionMenu
      sessionId="sess_1"
      session={{
        id: 'sess_1',
        metadata: {
          machineId: 'machine_source',
          flavor: 'claude',
        },
      } as any}
      pluginUiProjection={pluginUiProjection}
      pluginUiScopedLaunchFacts={pluginHeaderScope}
      pluginUiScopeIsCurrent={overflowLifetime.isCurrent}
      pluginHeaderActions={[headerAction]}
      pluginHeaderActionPlacement="overflow"
    />);

    const dropdown = screen.findByType('DropdownMenu' as any);
    const retiredScopeActionRpcCalls = () => machineRpcCallsWithMethodPrefix(
      RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE,
    );
    const rpcCallsBeforeOverflowPress = retiredScopeActionRpcCalls().length;
    overflowLifetime.retire();
    await act(async () => {
      dropdown.props.onSelect('plugin-ui:sessionHeaderAction:acme.preview:run-preview');
      const pending = fireAndForgetMock.mock.calls.at(-1)?.[0] as Promise<unknown> | undefined;
      await pending;
    });

    expect(retiredScopeActionRpcCalls()).toHaveLength(rpcCallsBeforeOverflowPress);

    await screen.update(<SessionHeaderActionMenu
      sessionId="sess_1"
      session={{
        id: 'sess_1',
        metadata: {
          machineId: 'machine_source',
          flavor: 'claude',
        },
      } as any}
      pluginUiProjection={pluginUiProjection}
      pluginUiScopedLaunchFacts={pluginHeaderScope}
      pluginUiScopeIsCurrent={directLifetime.isCurrent}
      pluginHeaderActions={[headerAction]}
      pluginHeaderActionPlacement="direct"
    />);

    const directAction = screen.findByProps({
      testID: 'session-header-plugin-action-plugin-ui:sessionHeaderAction:acme.preview:run-preview',
    });
    const rpcCallsBeforeDirectPress = retiredScopeActionRpcCalls().length;
    directLifetime.retire();
    await act(async () => {
      directAction.props.onPress();
      const pending = fireAndForgetMock.mock.calls.at(-1)?.[0] as Promise<unknown> | undefined;
      await pending;
    });

    expect(retiredScopeActionRpcCalls()).toHaveLength(rpcCallsBeforeDirectPress);
  });

  it('routes one normalized openSurface descriptor through both overflow and direct header arms', async () => {
    const onOpenPluginSurface = vi.fn(async () => ({
      ok: true as const,
    }));
    const pluginUiProjection = normalizePluginUiProjection({
      v: 2,
      generation: 7,
      installedPackagesById: {},
      agentsById: {},
      actionsById: {},
      toolsById: {},
      commandsById: {},
      resourcesById: {},
      settingsById: {},
      familiesById: {
        pluginUi: {
          family: 'pluginUi',
          entriesById: {
            'sessionHeaderAction:acme.preview:open-preview': {
              id: 'sessionHeaderAction:acme.preview:open-preview',
              pluginId: 'acme.preview',
              occurrenceId: 'acme-preview-occurrence-7',
              contributionKind: 'sessionHeaderAction',
              descriptorId: 'open-preview',
              title: 'Open preview',
              command: {
                kind: 'openSurface',
                destination: { pluginId: 'acme.preview', localId: 'preview' },
              },
            },
          },
        },
      },
      diagnostics: [],
    });
    const headerAction = normalizedPluginHeaderActionPresentation(
      pluginUiProjection,
      'sessionHeaderAction:acme.preview:open-preview',
      'Open preview',
    );
    // openSurface is routed only while the header holds the exact Session scope
    // authority the real header receives; without it the canonical router fails
    // closed as `stale_surface`.
    const pluginHeaderScope = {
      serverId: 'server-projection',
      machineId: 'machine-projection',
      generation: 7,
      interactionEnabled: true,
    } as const;
    const overflowPluginHeaderProps = {
      pluginHeaderActions: [headerAction],
      pluginHeaderActionPlacement: 'overflow' as const,
      pluginUiScopedLaunchFacts: pluginHeaderScope,
    };
    const directPluginHeaderProps = {
      pluginHeaderActions: [headerAction],
      pluginHeaderActionPlacement: 'direct' as const,
      pluginUiScopedLaunchFacts: pluginHeaderScope,
    };
    const { SessionHeaderActionMenu } = await import('./SessionHeaderActionMenu');
    const screen = await renderScreen(<SessionHeaderActionMenu
      sessionId="sess_1"
      session={{
        id: 'sess_1',
        metadata: { machineId: 'machine_source', flavor: 'claude' },
      } as any}
      pluginUiProjection={pluginUiProjection}
      onOpenPluginSurface={onOpenPluginSurface}
      {...overflowPluginHeaderProps}
    />);

    const dropdown = screen.findByType('DropdownMenu' as any);
    await act(async () => {
      dropdown.props.onSelect('plugin-ui:sessionHeaderAction:acme.preview:open-preview');
      const pending = fireAndForgetMock.mock.calls.at(-1)?.[0] as Promise<unknown> | undefined;
      await pending;
    });

    expect(onOpenPluginSurface).toHaveBeenCalledWith({
      destination: { pluginId: 'acme.preview', localId: 'preview' },
    });

    await screen.update(<SessionHeaderActionMenu
      sessionId="sess_1"
      session={{
        id: 'sess_1',
        metadata: { machineId: 'machine_source', flavor: 'claude' },
      } as any}
      pluginUiProjection={pluginUiProjection}
      onOpenPluginSurface={onOpenPluginSurface}
      {...directPluginHeaderProps}
    />);

    const directAction = screen.findByProps({
      testID: 'session-header-plugin-action-plugin-ui:sessionHeaderAction:acme.preview:open-preview',
    });
    await act(async () => {
      directAction.props.onPress();
      const pending = fireAndForgetMock.mock.calls.at(-1)?.[0] as Promise<unknown> | undefined;
      await pending;
    });

    expect(onOpenPluginSurface).toHaveBeenCalledTimes(2);
    expect(onOpenPluginSurface).toHaveBeenLastCalledWith({
      destination: { pluginId: 'acme.preview', localId: 'preview' },
    });
    expect(modalAlertMock).not.toHaveBeenCalled();
  });

  it('surfaces manual mark-unread for read sessions and sends it through the selected server scope', async () => {
    const { SessionHeaderActionMenu } = await import('./SessionHeaderActionMenu');

    const screen = await renderScreen(<SessionHeaderActionMenu
          sessionId="sess_read_header"
          session={{
            id: 'sess_read_header',
            seq: 4,
            lastViewedSessionSeq: 4,
            latestTurnStatus: 'completed',
            serverId: 'server-header',
            metadata: {
              machineId: 'machine_source',
              flavor: 'claude',
            },
          } as any}
        />);

    const dropdown = screen.findByType('DropdownMenu' as any);
    expect(dropdown.props.items.some((item: any) => item?.id === SESSION_ACTION_MARK_UNREAD_ID)).toBe(true);

    await act(async () => {
      dropdown.props.onSelect(SESSION_ACTION_MARK_UNREAD_ID);
    });

    expect(sessionSetManualReadStateWithServerScopeMock).toHaveBeenCalledWith(
      'sess_read_header',
      'unread',
      { serverId: 'server_a' },
    );
  });

  it('does not replace an exact-Home header session with a same-id session from another Home when the menu opens', async () => {
    preferredServerIdState.current = 'home-b';
    storageState.current.sessions = {
      duplicate_session: {
        id: 'duplicate_session',
        serverId: 'home-a',
        seq: 5,
        lastViewedSessionSeq: 0,
        latestTurnStatus: 'completed',
        metadata: { machineId: 'machine-a', flavor: 'claude' },
      },
    };
    const { SessionHeaderActionMenu } = await import('./SessionHeaderActionMenu');
    const screen = await renderScreen(<SessionHeaderActionMenu
      sessionId="duplicate_session"
      session={{
        id: 'duplicate_session',
        serverId: 'home-b',
        seq: 4,
        lastViewedSessionSeq: 4,
        latestTurnStatus: 'completed',
        metadata: { machineId: 'machine-b', flavor: 'claude' },
      } as any}
    />);

    let dropdown = screen.findByType('DropdownMenu' as any);
    await act(async () => {
      dropdown.props.onOpenChange(true);
    });
    dropdown = screen.findByType('DropdownMenu' as any);

    expect(dropdown.props.items.some((item: any) => item?.id === SESSION_ACTION_MARK_UNREAD_ID)).toBe(true);
    expect(dropdown.props.items.some((item: any) => item?.id === SESSION_ACTION_MARK_READ_ID)).toBe(false);
  });

  it('refreshes header read-state actions from row renderable state while the session shell is stable', async () => {
    const sessionShell = {
      id: 'sess_read_header',
      seq: 742,
      lastViewedSessionSeq: 742,
      latestTurnStatus: 'completed',
      serverId: 'server-header',
      metadata: {
        machineId: 'machine_source',
        flavor: 'claude',
      },
    } as any;
    // Rows are Home-scoped, so the resolved Home must be the one the shell
    // belongs to or the header reads no row at all.
    preferredServerIdState.current = 'server-header';
    storageState.current.sessions = {
      sess_read_header: sessionShell,
    };
    storageState.current.sessionListRowsByServerId = {
      'server-header': {
        sess_read_header: {
          ...sessionShell,
          hasUnreadMessages: false,
        },
      },
    };
    storageState.current.ordinarySessionListMembershipByServerId = {
      'server-header': ['sess_read_header'],
    };
    const { SessionHeaderActionMenu } = await import('./SessionHeaderActionMenu');

    const screen = await renderScreen(<SessionHeaderActionMenu
      sessionId="sess_read_header"
      session={sessionShell}
    />);

    let dropdown = screen.findByType('DropdownMenu' as any);
    expect(dropdown.props.items.some((item: any) => item?.id === SESSION_ACTION_MARK_UNREAD_ID)).toBe(true);

    storageState.current.sessionListRowsByServerId = {
      'server-header': {
        sess_read_header: {
          ...sessionShell,
          lastViewedSessionSeq: 741,
          hasUnreadMessages: true,
        },
      },
    };
    await act(async () => {
      notifyStorageListeners();
    });
    await flushHookEffects({ cycles: 1 });

    dropdown = screen.findByType('DropdownMenu' as any);
    expect(dropdown.props.items.some((item: any) => item?.id === SESSION_ACTION_MARK_READ_ID)).toBe(true);
    expect(dropdown.props.items.some((item: any) => item?.id === SESSION_ACTION_MARK_UNREAD_ID)).toBe(false);
  });

  it('uses the canonical session display title as the rename prompt default', async () => {
    const { SessionHeaderActionMenu } = await import('./SessionHeaderActionMenu');

    const screen = await renderScreen(<SessionHeaderActionMenu
          sessionId="sess_rename_header"
          session={{
            id: 'sess_rename_header',
            seq: 0,
            serverId: 'server-header',
            access: createSessionAccessFixture(),
            metadata: {
              machineId: 'machine_source',
              flavor: 'claude',
              summary: { text: 'Canonical summary title', updatedAt: 123 },
            },
          } as any}
        />);

    const dropdown = screen.findByType('DropdownMenu' as any);
    expect(dropdown.props.items.some((item: any) => item?.id === SESSION_ACTION_RENAME_ID)).toBe(true);

    await act(async () => {
      dropdown.props.onSelect(SESSION_ACTION_RENAME_ID);
    });

    expect(modalPromptMock).toHaveBeenCalledWith(
      'sessionInfo.renameSession',
      undefined,
      expect.objectContaining({
        defaultValue: 'Canonical summary title',
      }),
    );
  });

  it('does not surface manual read-state actions from non-terminal raw seq in the header menu', async () => {
    const { SessionHeaderActionMenu } = await import('./SessionHeaderActionMenu');

    const screen = await renderScreen(<SessionHeaderActionMenu
          sessionId="sess_raw_seq_header"
          session={{
            id: 'sess_raw_seq_header',
            seq: 5,
            lastViewedSessionSeq: 4,
            latestTurnStatus: 'in_progress',
            serverId: 'server-header',
            metadata: {
              machineId: 'machine_source',
              flavor: 'claude',
            },
          } as any}
        />);

    const dropdown = screen.findByType('DropdownMenu' as any);
    expect(dropdown.props.items.some((item: any) => item?.id === SESSION_ACTION_MARK_UNREAD_ID || item?.id === SESSION_ACTION_MARK_READ_ID)).toBe(false);
  });

  it('hides manual read-state actions for archived sessions in the header menu', async () => {
    const { SessionHeaderActionMenu } = await import('./SessionHeaderActionMenu');

    const screen = await renderScreen(<SessionHeaderActionMenu
          sessionId="sess_archived_header"
          session={{
            id: 'sess_archived_header',
            seq: 4,
            lastViewedSessionSeq: 4,
            archivedAt: 10,
            metadata: {
              machineId: 'machine_source',
              flavor: 'claude',
            },
          } as any}
        />);

    const dropdown = screen.findByType('DropdownMenu' as any);
    expect(dropdown.props.items.some((item: any) => item?.id === SESSION_ACTION_MARK_UNREAD_ID || item?.id === SESSION_ACTION_MARK_READ_ID)).toBe(false);
  });

  it('threads the preferred session server id into the default action executor server lookup', async () => {
    preferredServerIdState.current = 'server-explicit';
    resolveSessionTargetServerIdMock.mockImplementation((_sessionId: string, fallbackServerId?: string | null) => fallbackServerId ?? null);
    const { SessionHeaderActionMenu } = await import('./SessionHeaderActionMenu');

    const screen = await renderScreen(<SessionHeaderActionMenu
          sessionId="sess_1"
          session={{
            id: 'sess_1',
            serverId: 'server-explicit',
            metadata: {
              machineId: 'machine_source',
              flavor: 'claude',
            },
          } as any}
        />);

    expect(screen.findByType('DropdownMenu' as any)).toBeTruthy();
    expect(resolveSessionTargetServerIdMock).toHaveBeenCalledWith('sess_1', 'server-explicit');
    expect(createDefaultActionExecutorMock).toHaveBeenCalledTimes(1);
    const executorConfig = createDefaultActionExecutorMock.mock.calls[0]?.[0] as {
      resolveServerIdForSessionId: (sessionId: string) => string | null;
      openSession: (sessionId: string, options?: { serverId?: string | null }) => void;
    };
    expect(executorConfig.resolveServerIdForSessionId('sess_1')).toBe('server-explicit');
    await executorConfig.openSession('sess_child', { serverId: 'server-explicit' });
    expect(sessionActionsModuleState.routerPushSpy).toHaveBeenCalledWith('/session/sess_child?serverId=server-explicit');

    preferredServerIdState.current = 'server-updated';
    await screen.update(<SessionHeaderActionMenu
          sessionId="sess_1"
          session={{
            id: 'sess_1',
            serverId: 'server-explicit-rerender',
            metadata: {
              machineId: 'machine_source',
              flavor: 'claude',
            },
          } as any}
        />);

    expect(createDefaultActionExecutorMock).toHaveBeenCalledTimes(2);
    const updatedExecutorConfig = createDefaultActionExecutorMock.mock.calls.at(-1)?.[0] as {
      resolveServerIdForSessionId: (sessionId: string) => string | null;
    };
    expect(updatedExecutorConfig.resolveServerIdForSessionId('sess_1')).toBe('server-updated');

  });

  it('opens the fork strategy modal from the header menu and issues no fork effect', async () => {
    canForkConversationState.current = true;
    preferredServerIdState.current = 'server-explicit';
    const { SessionHeaderActionMenu } = await import('./SessionHeaderActionMenu');

    const screen = await renderScreen(<SessionHeaderActionMenu
          sessionId="sess_parent"
          session={{
            id: 'sess_parent',
            serverId: 'server-explicit',
            metadata: {
              machineId: 'machine_source',
              flavor: 'claude',
            },
          } as any}
        />);

    const dropdown = screen.findByType('DropdownMenu' as any);
    expect(dropdown.props.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'session.fork' }),
      ]),
    );

    await act(async () => {
      dropdown.props.onSelect('session.fork');
      // The header defers modal presentation past the current web press dispatch.
      await new Promise((resolve) => setTimeout(resolve, 0));
      await flushHookEffects();
    });

    expect(openSessionForkStrategyFlowMock).toHaveBeenCalledTimes(1);
    const flowArgs = openSessionForkStrategyFlowMock.mock.calls[0]?.[0] as any;
    expect(flowArgs).toMatchObject({
      sessionId: 'sess_parent',
      serverId: 'server-explicit',
      forkPoint: { type: 'latest' },
    });
    expect(typeof flowArgs.navigateToSession).toBe('function');
    expect(typeof flowArgs.navigateToNewSession).toBe('function');
    // The launcher must not also run the old auto-strategy fork behind the modal.
    const forkRpcCalls = machineRpcWithServerScopeMock.mock.calls.filter(
      (call) => String((call[0] as { method?: unknown } | undefined)?.method ?? '').includes('session.fork'),
    );
    expect(forkRpcCalls).toHaveLength(0);
  });

  it('routes a fork child opened from the strategy modal through the scoped session href', async () => {
    canForkConversationState.current = true;
    preferredServerIdState.current = 'server-explicit';
    const { SessionHeaderActionMenu } = await import('./SessionHeaderActionMenu');

    const screen = await renderScreen(<SessionHeaderActionMenu
          sessionId="sess_parent"
          session={{
            id: 'sess_parent',
            serverId: 'server-explicit',
            metadata: { machineId: 'machine_source', flavor: 'claude' },
          } as any}
        />);
    const dropdown = screen.findByType('DropdownMenu' as any);
    await act(async () => {
      dropdown.props.onSelect('session.fork');
      await new Promise((resolve) => setTimeout(resolve, 0));
      await flushHookEffects();
    });

    const flowArgs = openSessionForkStrategyFlowMock.mock.calls[0]?.[0] as any;
    await act(async () => { await flowArgs.navigateToSession('sess_child'); });
    expect(sessionActionsModuleState.routerPushSpy)
      .toHaveBeenCalledWith('/session/sess_child?serverId=server-explicit');
  });

  it('fails closed (does not surface session.handoff) when machine transfer is disabled on the selected server', async () => {
    const { FeaturesResponseSchema } = await import('@happier-dev/protocol');
    serverSnapshotState.current = {
      status: 'ready',
      features: FeaturesResponseSchema.parse({
        features: {
          sessions: { enabled: true, handoff: { enabled: true } },
          machines: {
            enabled: true,
            transfer: {
              enabled: false,
              directPeer: { enabled: false },
              serverRouted: { enabled: false },
            },
          },
        },
        capabilities: {},
      }),
    } as any;

    const { SessionHeaderActionMenu } = await import('./SessionHeaderActionMenu');

    const screen = await renderScreen(<SessionHeaderActionMenu
          sessionId="sess_1"
          session={{
            id: 'sess_1',
            metadata: {
              machineId: 'machine_source',
              flavor: 'claude',
            },
          } as any}
        />);

    const dropdown = screen.findByType('DropdownMenu' as any);
    expect(Array.isArray(dropdown.props.items)).toBe(true);
    expect(dropdown.props.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'session.handoff',
          disabled: true,
          subtitle: 'common.unavailable',
        }),
      ]),
    );
  });

  it('fails closed when direct peer is runtime-unknown and the selected server only exposes direct-peer handoff transport', async () => {
    const { FeaturesResponseSchema } = await import('@happier-dev/protocol');
    serverSnapshotState.current = {
      status: 'ready',
      features: FeaturesResponseSchema.parse({
        features: {
          sessions: { enabled: true, handoff: { enabled: true } },
          machines: {
            enabled: true,
            transfer: {
              enabled: true,
              directPeer: { enabled: true },
              serverRouted: { enabled: false },
            },
          },
        },
        capabilities: {},
      }),
    } as any;

    const { SessionHeaderActionMenu } = await import('./SessionHeaderActionMenu');

    const screen = await renderScreen(<SessionHeaderActionMenu
          sessionId="sess_1"
          session={{
            id: 'sess_1',
            metadata: {
              machineId: 'machine_source',
              flavor: 'claude',
            },
          } as any}
        />);

    const dropdown = screen.findByType('DropdownMenu' as any);
    expect(Array.isArray(dropdown.props.items)).toBe(true);
    expect(dropdown.props.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'session.handoff',
          disabled: true,
          subtitle: 'common.unavailable',
        }),
      ]),
    );
  });

  it('fails closed when direct peer viability is runtime-unknown and the selected server would otherwise downgrade through server-routed fallback', async () => {
    const { FeaturesResponseSchema } = await import('@happier-dev/protocol');
    serverSnapshotState.current = {
      status: 'ready',
      features: FeaturesResponseSchema.parse({
        features: {
          sessions: { enabled: true, handoff: { enabled: true } },
          machines: {
            enabled: true,
            transfer: {
              enabled: true,
              directPeer: { enabled: true },
              serverRouted: { enabled: true },
            },
          },
        },
        capabilities: {},
      }),
    } as any;

    const { SessionHeaderActionMenu } = await import('./SessionHeaderActionMenu');

    const screen = await renderScreen(<SessionHeaderActionMenu
          sessionId="sess_1"
          session={{
            id: 'sess_1',
            metadata: {
              machineId: 'machine_source',
              flavor: 'claude',
            },
          } as any}
        />);

    const dropdown = screen.findByType('DropdownMenu' as any);
    expect(Array.isArray(dropdown.props.items)).toBe(true);
    expect(dropdown.props.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'session.handoff',
          disabled: true,
          subtitle: 'common.unavailable',
        }),
      ]),
    );
  });

  // Server-routed transport does not depend on direct-peer viability, so the
  // canonical availability owner (`resolveSessionHandoffUiAvailability`)
  // negotiates `server_routed_stream` and reports the entry point as available.
  // The header must project that decision, not keep a stricter second reading.
  it('keeps session.handoff enabled when the selected server only offers server-routed handoff transport', async () => {
    const { FeaturesResponseSchema } = await import('@happier-dev/protocol');
    serverSnapshotState.current = {
      status: 'ready',
      features: FeaturesResponseSchema.parse({
        features: {
          sessions: { enabled: true, handoff: { enabled: true } },
          machines: {
            enabled: true,
            transfer: {
              enabled: true,
              directPeer: { enabled: false },
              serverRouted: { enabled: true },
            },
          },
        },
        capabilities: {},
      }),
    } as any;

    const { SessionHeaderActionMenu } = await import('./SessionHeaderActionMenu');

    const screen = await renderScreen(<SessionHeaderActionMenu
          sessionId="sess_1"
          session={{
            id: 'sess_1',
            metadata: {
              machineId: 'machine_source',
              flavor: 'claude',
            },
          } as any}
        />);

    const dropdown = screen.findByType('DropdownMenu' as any);
    expect(Array.isArray(dropdown.props.items)).toBe(true);
    const handoffItem = dropdown.props.items.find((item: any) => item?.id === 'session.handoff');
    expect(handoffItem).toBeDefined();
    expect(handoffItem?.disabled).not.toBe(true);
    expect(handoffItem?.subtitle).not.toBe('common.unavailable');
  });

  it('reacts when machine-rpc direct-peer viability becomes available after mount', async () => {
    preferredServerIdState.current = 'server_reactive_header';

    const { SessionHeaderActionMenu } = await import('./SessionHeaderActionMenu');

    const screen = await renderScreen(<SessionHeaderActionMenu
          sessionId="sess_1"
          session={{
            id: 'sess_1',
            metadata: {
              machineId: 'machine_source',
              flavor: 'claude',
            },
          } as any}
        />);

    let dropdown = screen.findByType('DropdownMenu' as any);
    expect(dropdown.props.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'session.handoff',
          disabled: true,
          subtitle: 'common.unavailable',
        }),
      ]),
    );

    const { recordCachedMachineRpcDirectRouteViable } = await import('@/sync/domains/transfers/runtime/transferRouteCache');
    await act(async () => {
      recordCachedMachineRpcDirectRouteViable({
        serverId: 'server_reactive_header',
        remoteMachineId: 'machine_source',
      });
    });
    await flushHookEffects({ cycles: 1 });

    dropdown = screen.findByType('DropdownMenu' as any);
    expect(dropdown.props.items.some((item: any) => item?.id === 'session.handoff')).toBe(true);
  });

  it('does not launch the handoff picker flow when session.handoff stays disabled by the canonical availability model', async () => {
    const { FeaturesResponseSchema } = await import('@happier-dev/protocol');
    serverSnapshotState.current = {
      status: 'ready',
      features: FeaturesResponseSchema.parse({
        features: {
          sessions: { enabled: true, handoff: { enabled: true } },
          machines: {
            enabled: true,
            transfer: {
              enabled: false,
              directPeer: { enabled: false },
              serverRouted: { enabled: false },
            },
          },
        },
        capabilities: {},
      }),
    } as any;

    const { SessionHeaderActionMenu } = await import('./SessionHeaderActionMenu');

    const screen = await renderScreen(<SessionHeaderActionMenu
          sessionId="sess_1"
          session={{
            id: 'sess_1',
            metadata: {
              machineId: 'machine_source',
              flavor: 'claude',
            },
          } as any}
        />);

    const dropdown = screen.findByType('DropdownMenu' as any);
    await act(async () => {
      dropdown.props.onSelect('session.handoff');
    });
    await flushHookEffects({ cycles: 1 });

    expect(runSessionHandoffPickerFlowMock).not.toHaveBeenCalled();
  });

  it('surfaces session.handoff when source reachability is proven through server-scoped rpc even without a cached direct route', async () => {
    preferredServerIdState.current = 'server_scoped_only';
    readMachineTargetForSessionMock.mockReturnValue({
      machineId: 'machine_scoped',
      basePath: '/workspace/repo',
    });
    machineRpcWithServerScopeMock.mockResolvedValue({ ok: true });
    storageState.current = {
      ...storageState.current,
      machineListByServerId: {
        server_scoped_only: [{
          id: 'machine_scoped',
          daemonState: buildConfiguredInactiveDaemonTransferState(),
        }],
      },
    };

    const { SessionHeaderActionMenu } = await import('./SessionHeaderActionMenu');

    const screen = await renderScreen(<SessionHeaderActionMenu
          sessionId="sess_1"
          session={{
            id: 'sess_1',
            metadata: {
              machineId: 'machine_source',
              flavor: 'claude',
            },
          } as any}
        />);

    await flushHookEffects({ cycles: 2 });

    const dropdown = screen.findByType('DropdownMenu' as any);
    expect(dropdown.props.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'session.handoff',
        }),
      ]),
    );
    expect(dropdown.props.items.find((item: any) => item?.id === 'session.handoff')?.disabled).not.toBe(true);
  });

  it('keeps session.handoff enabled and executable for a layout-v1 session whose owner metadata view has not landed yet', async () => {
    // Cold owner projection: the layout is understood, but this device cannot read the owner view
    // for this session yet. The reachable machine target is already canonical, so the entry point
    // must not refuse the session — the daemon corridor stays the qualifying authority.
    reachableMachineTargetState.current = {
      machineId: 'machine_rebound',
      basePath: '/workspace/repo',
    };
    readMachineTargetForSessionMock.mockReturnValue(null);
    const { SessionHeaderActionMenu } = await import('./SessionHeaderActionMenu');
    const { recordCachedMachineRpcDirectRouteViable } = await import('@/sync/domains/transfers/runtime/transferRouteCache');
    recordCachedMachineRpcDirectRouteViable({
      serverId: 'server_a',
      remoteMachineId: 'machine_rebound',
    });

    const screen = await renderScreen(<SessionHeaderActionMenu
          sessionId="sess_1"
          session={{
            id: 'sess_1',
            serverId: 'server_a',
            metadataLayoutVersion: 1,
            metadata: {
              machineId: 'machine_stale_layout0',
              flavor: 'claude',
            },
            ownerMetadataView: null,
          } as any}
        />);

    const dropdown = screen.findByType('DropdownMenu' as any);
    expect(dropdown.props.items.find((item: any) => item?.id === 'session.handoff')?.disabled).not.toBe(true);

    vi.useFakeTimers();
    try {
      await act(async () => {
        dropdown.props.onSelect('session.handoff');
      });
      await act(async () => {
        await vi.runAllTimersAsync();
      });
    } finally {
      vi.useRealTimers();
    }
    await flushHookEffects({ cycles: 1 });

    expect(runSessionHandoffPickerFlowMock).toHaveBeenCalledWith({
      execute: expect.any(Function),
      sessionId: 'sess_1',
      sourceMachineId: 'machine_rebound',
      serverId: 'server_a',
      placement: 'session_action_menu',
    });
  });

  it('surfaces session.handoff when the preferred session server id is resolved for the current session', async () => {
    preferredServerIdState.current = 'server_preferred_header';
    readMachineTargetForSessionMock.mockReturnValue({
      machineId: 'machine_scoped',
      basePath: '/workspace/repo',
    });
    machineRpcWithServerScopeMock.mockResolvedValue({ ok: true });

    const { SessionHeaderActionMenu } = await import('./SessionHeaderActionMenu');

    const screen = await renderScreen(<SessionHeaderActionMenu
          sessionId="sess_1"
          session={{
            id: 'sess_1',
            metadata: {
              machineId: 'machine_source',
              flavor: 'claude',
            },
          } as any}
        />);

    await flushHookEffects({ cycles: 2 });

    const dropdown = screen.findByType('DropdownMenu' as any);
    expect(dropdown.props.items.some((item: any) => item?.id === 'session.handoff')).toBe(true);
  });

  it('falls back to the canonical session target server resolver when the preferred server hook is empty', async () => {
    preferredServerIdState.current = null;
    resolveSessionTargetServerIdMock.mockReturnValue('server_canonical_header');
    readMachineTargetForSessionMock.mockReturnValue({
      machineId: 'machine_scoped',
      basePath: '/workspace/repo',
    });
    machineRpcWithServerScopeMock.mockResolvedValue({ ok: true });

    const { SessionHeaderActionMenu } = await import('./SessionHeaderActionMenu');

    const screen = await renderScreen(<SessionHeaderActionMenu
          sessionId="sess_1"
          session={{
            id: 'sess_1',
            metadata: {
              machineId: 'machine_source',
              flavor: 'claude',
            },
          } as any}
        />);

    await flushHookEffects({ cycles: 2 });

    expect(resolveSessionTargetServerIdMock).toHaveBeenCalledWith('sess_1', null);
    const dropdown = screen.findByType('DropdownMenu' as any);
    expect(dropdown.props.items.some((item: any) => item?.id === 'session.handoff')).toBe(true);
  });

  it('recomputes session.handoff availability when a reachable machine target appears after the initial render', async () => {
    storageState.current = {
      ...storageState.current,
      sessions: {
        sess_1: {
          id: 'sess_1',
          seq: 0,
          encryptionMode: 'plain',
          presence: 'offline',
          active: true,
          accessLevel: 'edit',
          metadata: {
            flavor: 'claude',
            claudeSessionId: 'claude_session_1',
            path: '/workspace/repo',
            homeDir: '/workspace',
          },
        } as any,
      },
      machines: {},
    };
    allSessionsState.current = Object.values(storageState.current.sessions);
    allMachinesState.current = [];
    reachableMachineTargetState.current = null;
    preferredServerIdState.current = 'server_a';

    const { SessionHeaderActionMenu } = await import('./SessionHeaderActionMenu');

    const screen = await renderScreen(<SessionHeaderActionMenu
          sessionId="sess_1"
          session={storageState.current.sessions.sess_1 as any}
        />);

    let dropdown = screen.findByType('DropdownMenu' as any);
    expect(dropdown.props.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'session.handoff',
          disabled: true,
        }),
      ]),
    );

    storageState.current = {
      ...storageState.current,
      sessions: {
        ...storageState.current.sessions,
        sess_2: {
          id: 'sess_2',
          seq: 1,
          encryptionMode: 'plain',
          presence: 'offline',
          active: true,
          accessLevel: 'edit',
          metadata: {
            flavor: 'claude',
            machineId: 'machine_rebound',
            path: '/workspace/repo',
            homeDir: '/workspace',
          },
        } as any,
      },
      machines: {
        machine_rebound: {
          id: 'machine_rebound',
          active: true,
          activeAt: 1,
          metadata: { host: 'lima-vm' },
        },
      },
    };
    allSessionsState.current = Object.values(storageState.current.sessions);
    allMachinesState.current = Object.values(storageState.current.machines);
    readMachineTargetForSessionMock.mockReturnValue(null);
    reachableMachineTargetState.current = {
      machineId: 'machine_rebound',
      basePath: '/workspace/repo',
    };
    const { recordCachedMachineRpcDirectRouteViable } = await import('@/sync/domains/transfers/runtime/transferRouteCache');
    recordCachedMachineRpcDirectRouteViable({
      serverId: 'server_a',
      remoteMachineId: 'machine_rebound',
    });

    await screen.update(<SessionHeaderActionMenu
          sessionId="sess_1"
          session={storageState.current.sessions.sess_1 as any}
        />);
    await flushHookEffects({ cycles: 10 });

    dropdown = screen.findByType('DropdownMenu' as any);
    expect(dropdown.props.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'session.handoff' }),
      ]),
    );
  });

  it('seeds configured ACP backend targets into non-handoff action drafts', async () => {
    resolveSessionActionDefaultBackendMock.mockReturnValue({
      backendTarget: { kind: 'configuredAcpBackend', backendId: 'acp-backend' },
      defaultBackendId: 'claude',
    });

    const { SessionHeaderActionMenu } = await import('./SessionHeaderActionMenu');

    const screen = await renderScreen(<SessionHeaderActionMenu
          sessionId="sess_1"
          session={{
            id: 'sess_1',
            metadata: {
              flavor: 'customAcp',
              acpConfiguredBackendV1: {
                v: 1,
                updatedAt: 1,
                backendId: 'acp-backend',
                title: 'Review Bot',
              },
            },
          } as any}
          // Draft-producing Session actions require the exact route Account
          // authority the real header receives from `SessionView`.
          actionAccountLifetime={{
            scope: { serverId: 'server_a', accountId: 'account_a' },
            isCurrent: () => true,
            onRetire: () => ({ dispose() {} }),
          }}
        />);

    const dropdown = screen.findByType('DropdownMenu' as any);
    await act(async () => {
      dropdown.props.onSelect('subagents.plan.start');
    });
    await flushHookEffects({ cycles: 1 });

    expect(buildActionDraftInputMock).toHaveBeenCalledWith(expect.objectContaining({
      actionId: 'subagents.plan.start',
      sessionId: 'sess_1',
      defaultBackendTarget: { kind: 'configuredAcpBackend', backendId: 'acp-backend' },
      defaultBackendId: 'claude',
      instructions: '',
    }));
    expect(createSessionActionDraftMock).toHaveBeenCalledWith(
      { serverId: 'server_a', accountId: 'account_a' },
      { serverId: 'server_a', sessionId: 'sess_1' },
      {
      actionId: 'subagents.plan.start',
      input: { draft: true },
      },
    );
  });

  it('adds a teleport action when the global daemon voice conversation exists only in shared session state', async () => {
    voiceSettingState.current = {
      providerId: 'local_conversation',
      ui: { scopeDefault: 'global', surfaceLocation: 'auto', activityFeedEnabled: false },
      providers: {
        local_conversation: { schemaVersion: 1, config: {
          conversationMode: 'agent',
          agent: { backend: 'daemon', stayInVoiceHome: false, teleportEnabled: true },
        } },
      },
    };
    storageState.current.settings.voice = voiceSettingState.current;
    // The Voice owner-metadata reader is Home-scoped and, for a session it can
    // see locally, addresses it on the active Home. A shared system session
    // filed under any other Home is simply not the one this device would read,
    // so the fixture files it where the reader looks.
    const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
    storageState.current.sessions = {
      sys_voice: {
        id: 'sys_voice',
        serverId: getActiveServerSnapshot().serverId,
        active: true,
        updatedAt: 10,
        metadata: {
          systemSessionV1: { v: 1, key: 'voice_conversation', hidden: true },
        },
      },
    };
    voiceSessionSnapshotState.current = {
      adapterId: null,
      sessionId: null,
      status: 'disconnected',
      mode: 'idle',
      canStop: false,
    };

    const { SessionHeaderActionMenu } = await import('./SessionHeaderActionMenu');

    const screen = await renderScreen(<SessionHeaderActionMenu
          sessionId="sess_1"
          session={{
            id: 'sess_1',
            metadata: {
              machineId: 'machine_source',
              flavor: 'codex',
            },
          } as any}
        />);

    const dropdown = screen.findByType('DropdownMenu' as any);
    expect(dropdown.props.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'voice.teleport',
          title: 'voiceSurface.a11y.teleport',
        }),
      ]),
    );
  });

  it('does not surface background follow for a linked session without an explicit projected source opt-in', async () => {
    storageState.current.sessions = {
      s1: {
        id: 's1',
        seq: 0,
        encryptionMode: 'plain',
        presence: 'offline',
        active: true,
        accessLevel: 'edit',
        canApprovePermissions: false,
        metadata: {
          machineId: 'machine-1',
          host: 'happy-host',
          flavor: 'codex',
          version: '0.0.0',
          path: '/tmp',
          homeDir: '/tmp',
          externalSessionV1: {
            v: 1,
            agentId: 'codex',
            machineId: 'machine-1',
            remoteSessionId: 'vendor-session-1',
            source: { kind: 'codexHome', home: 'user' },
            followPolicyV1: { v: 1, policy: 'attached_only' },
          },
        },
      } as any,
    };
    const { SessionHeaderActionMenu } = await import('./SessionHeaderActionMenu');

    const screen = await renderScreen(<SessionHeaderActionMenu
          sessionId="s1"
          session={storageState.current.sessions.s1 as any}
        />);

    const dropdown = screen.findByType('DropdownMenu' as any);
    expect(dropdown.props.items.find((item: { id: string }) => item.id === 'session.externalSession.backgroundFollow')).toBeUndefined();
    // Publishing the menu must not probe or mutate External Session follow
    // state. Unrelated handoff-reachability traffic on the same transport is
    // not evidence about this contract.
    expect(machineRpcCallsWithMethodPrefix(EXTERNAL_SESSION_RPC_METHOD_PREFIX)).toHaveLength(0);
  });

  it('does not infer background follow from a session flavor when the linked source has no projection opt-in', async () => {
    storageState.current.sessions = {
      s1: {
        id: 's1',
        seq: 0,
        encryptionMode: 'plain',
        presence: 'offline',
        active: true,
        accessLevel: 'edit',
        canApprovePermissions: false,
        metadata: {
          machineId: 'machine-1',
          host: 'happy-host',
          flavor: 'opencode',
          version: '0.0.0',
          path: '/tmp',
          homeDir: '/tmp',
          runtimeDescriptorV1: {
            v: 1,
            agentId: 'opencode',
            agent: { backendMode: 'appServer', providerSessionId: 'opencode-session-1' },
          },
          externalSessionV1: {
            v: 1,
            agentId: 'codex',
            machineId: 'machine-1',
            remoteSessionId: 'vendor-session-1',
            source: { kind: 'codexHome', home: 'user' },
            followPolicyV1: { v: 1, policy: 'attached_only' },
          },
        },
      } as any,
    };

    const { SessionHeaderActionMenu } = await import('./SessionHeaderActionMenu');

    const screen = await renderScreen(<SessionHeaderActionMenu
          sessionId="s1"
          session={storageState.current.sessions.s1 as any}
        />);

    const dropdown = screen.findByType('DropdownMenu' as any);

    expect(dropdown.props.items.find((item: { id: string }) => item.id === 'session.externalSession.backgroundFollow')).toBeUndefined();
  });

  it('surfaces a disable toggle when background follow is already enabled and turns it off on select', async () => {
    daemonMergedProjectionState.current = {
      phase: 'ready',
      inputs: { pluginProjectionV2: createDeclaredCodexSourceProjection() },
    };
    storageState.current.sessions = {
      s1: {
        id: 's1',
        seq: 0,
        encryptionMode: 'plain',
        presence: 'offline',
        active: true,
        accessLevel: 'edit',
        canApprovePermissions: false,
        metadata: {
          machineId: 'machine-1',
          host: 'happy-host',
          flavor: 'codex',
          version: '0.0.0',
          path: '/tmp',
          homeDir: '/tmp',
          externalSessionV1: {
            v: 1,
            agentId: 'codex',
            machineId: 'machine-1',
            remoteSessionId: 'vendor-session-1',
            source: { kind: 'codexHome', home: 'user' },
            followPolicyV1: { v: 1, policy: 'background_follow' },
          },
        },
      } as any,
    };
    machineRpcWithServerScopeMock.mockImplementation(async (request: { method?: string }) => {
      if (request.method === RPC_METHODS.DAEMON_EXTERNAL_SESSION_BACKGROUND_FOLLOW_SET) {
        return {
          ok: true,
          enabled: false,
          leaseActive: false,
          updatedAtMs: 2,
        };
      }
      throw new Error('unreachable');
    });

    const { SessionHeaderActionMenu } = await import('./SessionHeaderActionMenu');
    const { registerStorageStateReader } = await import('@/sync/domains/state/storageStateReaderBridge');
    registerStorageStateReader(() => storageState.current as any);

    const screen = await renderScreen(<SessionHeaderActionMenu
          sessionId="s1"
          session={storageState.current.sessions.s1 as any}
        />);

    const dropdown = screen.findByType('DropdownMenu' as any);
    expect(dropdown.props.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'session.externalSession.backgroundFollow',
          title: 'session.actionMenu.backgroundFollow',
          subtitle: 'common.enabled',
        }),
      ]),
    );

    respondToMachineRpcMethod(EXTERNAL_SESSION_FOLLOW_SET_METHOD, () => ({
      ok: true,
      enabled: false,
      leaseActive: false,
      updatedAtMs: 2,
    }));
    await act(async () => {
      dropdown.props.onSelect('session.externalSession.backgroundFollow');
      // Settle the exact dispatched mutation instead of guessing a tick budget.
      const pending = fireAndForgetMock.mock.calls.at(-1)?.[0] as Promise<unknown> | undefined;
      await pending;
    });

    expect(patchSessionMetadataWithRetryMock).not.toHaveBeenCalled();
    expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'machine-1',
      serverId: 'server_a',
      method: 'daemon.externalSessions.backgroundFollow.set',
      payload: expect.objectContaining({
        sessionId: 's1',
        agentId: 'codex',
        remoteSessionId: 'vendor-session-1',
        enabled: false,
      }),
    }));
    expect(modalAlertMock).not.toHaveBeenCalled();
    expect(applySessionMetadataLocallyMock).toHaveBeenCalledWith('s1', expect.any(Function));
    expect((storageState.current.sessions.s1 as any).metadata.externalSessionV1.followPolicyV1).toEqual({
      v: 1,
      policy: 'attached_only',
      updatedAtMs: 2,
    });
  });

  it('silently retires a late follow settlement when the active Account is no longer current', async () => {
    daemonMergedProjectionState.current = {
      phase: 'ready',
      inputs: { pluginProjectionV2: createDeclaredCodexSourceProjection() },
    };
    storageState.current.sessions = {
      s1: {
        id: 's1',
        seq: 0,
        encryptionMode: 'plain',
        presence: 'offline',
        active: true,
        accessLevel: 'edit',
        canApprovePermissions: false,
        metadata: {
          machineId: 'machine-1',
          host: 'happy-host',
          flavor: 'codex',
          version: '0.0.0',
          path: '/tmp',
          homeDir: '/tmp',
          externalSessionV1: {
            v: 1,
            agentId: 'codex',
            machineId: 'machine-1',
            remoteSessionId: 'vendor-session-1',
            source: { kind: 'codexHome', home: 'user' },
            followPolicyV1: { v: 1, policy: 'attached_only' },
          },
        },
      } as any,
    };

    const { SessionHeaderActionMenu } = await import('./SessionHeaderActionMenu');
    const { registerStorageStateReader } = await import('@/sync/domains/state/storageStateReaderBridge');
    registerStorageStateReader(() => storageState.current as any);

    const screen = await renderScreen(<SessionHeaderActionMenu
          sessionId="s1"
          session={storageState.current.sessions.s1 as any}
        />);

    const dropdown = screen.findByType('DropdownMenu' as any);
    let resolveFollowPolicySet: ((value: unknown) => void) | undefined;
    respondToMachineRpcMethod(
      EXTERNAL_SESSION_FOLLOW_SET_METHOD,
      () => new Promise((resolve) => {
        resolveFollowPolicySet = resolve;
      }),
    );

    await act(async () => {
      dropdown.props.onSelect('session.externalSession.backgroundFollow');
      for (let i = 0; i < 10; i++) await Promise.resolve();
    });
    // The follow mutation is actually in flight through the canonical machine
    // RPC transport.
    expect(resolveFollowPolicySet).toBeDefined();
    // Account A retires while the machine RPC is in flight; the late
    // settlement must not alert or publish into the successor Account.
    accountCurrentnessState.current = false;
    await act(async () => {
      resolveFollowPolicySet?.({
        ok: true,
        enabled: true,
        leaseActive: true,
        updatedAtMs: 7,
      });
      for (let i = 0; i < 10; i++) await Promise.resolve();
      await flushHookEffects({ cycles: 2, turns: 1 });
    });

    expect(applySessionMetadataLocallyMock).not.toHaveBeenCalled();
    expect(modalAlertMock).not.toHaveBeenCalled();
  });

  it('does not surface background follow for direct-session agents without follow support', async () => {
    storageState.current.sessions = {
      s1: {
        id: 's1',
        seq: 0,
        encryptionMode: 'plain',
        presence: 'offline',
        active: true,
        accessLevel: 'edit',
        canApprovePermissions: false,
        metadata: {
          machineId: 'machine-1',
          host: 'happy-host',
          flavor: 'opencode',
          version: '0.0.0',
          path: '/tmp',
          homeDir: '/tmp',
          externalSessionV1: {
            v: 1,
            agentId: 'opencode',
            machineId: 'machine-1',
            remoteSessionId: 'vendor-session-1',
            source: { kind: 'opencodeServer', directory: '/tmp' },
            followPolicyV1: { v: 1, policy: 'attached_only' },
          },
        },
      } as any,
    };

    const { SessionHeaderActionMenu } = await import('./SessionHeaderActionMenu');

    const screen = await renderScreen(<SessionHeaderActionMenu
          sessionId="s1"
          session={storageState.current.sessions.s1 as any}
        />);

    const dropdown = screen.findByType('DropdownMenu' as any);
    expect(dropdown.props.items.find((item: { id: string }) => item.id === 'session.externalSession.backgroundFollow')).toBeUndefined();
  });

  it('drops execution-run menu items after execution runs are disabled in settings', async () => {
    const { recordCachedMachineRpcDirectRouteViable } = await import('@/sync/domains/transfers/runtime/transferRouteCache');
    recordCachedMachineRpcDirectRouteViable({
      serverId: 'server_a',
      remoteMachineId: 'machine_source',
    });
    const { SessionHeaderActionMenu } = await import('./SessionHeaderActionMenu');

    const screen = await renderScreen(<SessionHeaderActionMenu
          sessionId="sess_1"
          session={{
            id: 'sess_1',
            metadata: {
              machineId: 'machine_source',
              flavor: 'claude',
            },
          } as any}
        />);

    let dropdown = screen.findByType('DropdownMenu' as any);
    expect(dropdown.props.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'subagents.plan.start',
          title: 'Start plan run',
        }),
      ]),
    );

    storageState.current = {
      ...storageState.current,
      settings: {
        ...storageState.current.settings,
        experiments: false,
        featureToggles: {},
      },
    };

    await act(async () => {
      dropdown.props.onOpenChange(true);
    });
    await flushHookEffects({ cycles: 1 });

    dropdown = screen.findByType('DropdownMenu' as any);
    expect(dropdown.props.items).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'subagents.plan.start',
        }),
      ]),
    );
  });
});
