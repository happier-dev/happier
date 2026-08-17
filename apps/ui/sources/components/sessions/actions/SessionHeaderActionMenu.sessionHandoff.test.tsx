import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createDeferred, flattenTestStyle, flushHookEffects, renderScreen } from '@/dev/testkit';
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
    sessionListRenderables: {} as Record<string, any>,
    sessionListRowStateByServerId: {} as Record<string, Record<string, any>>,
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

function createExplicitTerminalFollowProjection() {
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
            terminalFollow: { userRowClassification: 'explicitV1' },
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

vi.mock('@/sync/domains/settings/actionsSettings', () => ({
  isActionEnabledInState: (state: any, actionId: string) => {
    const executionRunsEnabled =
      state?.settings?.experiments === true &&
      state?.settings?.featureToggles?.['execution.runs'] === true;
    if (actionId === 'review.start' || actionId === 'subagents.plan.start' || actionId === 'subagents.delegate.start') {
      return executionRunsEnabled;
    }
    return true;
  },
}));

vi.mock('@/sync/domains/actions/buildActionDraftInput', () => ({
  buildActionDraftInput: buildActionDraftInputMock,
}));

vi.mock('@/utils/system/fireAndForget', () => ({
  fireAndForget: (promise: Promise<unknown>, _opts?: unknown) => {
    fireAndForgetMock(promise);
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

vi.mock('@/sync/domains/sessionHandoff/handoffUiSupport', () => ({
  canHandoffConversation: () => true,
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

vi.mock('@/sync/domains/session/resolveSessionActionDefaultBackend', () => ({
  resolveSessionActionDefaultBackend: (...args: unknown[]) => resolveSessionActionDefaultBackendMock(...args),
}));

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
    storageListeners.current.clear();
    patchSessionMetadataWithRetryMock.mockReset();
    applySessionMetadataLocallyMock.mockReset();
    readMachineTargetForSessionMock.mockReturnValue(null);
    machineRpcWithServerScopeMock.mockRejectedValue(new Error('unreachable'));
    canForkConversationState.current = false;
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
      sessionListRenderables: {},
      sessionListRowStateByServerId: {},
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
    const { registerStorageStateReader } = await import('@/sync/domains/state/storageStateReaderBridge');
    registerStorageStateReader(() => storageState.current as any);
    const { voiceSessionBindingStore } = await import('@/voice/binding/voiceConversationBindingStore');
    for (const binding of voiceSessionBindingStore.getState().list()) {
      voiceSessionBindingStore.getState().unbind(binding.conversationSessionId);
    }
  });

  it('offers one standalone resume request for an inactive resumable session', async () => {
    const { SessionHeaderActionMenu } = await import('./SessionHeaderActionMenu');
    const resumeRequest = createDeferred<boolean>();
    emitSessionResumeRequestMock.mockReturnValue(resumeRequest.promise);
    const session = {
      id: 'sess_resumable',
      active: false,
      seq: 4,
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
    const { recordCachedMachineRpcDirectRouteViable } = await import('@/sync/domains/transfers/runtime/transferRouteCache');
    recordCachedMachineRpcDirectRouteViable({
      serverId: 'server_a',
      remoteMachineId: 'machine_rebound',
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

  it('dispatches one normalized executeAction descriptor through both overflow and direct header arms', async () => {
    machineRpcWithServerScopeMock.mockResolvedValue({
      ok: true,
      result: { opened: true },
    });
    const pluginUiProjection = normalizePluginUiProjection({
      v: 2,
      generation: 7,
      installedPackagesById: {},
      agentsById: {},
      backendsById: {},
      actionsById: {
        'acme.preview/run': {
          id: 'run',
          pluginId: 'acme.preview',
          title: 'Preview',
          scopes: ['session'],
          surfaces: ['ui'],
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
            'translations:acme.preview': {
              id: 'translations:acme.preview',
              pluginId: 'acme.preview',
              contributionKind: 'translations',
              locales: ['en'],
              bundles: {
                en: {
                  title: 'Preview',
                },
              },
            },
            'sessionHeaderAction:acme.preview:run-preview': {
              id: 'sessionHeaderAction:acme.preview:run-preview',
              pluginId: 'acme.preview',
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
        metadata: {
          machineId: 'machine_source',
          flavor: 'claude',
        },
      } as any}
      pluginUiProjection={pluginUiProjection}
      {...overflowPluginHeaderProps}
    />);

    const dropdown = screen.findByType('DropdownMenu' as any);
    expect(dropdown.props.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'plugin-ui:sessionHeaderAction:acme.preview:run-preview',
          title: 'Preview',
        }),
      ]),
    );

    const rpcCallsBeforeOverflow = machineRpcWithServerScopeMock.mock.calls.length;
    await act(async () => {
      dropdown.props.onSelect('plugin-ui:sessionHeaderAction:acme.preview:run-preview');
      const pending = fireAndForgetMock.mock.calls.at(-1)?.[0] as Promise<unknown> | undefined;
      await pending;
    });

    expect(machineRpcWithServerScopeMock.mock.calls).toHaveLength(rpcCallsBeforeOverflow + 1);
    const expectedActionRpc = {
      machineId: 'machine-projection',
      serverId: 'server-projection',
      method: RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE,
      payload: {
        machineId: 'machine-projection',
        expectedGeneration: '7',
        qualifiedActionId: 'acme.preview/run',
        input: null,
        sessionId: 'sess_1',
        executionSurface: 'ui',
      },
      signal: undefined,
      timeoutMs: undefined,
    };
    expect(machineRpcWithServerScopeMock).toHaveBeenLastCalledWith(expectedActionRpc);

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
      {...directPluginHeaderProps}
    />);

    const directAction = screen.findByProps({
      testID: 'session-header-plugin-action-plugin-ui:sessionHeaderAction:acme.preview:run-preview',
    });
    expect(directAction.props.accessibilityRole).toBe('button');
    expect(directAction.props.accessibilityLabel).toBe('Preview');
    expect(directAction.props.accessibilityState).toEqual({ disabled: false });
    await act(async () => {
      directAction.props.onPress();
      const pending = fireAndForgetMock.mock.calls.at(-1)?.[0] as Promise<unknown> | undefined;
      await pending;
    });

    expect(machineRpcWithServerScopeMock.mock.calls).toHaveLength(rpcCallsBeforeOverflow + 2);
    expect(machineRpcWithServerScopeMock).toHaveBeenLastCalledWith(expectedActionRpc);
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
      backendsById: {},
      actionsById: {
        'acme.preview/run': {
          id: 'run',
          pluginId: 'acme.preview',
          title: 'Preview',
          scopes: ['session'],
          surfaces: ['ui'],
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
    const rpcCallsBeforeOverflowPress = machineRpcWithServerScopeMock.mock.calls.length;
    overflowLifetime.retire();
    await act(async () => {
      dropdown.props.onSelect('plugin-ui:sessionHeaderAction:acme.preview:run-preview');
      const pending = fireAndForgetMock.mock.calls.at(-1)?.[0] as Promise<unknown> | undefined;
      await pending;
    });

    expect(machineRpcWithServerScopeMock.mock.calls).toHaveLength(rpcCallsBeforeOverflowPress);

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
    const rpcCallsBeforeDirectPress = machineRpcWithServerScopeMock.mock.calls.length;
    directLifetime.retire();
    await act(async () => {
      directAction.props.onPress();
      const pending = fireAndForgetMock.mock.calls.at(-1)?.[0] as Promise<unknown> | undefined;
      await pending;
    });

    expect(machineRpcWithServerScopeMock.mock.calls).toHaveLength(rpcCallsBeforeDirectPress);
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
      backendsById: {},
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
    const overflowPluginHeaderProps = {
      pluginHeaderActions: [headerAction],
      pluginHeaderActionPlacement: 'overflow' as const,
    };
    const directPluginHeaderProps = {
      pluginHeaderActions: [headerAction],
      pluginHeaderActionPlacement: 'direct' as const,
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
    storageState.current.sessions = {
      sess_read_header: sessionShell,
    };
    storageState.current.sessionListRenderables = {
      sess_read_header: {
        ...sessionShell,
        hasUnreadMessages: false,
      },
    };
    const { SessionHeaderActionMenu } = await import('./SessionHeaderActionMenu');

    const screen = await renderScreen(<SessionHeaderActionMenu
      sessionId="sess_read_header"
      session={sessionShell}
    />);

    let dropdown = screen.findByType('DropdownMenu' as any);
    expect(dropdown.props.items.some((item: any) => item?.id === SESSION_ACTION_MARK_UNREAD_ID)).toBe(true);

    storageState.current.sessionListRenderables = {
      sess_read_header: {
        ...sessionShell,
        lastViewedSessionSeq: 741,
        hasUnreadMessages: true,
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

  it('fails closed when the selected server only offers server-routed handoff transport', async () => {
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
    expect(createSessionActionDraftMock).toHaveBeenCalledWith('sess_1', {
      actionId: 'subagents.plan.start',
      input: { draft: true },
    });
  });

  it('adds a teleport action for session menus when a daemon voice agent conversation already exists', async () => {
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
    voiceSessionSnapshotState.current = {
      adapterId: 'local_conversation',
      sessionId: null,
      status: 'disconnected',
      mode: 'idle',
      canStop: false,
    };

    const { voiceSessionBindingStore } = await import('@/voice/binding/voiceConversationBindingStore');
    const { VOICE_AGENT_GLOBAL_SESSION_ID } = await import('@/voice/agent/voiceAgentGlobalSessionId');
    voiceSessionBindingStore.getState().bind({
      adapterId: 'local_conversation',
      controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      conversationSessionId: 'carrier-s1',
      transcriptMode: 'synthetic',
      targetSessionId: 'sess_1',
      updatedAt: 1,
    });

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

    teleportVoiceAgentToSessionRootMock.mockResolvedValue({ ok: true });
    await act(async () => {
      dropdown.props.onSelect('voice.teleport');
    });
    await flushHookEffects({ cycles: 1 });

    expect(teleportVoiceAgentToSessionRootMock).toHaveBeenCalledWith({ sessionId: 'sess_1' });
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
    storageState.current.sessions = {
      sys_voice: {
        id: 'sys_voice',
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
    expect(machineRpcWithServerScopeMock).not.toHaveBeenCalled();
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
      inputs: { pluginProjectionV2: createExplicitTerminalFollowProjection() },
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

    const { SessionHeaderActionMenu } = await import('./SessionHeaderActionMenu');

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

    await act(async () => {
      machineRpcWithServerScopeMock.mockResolvedValueOnce({
        ok: true,
        enabled: false,
        leaseActive: false,
        updatedAtMs: 2,
      });
      dropdown.props.onSelect('session.externalSession.backgroundFollow');
    });
    await flushHookEffects({ cycles: 1 });

    expect(patchSessionMetadataWithRetryMock).not.toHaveBeenCalled();
    expect(applySessionMetadataLocallyMock).toHaveBeenCalledWith('s1', expect.any(Function));
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
    expect((storageState.current.sessions.s1 as any).metadata.externalSessionV1.followPolicyV1).toEqual({
      v: 1,
      policy: 'attached_only',
      updatedAtMs: 2,
    });
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
