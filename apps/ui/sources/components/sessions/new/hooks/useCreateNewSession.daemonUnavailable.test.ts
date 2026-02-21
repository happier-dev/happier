import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import type { PermissionMode, ModelMode } from '@/sync/domains/permissions/permissionTypes';
import type { Settings } from '@/sync/domains/settings/settings';
import type { UseMachineEnvPresenceResult } from '@/hooks/machine/useMachineEnvPresence';
import { SPAWN_SESSION_ERROR_CODES } from '@happier-dev/protocol';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function setupHarness() {
  const modalAlertSpy = vi.fn((..._args: unknown[]) => {});
  const machineSpawnNewSessionSpy = vi.fn(async () => ({
    type: 'error' as const,
    errorCode: SPAWN_SESSION_ERROR_CODES.DAEMON_RPC_UNAVAILABLE,
    errorMessage: 'Daemon RPC is not available',
  }));

  vi.doMock('@/text', () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      if (key === 'status.lastSeen') return `status.lastSeen:${String(params?.time ?? '')}`;
      if (key === 'time.minutesAgo') return `time.minutesAgo:${String(params?.count ?? '')}`;
      if (key === 'time.hoursAgo') return `time.hoursAgo:${String(params?.count ?? '')}`;
      return key;
    },
  }));
  vi.doMock('@/modal', () => ({ Modal: { alert: modalAlertSpy, confirm: vi.fn(async () => false) } }));
  vi.doMock('@/sync/sync', () => ({
    sync: {
      applySettings: vi.fn(),
      encryption: { encryptRaw: vi.fn(), encryptAutomationTemplateRaw: vi.fn() },
      decryptSecretValue: vi.fn(),
      refreshAutomations: vi.fn(async () => {}),
      refreshSessions: vi.fn(async () => {}),
      refreshMachines: vi.fn(async () => {}),
      sendMessage: vi.fn(async () => {}),
    },
  }));
  vi.doMock('@/sync/domains/state/storage', () => ({
    storage: {
      getState: () => ({
        settings: {},
        machines: { m1: { id: 'm1' } },
        updateSessionPermissionMode: vi.fn(),
        updateSessionModelMode: vi.fn(),
        updateSessionDraft: vi.fn(),
      }),
    },
  }));
  vi.doMock('@/sync/domains/state/persistence', () => ({ clearNewSessionDraft: vi.fn() }));
  vi.doMock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: vi.fn(() => ({
      serverId: 'server-a',
      serverUrl: 'https://server-a.example.test',
      kind: 'custom',
      generation: 1,
    })),
    setActiveServer: vi.fn(),
  }));
  vi.doMock('@/sync/runtime/orchestration/connectionManager', () => ({
    switchConnectionToActiveServer: vi.fn(async () => ({ token: 'next-token', secret: 'next-secret' })),
  }));
  vi.doMock('@/sync/domains/settings/terminalSettings', () => ({ resolveTerminalSpawnOptions: vi.fn(() => null) }));
  vi.doMock('@/hooks/server/useMachineCapabilitiesCache', () => ({
    getMachineCapabilitiesSnapshot: vi.fn(() => ({ supported: true, response: { protocolVersion: 1, results: {} } })),
    prefetchMachineCapabilities: vi.fn(async () => {}),
  }));
  vi.doMock('@/agents/catalog/catalog', async () => {
    const actual = await vi.importActual<typeof import('@/agents/catalog/catalog')>('@/agents/catalog/catalog');
    return {
      ...actual,
      getAgentCore: vi.fn(() => ({ model: { supportsSelection: false } })),
      buildSpawnEnvironmentVariablesFromUiState: vi.fn((opts: { environmentVariables?: Record<string, string> }) => opts.environmentVariables),
      buildSpawnSessionExtrasFromUiState: vi.fn(() => ({})),
      getAgentResumeExperimentsFromSettings: vi.fn(() => ({})),
      getNewSessionPreflightIssues: vi.fn(() => []),
      getResumeRuntimeSupportPrefetchPlan: vi.fn(() => null),
      buildResumeCapabilityOptionsFromUiState: vi.fn(() => ({})),
    };
  });
  vi.doMock('@/agents/runtime/acpRuntimeResume', () => ({ describeAcpLoadSessionSupport: vi.fn(() => ({ kind: 'unknown' })) }));
  vi.doMock('@/agents/runtime/resumeCapabilities', () => ({ canAgentResume: vi.fn(() => false) }));
  vi.doMock('@/components/sessions/new/modules/formatResumeSupportDetailCode', () => ({ formatResumeSupportDetailCode: vi.fn(() => '') }));
  vi.doMock('@/sync/ops', () => ({ machineSpawnNewSession: machineSpawnNewSessionSpy }));

  const { useCreateNewSession } = await import('./useCreateNewSession');
  return { useCreateNewSession, modalAlertSpy, machineSpawnNewSessionSpy };
}

describe('useCreateNewSession (daemon unavailable UX)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-05T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('shows a daemon-unavailable alert with a Retry action', async () => {
    const { useCreateNewSession, modalAlertSpy } = await setupHarness();

    let handleCreateSession: null | (() => Promise<void>) = null;
    const setIsCreating = vi.fn();
    const settings = { experiments: false } as unknown as Settings;
    const machineEnvPresence: UseMachineEnvPresenceResult = {
      isPreviewEnvSupported: false,
      isLoading: false,
      meta: {},
      refreshedAt: null,
      refresh: () => {},
    };

    function Test() {
      const hook = useCreateNewSession({
        router: { push: vi.fn(), replace: vi.fn() },
        selectedMachineId: 'm1',
        selectedPath: '/tmp',
        selectedMachine: { id: 'm1', active: false, activeAt: Date.now() - 5 * 60_000, metadata: { host: 'devbox' } },
        setIsCreating,
        setIsResumeSupportChecking: vi.fn(),
        sessionType: 'simple',
        settings,
        useProfiles: false,
        selectedProfileId: null,
        profileMap: new Map(),
        recentMachinePaths: [],
        agentType: 'opencode' as any,
        permissionMode: 'default' as PermissionMode,
        modelMode: 'default' as ModelMode,
        sessionPrompt: '',
        resumeSessionId: '',
        agentNewSessionOptions: null,
        automationDraft: null,
        machineEnvPresence,
        secrets: [],
        secretBindingsByProfileId: {},
        selectedSecretIdByProfileIdByEnvVarName: {},
        sessionOnlySecretValueByProfileIdByEnvVarName: {},
        selectedMachineCapabilities: {},
        targetServerId: null,
        allowedTargetServerIds: undefined,
      });
      handleCreateSession = hook.handleCreateSession as any;
      return null;
    }

    let tree: renderer.ReactTestRenderer | null = null;
    await act(async () => {
      tree = renderer.create(React.createElement(Test));
    });
    if (!handleCreateSession) throw new Error('expected handleCreateSession to be set');

    await act(async () => {
      const p = handleCreateSession();
      await vi.runAllTimersAsync();
      await p;
    });

    expect(modalAlertSpy).toHaveBeenCalled();
    const args = modalAlertSpy.mock.calls[0] ?? [];
    expect(args[0]).toBe('newSession.daemonRpcUnavailableTitle');
    expect(String(args[1] ?? '')).toContain('newSession.daemonRpcUnavailableBody');
    expect(String(args[1] ?? '')).toContain('status.lastSeen:time.minutesAgo:5');
    expect(Array.isArray(args[2])).toBe(true);
    const buttons = args[2] as any[];
    expect(buttons.some((b) => b?.text === 'common.retry' && typeof b?.onPress === 'function')).toBe(true);
    await act(async () => {
      tree?.unmount();
    });
  });

  it('does not retry after unmount when the alert Retry action is pressed', async () => {
    const { useCreateNewSession, modalAlertSpy, machineSpawnNewSessionSpy } = await setupHarness();

    let handleCreateSession: null | (() => Promise<void>) = null;
    const setIsCreating = vi.fn();
    const settings = { experiments: false } as unknown as Settings;
    const machineEnvPresence: UseMachineEnvPresenceResult = {
      isPreviewEnvSupported: false,
      isLoading: false,
      meta: {},
      refreshedAt: null,
      refresh: () => {},
    };

    function Test() {
      const hook = useCreateNewSession({
        router: { push: vi.fn(), replace: vi.fn() },
        selectedMachineId: 'm1',
        selectedPath: '/tmp',
        selectedMachine: { id: 'm1', active: false, activeAt: Date.now() - 5 * 60_000, metadata: { host: 'devbox' } },
        setIsCreating,
        setIsResumeSupportChecking: vi.fn(),
        sessionType: 'simple',
        settings,
        useProfiles: false,
        selectedProfileId: null,
        profileMap: new Map(),
        recentMachinePaths: [],
        agentType: 'opencode' as any,
        permissionMode: 'default' as PermissionMode,
        modelMode: 'default' as ModelMode,
        sessionPrompt: '',
        resumeSessionId: '',
        agentNewSessionOptions: null,
        automationDraft: null,
        machineEnvPresence,
        secrets: [],
        secretBindingsByProfileId: {},
        selectedSecretIdByProfileIdByEnvVarName: {},
        sessionOnlySecretValueByProfileIdByEnvVarName: {},
        selectedMachineCapabilities: {},
        targetServerId: null,
        allowedTargetServerIds: undefined,
      });
      handleCreateSession = hook.handleCreateSession as any;
      return null;
    }

    let tree: renderer.ReactTestRenderer | null = null;
    await act(async () => {
      tree = renderer.create(React.createElement(Test));
    });
    if (!handleCreateSession) throw new Error('expected handleCreateSession to be set');

    await act(async () => {
      const p = handleCreateSession();
      await vi.runAllTimersAsync();
      await p;
    });

    expect(machineSpawnNewSessionSpy).toHaveBeenCalledTimes(1);
    expect(modalAlertSpy).toHaveBeenCalled();

    const buttons = (modalAlertSpy.mock.calls[0]?.[2] ?? []) as any[];
    const retry = buttons.find((b) => b?.text === 'common.retry');
    expect(typeof retry?.onPress).toBe('function');

    await act(async () => {
      tree?.unmount();
    });

    await act(async () => {
      retry.onPress();
      await vi.runAllTimersAsync();
    });

    expect(machineSpawnNewSessionSpy).toHaveBeenCalledTimes(1);
  });

  it('does not auto-retry in the hook before showing the daemon-unavailable alert', async () => {
    const { useCreateNewSession, modalAlertSpy, machineSpawnNewSessionSpy } = await setupHarness();

    machineSpawnNewSessionSpy.mockResolvedValueOnce({
      type: 'error' as const,
      errorCode: SPAWN_SESSION_ERROR_CODES.DAEMON_RPC_UNAVAILABLE,
      errorMessage: 'Daemon RPC is not available',
    });

    let handleCreateSession: null | (() => Promise<void>) = null;
    const settings = { experiments: false } as unknown as Settings;
    const machineEnvPresence: UseMachineEnvPresenceResult = {
      isPreviewEnvSupported: false,
      isLoading: false,
      meta: {},
      refreshedAt: null,
      refresh: () => {},
    };

    function Test() {
      const hook = useCreateNewSession({
        router: { push: vi.fn(), replace: vi.fn() },
        selectedMachineId: 'm1',
        selectedPath: '/tmp',
        selectedMachine: { id: 'm1', active: true, activeAt: Date.now(), metadata: { host: 'devbox' } },
        setIsCreating: vi.fn(),
        setIsResumeSupportChecking: vi.fn(),
        sessionType: 'simple',
        settings,
        useProfiles: false,
        selectedProfileId: null,
        profileMap: new Map(),
        recentMachinePaths: [],
        agentType: 'opencode' as any,
        permissionMode: 'default' as PermissionMode,
        modelMode: 'default' as ModelMode,
        sessionPrompt: '',
        resumeSessionId: '',
        agentNewSessionOptions: null,
        automationDraft: null,
        machineEnvPresence,
        secrets: [],
        secretBindingsByProfileId: {},
        selectedSecretIdByProfileIdByEnvVarName: {},
        sessionOnlySecretValueByProfileIdByEnvVarName: {},
        selectedMachineCapabilities: {},
        targetServerId: null,
        allowedTargetServerIds: undefined,
      });
      handleCreateSession = hook.handleCreateSession as any;
      return null;
    }

    await act(async () => {
      renderer.create(React.createElement(Test));
    });
    if (!handleCreateSession) throw new Error('expected handleCreateSession to be set');

    await act(async () => {
      const p = handleCreateSession();
      await vi.runAllTimersAsync();
      await p;
    });

    expect(machineSpawnNewSessionSpy).toHaveBeenCalledTimes(1);
    expect(modalAlertSpy).toHaveBeenCalled();
  });
});
