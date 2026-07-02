import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushHookEffects, renderScreen } from '@/dev/testkit';
import {
  installSessionActionsCommonModuleMocks,
  resetSessionActionsCommonModuleMockState,
} from './sessionActionsTestHelpers';
import {
  SESSION_ACTION_MARK_READ_ID,
  SESSION_ACTION_MARK_UNREAD_ID,
} from './sessionActionIds';
import { EMPTY_PLUGIN_UI_PROJECTION } from '@/sync/domains/plugins/ui/projection';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const runSessionHandoffPickerFlowMock = vi.hoisted(() => vi.fn());
const createDefaultActionExecutorMock = vi.hoisted(() => vi.fn());
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
const storageState = vi.hoisted(() => ({
  current: {
    settings: { voice: null as any } as any,
    sessions: {} as Record<string, any>,
    machines: {} as Record<string, any>,
    machineListByServerId: {} as Record<string, any>,
    createSessionActionDraft: createSessionActionDraftMock,
  },
}));

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
      storage: {
        getState: () => storageState.current,
        subscribe: () => () => {},
      },
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
  canForkConversation: () => false,
}));

vi.mock('@/sync/domains/sessionFork/executeSessionForkAction', () => ({
  executeSessionForkAction: vi.fn(),
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
  beforeEach(() => {
    resetSessionActionsCommonModuleMockState();
    runSessionHandoffPickerFlowMock.mockReset();
    createDefaultActionExecutorMock.mockReset();
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
    dropdownRenderCount.current = 0;
    patchSessionMetadataWithRetryMock.mockReset();
    applySessionMetadataLocallyMock.mockReset();
    readMachineTargetForSessionMock.mockReturnValue(null);
    machineRpcWithServerScopeMock.mockRejectedValue(new Error('unreachable'));
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
    storageState.current = {
      settings: {
        voice: null,
        experiments: true,
        featureToggles: { 'execution.runs': true },
      },
      sessions: {},
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
    return import('@/voice/binding/voiceConversationBindingStore').then(({ voiceSessionBindingStore }) => {
      for (const binding of voiceSessionBindingStore.getState().list()) {
        voiceSessionBindingStore.getState().unbind(binding.conversationSessionId);
      }
    });
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
            provider: 'claude',
            updatedAt: 100,
            currentModeId: 'default',
            availableModes: [{ id: 'default', name: 'Default' }],
          },
          sessionModelsV1: {
            v: 1,
            provider: 'claude',
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
            provider: 'claude',
            updatedAt: 200,
            currentModeId: 'default',
            availableModes: [{ id: 'default', name: 'Default' }],
          },
          sessionModelsV1: {
            v: 1,
            provider: 'claude',
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

    expect(trigger.props.testID).toBe('session-header-action-menu-trigger');
    expect(trigger.props.accessibilityLabel).toBe('session.actionMenu.openA11y');
  });

  it('surfaces descriptor-backed plugin header actions and dispatches openSurface targets through the host', async () => {
    const openPluginSurface = vi.fn();
    const pluginUiProjection = {
      ...EMPTY_PLUGIN_UI_PROJECTION,
      translationsByPluginId: {
        'acme.preview': {
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
      },
      sessionHeaderActionsById: {
        'sessionHeaderAction:acme.preview:open-preview': {
          id: 'sessionHeaderAction:acme.preview:open-preview',
          pluginId: 'acme.preview',
          contributionKind: 'sessionHeaderAction',
          descriptorId: 'open-preview',
          action: {
            id: 'open-preview',
            kind: 'openSurface',
            labelKey: 'title',
            target: { surfaceId: 'preview-pane' },
          },
          display: { titleKey: 'title', iconToken: 'preview' },
        },
        'sessionHeaderAction:acme.preview:hidden-preview': {
          id: 'sessionHeaderAction:acme.preview:hidden-preview',
          pluginId: 'acme.preview',
          contributionKind: 'sessionHeaderAction',
          descriptorId: 'hidden-preview',
          action: {
            id: 'hidden-preview',
            kind: 'openSurface',
            labelKey: 'title',
            target: { surfaceId: 'hidden-pane' },
          },
          display: { titleKey: 'title', iconToken: 'preview' },
          visibility: { operand: 'platform.is', value: 'web' },
        },
        'sessionHeaderAction:acme.preview:execute-preview': {
          id: 'sessionHeaderAction:acme.preview:execute-preview',
          pluginId: 'acme.preview',
          contributionKind: 'sessionHeaderAction',
          descriptorId: 'execute-preview',
          action: {
            id: 'execute-preview',
            kind: 'executeAction',
            labelKey: 'title',
            target: { actionId: 'acme.preview.run' },
          },
          display: { titleKey: 'title', iconToken: 'action' },
        },
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
      {...({ pluginUiProjection, onOpenPluginSurface: openPluginSurface } as any)}
    />);

    const dropdown = screen.findByType('DropdownMenu' as any);
    expect(dropdown.props.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'plugin-ui:sessionHeaderAction:acme.preview:open-preview',
          title: 'Preview',
        }),
      ]),
    );
    expect(dropdown.props.items).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'plugin-ui:sessionHeaderAction:acme.preview:hidden-preview',
        }),
      ]),
    );
    expect(dropdown.props.items).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'plugin-ui:sessionHeaderAction:acme.preview:execute-preview',
        }),
      ]),
    );

    await act(async () => {
      dropdown.props.onSelect('plugin-ui:sessionHeaderAction:acme.preview:open-preview');
    });

    expect(openPluginSurface).toHaveBeenCalledWith('preview-pane');
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
    };
    expect(executorConfig.resolveServerIdForSessionId('sess_1')).toBe('server-explicit');

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
      adapters: {
        local_conversation: {
          conversationMode: 'agent',
          agent: { backend: 'daemon', stayInVoiceHome: false, teleportEnabled: true },
        },
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
      adapters: {
        local_conversation: {
          conversationMode: 'agent',
          agent: { backend: 'daemon', stayInVoiceHome: false, teleportEnabled: true },
        },
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

  it('surfaces a background follow toggle for linked direct sessions and enables it on select', async () => {
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
            providerId: 'codex',
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
    expect(dropdown.props.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'session.externalSession.backgroundFollow',
          title: 'session.actionMenu.backgroundFollow',
          subtitle: 'common.disabled',
        }),
      ]),
    );

    await act(async () => {
      machineRpcWithServerScopeMock.mockResolvedValueOnce({
        ok: true,
        enabled: true,
        leaseActive: true,
        updatedAtMs: 1,
      });
      dropdown.props.onSelect('session.externalSession.backgroundFollow');
    });
    await flushHookEffects({ cycles: 1 });

    expect(patchSessionMetadataWithRetryMock).not.toHaveBeenCalled();
    expect(applySessionMetadataLocallyMock).toHaveBeenCalledWith('s1', expect.any(Function));
    expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'machine-1',
      serverId: 'server_a',
      method: 'daemon.externalSessions.followPolicy.set',
      payload: expect.objectContaining({
        sessionId: 's1',
        remoteSessionId: 'vendor-session-1',
        enabled: true,
      }),
    }));
    expect((storageState.current.sessions.s1 as any).metadata.externalSessionV1.followPolicyV1).toEqual({
      v: 1,
      policy: 'background_follow',
      updatedAtMs: 1,
    });
  });

  it('surfaces a disable toggle when background follow is already enabled and turns it off on select', async () => {
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
            providerId: 'codex',
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
      method: 'daemon.externalSessions.followPolicy.set',
      payload: expect.objectContaining({
        sessionId: 's1',
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

  it('does not surface background follow for direct-session providers without follow support', async () => {
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
            providerId: 'opencode',
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
