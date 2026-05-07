import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushHookEffects, renderScreen } from '@/dev/testkit';
import {
  installSessionActionsCommonModuleMocks,
  resetSessionActionsCommonModuleMockState,
} from './sessionActionsTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const runSessionHandoffPickerFlowMock = vi.hoisted(() => vi.fn());
const createDefaultActionExecutorMock = vi.hoisted(() => vi.fn());
const resolveServerIdForSessionIdFromLocalCacheMock = vi.hoisted(() => vi.fn());
const resolvePreferredServerIdForSessionIdMock = vi.hoisted(() => vi.fn());
const usePreferredServerIdForSessionMock = vi.hoisted(() => vi.fn());
const fireAndForgetMock = vi.hoisted(() => vi.fn());
const createSessionActionDraftMock = vi.hoisted(() => vi.fn());
const buildActionDraftInputMock = vi.hoisted(() => vi.fn());
const teleportVoiceAgentToSessionRootMock = vi.hoisted(() => vi.fn());
const resolveSessionActionDefaultBackendMock = vi.hoisted(() => vi.fn());
const readMachineTargetForSessionMock = vi.hoisted(() => vi.fn());
const machineRpcWithServerScopeMock = vi.hoisted(() => vi.fn());
const setManualReadStateMock = vi.hoisted(() =>
  vi.fn(async (
    _sessionId: string,
    _readState: 'read' | 'unread',
    _opts?: Readonly<{ serverId?: string | null }>,
  ) => ({ success: true })),
);
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
const storageState = vi.hoisted(() => ({
  current: {
    settings: { voice: null as any } as any,
    sessions: {} as Record<string, any>,
    createSessionActionDraft: createSessionActionDraftMock,
  },
}));

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
      useSetting: (key: string) => {
        if (key === 'actionsSettingsV1') return actionsSettingsState.current;
        if (key === 'sessionReplayEnabled') return true;
        if (key === 'voice') return voiceSettingState.current;
        return null;
      },
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
        surfaces: { ui_button: true },
        placements: ['session_action_menu'],
      },
      {
        id: 'subagents.plan.start',
        title: 'Start plan run',
        description: 'Plan changes',
        surfaces: { ui_button: true },
        placements: ['session_action_menu'],
      },
    ],
  };
});

vi.mock('@/agents/hooks/useEnabledAgentIds', () => ({
  useEnabledAgentIds: () => ['claude'],
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
  DropdownMenu: (props: any) => React.createElement('DropdownMenu', props),
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

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/resolveServerIdForSessionIdFromLocalCache', () => ({
  resolveServerIdForSessionIdFromLocalCache: (...args: unknown[]) => resolveServerIdForSessionIdFromLocalCacheMock(...args),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId', () => ({
  resolvePreferredServerIdForSessionId: (...args: unknown[]) => resolvePreferredServerIdForSessionIdMock(...args),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession', () => ({
  usePreferredServerIdForSession: (...args: unknown[]) => usePreferredServerIdForSessionMock(...args),
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
    opts?: Readonly<{ serverId?: string | null }>,
  ) => setManualReadStateMock(sessionId, readState, opts),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
  machineRpcWithServerScope: (...args: unknown[]) => machineRpcWithServerScopeMock(...args),
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
    resolveServerIdForSessionIdFromLocalCacheMock.mockReset();
    resolvePreferredServerIdForSessionIdMock.mockReset();
    usePreferredServerIdForSessionMock.mockReset();
    fireAndForgetMock.mockReset();
    createSessionActionDraftMock.mockReset();
    buildActionDraftInputMock.mockReset();
    teleportVoiceAgentToSessionRootMock.mockReset();
    resolveSessionActionDefaultBackendMock.mockReset();
    readMachineTargetForSessionMock.mockReset();
    machineRpcWithServerScopeMock.mockReset();
    setManualReadStateMock.mockReset();
    readMachineTargetForSessionMock.mockReturnValue(null);
    machineRpcWithServerScopeMock.mockRejectedValue(new Error('unreachable'));
    serverSnapshotState.current = { status: 'ready', features: { features: { sessions: { enabled: true, handoff: { enabled: true } }, machines: { enabled: true, transfer: { enabled: true, directPeer: { enabled: true }, serverRouted: { enabled: false } } } }, capabilities: {} } } as any;

    createDefaultActionExecutorMock.mockReturnValue({
      execute: vi.fn(),
    });
    buildActionDraftInputMock.mockReturnValue({ draft: true });
    resolveServerIdForSessionIdFromLocalCacheMock.mockReturnValue('server_a');
    resolvePreferredServerIdForSessionIdMock.mockImplementation((sessionId: string) =>
      resolveServerIdForSessionIdFromLocalCacheMock(sessionId),
    );
    usePreferredServerIdForSessionMock.mockImplementation((sessionId: string) =>
      resolveServerIdForSessionIdFromLocalCacheMock(sessionId),
    );
    runSessionHandoffPickerFlowMock.mockResolvedValue({ ok: true, handoffId: 'handoff_1' });
    resolveSessionActionDefaultBackendMock.mockReturnValue({
      backendTarget: { kind: 'agent', agentId: 'claude' },
      defaultBackendId: 'claude',
    });
    voiceSettingState.current = null;
    storageState.current = {
      settings: {
        voice: null,
        experiments: true,
        featureToggles: { 'execution.runs': true },
      },
      sessions: {},
      createSessionActionDraft: createSessionActionDraftMock,
    };
    voiceSessionSnapshotState.current = {
      adapterId: null,
      sessionId: null,
      status: 'disconnected',
      mode: 'idle',
      canStop: false,
    };

    vi.resetModules();
    return import('@/voice/sessionBinding/voiceSessionBindingStore').then(({ voiceSessionBindingStore }) => {
      for (const binding of voiceSessionBindingStore.getState().list()) {
        voiceSessionBindingStore.getState().unbind(binding.conversationSessionId);
      }
    });
  });

  it('prefers the reachable source machine id for handoff gating and flow context when session metadata is stale', async () => {
    readMachineTargetForSessionMock.mockReturnValue({
      machineId: 'machine_rebound',
      basePath: '/workspace/repo',
    });
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

  it('shows mark-unread for a read session and uses the selected server scope', async () => {
    const { SessionHeaderActionMenu } = await import('./SessionHeaderActionMenu');

    const screen = await renderScreen(<SessionHeaderActionMenu
          sessionId="sess_read"
          session={{
            id: 'sess_read',
            seq: 2,
            lastViewedSessionSeq: 2,
            archivedAt: null,
            metadata: null,
          } as any}
        />);

    const dropdown = screen.findByType('DropdownMenu' as any);
    expect(dropdown.props.items.some((item: any) => item?.id === 'session.mark-unread')).toBe(true);

    await act(async () => {
      dropdown.props.onSelect('session.mark-unread');
    });

    expect(setManualReadStateMock).toHaveBeenCalledWith('sess_read', 'unread', { serverId: 'server_a' });
  });

  it('shows mark-read for an unread session and uses the selected server scope', async () => {
    const { SessionHeaderActionMenu } = await import('./SessionHeaderActionMenu');

    const screen = await renderScreen(<SessionHeaderActionMenu
          sessionId="sess_unread"
          session={{
            id: 'sess_unread',
            seq: 2,
            lastViewedSessionSeq: 1,
            archivedAt: null,
            metadata: null,
          } as any}
        />);

    const dropdown = screen.findByType('DropdownMenu' as any);
    expect(dropdown.props.items.some((item: any) => item?.id === 'session.mark-read')).toBe(true);

    await act(async () => {
      dropdown.props.onSelect('session.mark-read');
    });

    expect(setManualReadStateMock).toHaveBeenCalledWith('sess_unread', 'read', { serverId: 'server_a' });
  });

  it('does not show read-state actions for archived sessions', async () => {
    const { SessionHeaderActionMenu } = await import('./SessionHeaderActionMenu');

    const screen = await renderScreen(<SessionHeaderActionMenu
          sessionId="sess_archived"
          session={{
            id: 'sess_archived',
            seq: 2,
            lastViewedSessionSeq: 2,
            archivedAt: 123,
            metadata: null,
          } as any}
        />);

    const dropdown = screen.findByType('DropdownMenu' as any);
    expect(dropdown.props.items.some((item: any) => item?.id === 'session.mark-read' || item?.id === 'session.mark-unread')).toBe(false);
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
    expect(dropdown.props.items.some((item: any) => item?.id === 'session.handoff')).toBe(false);
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
    expect(dropdown.props.items.some((item: any) => item?.id === 'session.handoff')).toBe(false);
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
    expect(dropdown.props.items.some((item: any) => item?.id === 'session.handoff')).toBe(false);
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
    expect(dropdown.props.items.some((item: any) => item?.id === 'session.handoff')).toBe(false);
  });

  it('reacts when machine-rpc direct-peer viability becomes available after mount', async () => {
    resolveServerIdForSessionIdFromLocalCacheMock.mockReturnValue('server_reactive_header');

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
    expect(dropdown.props.items.some((item: any) => item?.id === 'session.handoff')).toBe(false);

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

  it('surfaces session.handoff when source reachability is proven through server-scoped rpc even without a cached direct route', async () => {
    resolveServerIdForSessionIdFromLocalCacheMock.mockReturnValue('server_scoped_only');
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

  it('surfaces session.handoff when the local session cache misses but the preferred server resolver falls back to the active server', async () => {
    resolveServerIdForSessionIdFromLocalCacheMock.mockReturnValue(null);
    resolvePreferredServerIdForSessionIdMock.mockReturnValue('server_preferred_header');
    usePreferredServerIdForSessionMock.mockReturnValue('server_preferred_header');
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

    const { voiceSessionBindingStore } = await import('@/voice/sessionBinding/voiceSessionBindingStore');
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
