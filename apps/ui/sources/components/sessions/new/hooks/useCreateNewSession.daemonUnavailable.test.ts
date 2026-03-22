import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import type { PermissionMode, ModelMode } from '@/sync/domains/permissions/permissionTypes';
import type { Settings } from '@/sync/domains/settings/settings';
import type { UseMachineEnvPresenceResult } from '@/hooks/machine/useMachineEnvPresence';
import { SPAWN_SESSION_ERROR_CODES } from '@happier-dev/protocol';
import { renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function setupHarness() {
  const modalAlertSpy = vi.fn((..._args: unknown[]) => {});
  const machineSpawnNewSessionSpy = vi.fn(async () => ({
    type: 'error' as const,
    errorCode: SPAWN_SESSION_ERROR_CODES.DAEMON_RPC_UNAVAILABLE,
    errorMessage: 'Daemon RPC is not available',
  }));

  vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string, params?: Record<string, unknown>) => {
      if (key === 'status.lastSeen') return `status.lastSeen:${String(params?.time ?? '')}`;
      if (key === 'time.minutesAgo') return `time.minutesAgo:${String(params?.count ?? '')}`;
      if (key === 'time.hoursAgo') return `time.hoursAgo:${String(params?.count ?? '')}`;
      return key;
    },
    });
});
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
  vi.doMock('@/sync/store/settingsWriters', () => ({
    useApplySettings: () => vi.fn(),
  }));
  vi.doMock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
    storage: {
      getState: () => ({
        settings: {},
        machines: { m1: { id: 'm1' } },
        updateSessionPermissionMode: vi.fn(),
        updateSessionModelMode: vi.fn(),
        updateSessionDraft: vi.fn(),
      }),
    },
});
});
  vi.doMock('@/sync/domains/state/persistence', () => ({
    clearNewSessionDraft: vi.fn(),
    loadSettings: () => ({ settings: {}, version: null }),
    loadDeviceAnalyticsId: () => null,
    saveDeviceAnalyticsId: vi.fn(),
    saveSettings: vi.fn(),
    loadPendingSettings: () => ({}),
    savePendingSettings: vi.fn(),
    loadLocalSettings: () => ({}),
    saveLocalSettings: vi.fn(),
    loadThemePreference: () => 'adaptive',
    loadPurchases: () => ({}),
    savePurchases: vi.fn(),
    loadSessionDrafts: () => ({}),
    saveSessionDrafts: vi.fn(),
    loadSessionReviewCommentsDrafts: () => ({}),
    saveSessionReviewCommentsDrafts: vi.fn(),
    loadSessionActionDrafts: () => ({}),
    saveSessionActionDrafts: vi.fn(),
    loadNewSessionDraft: () => null,
    saveNewSessionDraft: vi.fn(),
    loadSessionPermissionModes: () => ({}),
    saveSessionPermissionModes: vi.fn(),
    loadSessionPermissionModeUpdatedAts: () => ({}),
    saveSessionPermissionModeUpdatedAts: vi.fn(),
    loadSessionLastViewed: () => ({}),
    saveSessionLastViewed: vi.fn(),
    loadSessionModelModes: () => ({}),
    saveSessionModelModes: vi.fn(),
    loadSessionModelModeUpdatedAts: () => ({}),
    saveSessionModelModeUpdatedAts: vi.fn(),
    loadSessionMaterializedMaxSeqById: () => ({}),
    saveSessionMaterializedMaxSeqById: vi.fn(),
    loadChangesCursor: () => null,
    saveChangesCursor: vi.fn(),
    loadLastChangesCursorByAccountId: () => ({}),
    saveLastChangesCursorByAccountId: vi.fn(),
    loadProfile: () => ({}),
    saveProfile: vi.fn(),
    clearPersistence: vi.fn(),
  }));
  vi.doMock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: vi.fn(() => ({
      serverId: 'server-a',
      serverUrl: 'https://server-a.example.test',
      kind: 'custom',
      generation: 1,
    })),
    setActiveServer: vi.fn(),
  }));
  vi.doMock('@/sync/domains/server/selection/serverSelectionResolver', () => ({
    resolveNewSessionServerTarget: vi.fn((params: { requestedServerId?: string | null; allowedServerIds: string[] }) => ({
      targetServerId: params.requestedServerId ?? params.allowedServerIds[0] ?? null,
      rejectedRequestedServerId: null,
    })),
  }));
  vi.doMock('@/sync/domains/features/featureLocalPolicy', () => ({
    resolveLocalFeaturePolicyEnabled: vi.fn((featureId: string, settings: { featureToggles?: Record<string, boolean> }) => settings.featureToggles?.[featureId] === true),
  }));
  vi.doMock('@/sync/runtime/orchestration/connectionManager', () => ({
    switchConnectionToActiveServer: vi.fn(async () => ({ token: 'next-token', secret: 'next-secret' })),
  }));
  vi.doMock('@/sync/domains/settings/terminalSettings', () => ({ resolveTerminalSpawnOptions: vi.fn(() => null) }));
  vi.doMock('@/hooks/server/useMachineCapabilitiesCache', () => ({
    getMachineCapabilitiesSnapshot: vi.fn(() => ({ supported: true, response: { protocolVersion: 1, results: {} } })),
    prefetchMachineCapabilities: vi.fn(async () => {}),
  }));
  vi.doMock('@/utils/sessions/tempDataStore', () => ({
    storeTempData: vi.fn(() => 'temp-data-key'),
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
      buildResumeCapabilityOptionsFromUiState: vi.fn(() => ({})),
    };
  });
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

    let handleCreateSession: () => Promise<void> = async () => {
      throw new Error('expected handleCreateSession to be set');
    };
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
    tree = (await renderScreen(React.createElement(Test))).tree;

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

    let handleCreateSession: () => Promise<void> = async () => {
      throw new Error('expected handleCreateSession to be set');
    };
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
    tree = (await renderScreen(React.createElement(Test))).tree;

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

    let handleCreateSession: () => Promise<void> = async () => {
      throw new Error('expected handleCreateSession to be set');
    };
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

    await renderScreen(React.createElement(Test));

    await act(async () => {
      const p = handleCreateSession();
      await vi.runAllTimersAsync();
      await p;
    });

    expect(machineSpawnNewSessionSpy).toHaveBeenCalledTimes(1);
    expect(modalAlertSpy).toHaveBeenCalled();
  });
});
