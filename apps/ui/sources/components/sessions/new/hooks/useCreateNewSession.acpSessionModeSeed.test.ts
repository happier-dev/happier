import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import type { PermissionMode, ModelMode } from '@/sync/domains/permissions/permissionTypes';
import type { Settings } from '@/sync/domains/settings/settings';
import type { UseMachineEnvPresenceResult } from '@/hooks/machine/useMachineEnvPresence';
import { renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function setupHarness(options?: Readonly<{
  storageState?: Record<string, unknown>;
  fetchArtifactWithBodyResult?: Record<string, unknown> | null;
}>) {
  const publishModeSpy = vi.fn(async (_params: any) => {});
  const sendMessageSpy = vi.fn(async (
    _sessionId: string,
    _text: string,
    _displayText?: string,
    _metaOverrides?: Record<string, unknown>,
    _options?: Readonly<{ profileId?: string | null }>,
  ) => {});
  const machineSpawnNewSessionSpy = vi.fn(async (..._args: any[]) => ({ type: 'success', sessionId: 'sess_new' }));
  const followUpSpawnedSessionWithServerScopeSpy = vi.fn(async (params: {
    sessionId: string;
    initialMessageText?: string | null;
  }) => {
    if (typeof params.initialMessageText !== 'string' || params.initialMessageText.trim().length === 0) {
      return;
    }

    await sendMessageSpy(params.sessionId, params.initialMessageText);
  });
  const storageState = {
    settings: {},
    machines: { m1: { id: 'm1' } },
    updateSessionPermissionMode: vi.fn(),
    updateSessionModelMode: vi.fn(),
    updateSessionDraft: vi.fn(),
    ...(options?.storageState ?? {}),
  };

  vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string) => key,
    });
});
  vi.doMock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        spies: {
            alert: vi.fn(),
            confirm: vi.fn(async () => false),
        },
    }).module;
});
  vi.doMock('@/sync/sync', () => ({
    sync: {
      applySettings: vi.fn(),
      encryption: { encryptRaw: vi.fn(), encryptAutomationTemplateRaw: vi.fn() },
      decryptSecretValue: vi.fn(),
      refreshAutomations: vi.fn(async () => {}),
      refreshSessions: vi.fn(async () => {}),
      refreshMachines: vi.fn(async () => {}),
      sendMessage: sendMessageSpy,
      fetchArtifactWithBody: vi.fn(async () => options?.fetchArtifactWithBodyResult ?? null),
      publishSessionAcpSessionModeOverrideToMetadata: publishModeSpy,
    },
  }));
  vi.doMock('@/sync/store/settingsWriters', () => ({
    useApplySettings: () => vi.fn(),
  }));
  vi.doMock('@/sync/domains/state/storage', () => ({
    storage: {
      getState: () => storageState,
    },
  }));
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
  vi.doMock('@/agents/catalog/catalog', async () => {
    const actual = await vi.importActual<typeof import('@/agents/catalog/catalog')>('@/agents/catalog/catalog');
    return {
      ...actual,
      getAgentCore: vi.fn((agentId: string) => ({
        sessionModes: { kind: agentId === 'codex' ? 'acpPolicyPresets' : 'acpAgentModes' },
        model: { supportsSelection: false },
      })),
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
  vi.doMock('@/sync/runtime/orchestration/serverScopedRpc/followUpSpawnedSession', () => ({
    followUpSpawnedSessionWithServerScope: followUpSpawnedSessionWithServerScopeSpy,
  }));
  vi.doMock('@/utils/sessions/tempDataStore', () => ({
    storeTempData: vi.fn(() => 'temp-data-key'),
  }));

  const { useCreateNewSession } = await import('./useCreateNewSession');
  return {
    useCreateNewSession,
    publishModeSpy,
    sendMessageSpy,
    machineSpawnNewSessionSpy,
    followUpSpawnedSessionWithServerScopeSpy,
  };
}

describe('useCreateNewSession (ACP mode seeding)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers({
      now: new Date('2026-02-05T00:00:00.000Z'),
      toFake: ['Date'],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('passes agent mode through spawn options before sending the initial message', async () => {
    const { useCreateNewSession, machineSpawnNewSessionSpy, publishModeSpy, sendMessageSpy } = await setupHarness();

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
        selectedMachine: { metadata: {} },
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
        acpSessionModeId: 'plan',
        sessionPrompt: 'hello',
        resumeSessionId: '',
        agentNewSessionOptions: null,
        machineEnvPresence,
        secrets: [],
        secretBindingsByProfileId: {},
        selectedSecretIdByProfileIdByEnvVarName: {},
        sessionOnlySecretValueByProfileIdByEnvVarName: {},
        selectedMachineCapabilities: null,
        targetServerId: null,
        allowedTargetServerIds: ['server-a'],
      } as any);

      handleCreateSession = hook.handleCreateSession as () => Promise<void>;
      return React.createElement('View');
    }

    await renderScreen(React.createElement(Test));

    await act(async () => {
      await handleCreateSession?.();
    });

    expect(publishModeSpy).not.toHaveBeenCalled();
    expect(machineSpawnNewSessionSpy).toHaveBeenCalledWith(expect.objectContaining({
      agentModeId: 'plan',
    }));
    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
  });

  it('passes agent mode through spawn options for staticAgentModes (Claude)', async () => {
    const { useCreateNewSession, machineSpawnNewSessionSpy, publishModeSpy, sendMessageSpy } = await setupHarness();

    const { getAgentCore } = await import('@/agents/catalog/catalog');
    (getAgentCore as any).mockReturnValue({ sessionModes: { kind: 'staticAgentModes' }, model: { supportsSelection: false } });

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
        selectedMachine: { metadata: {} },
        setIsCreating: vi.fn(),
        setIsResumeSupportChecking: vi.fn(),
        settings,
        useProfiles: false,
        selectedProfileId: null,
        profileMap: new Map(),
        recentMachinePaths: [],
        agentType: 'claude' as any,
        permissionMode: 'default' as PermissionMode,
        modelMode: 'default' as ModelMode,
        acpSessionModeId: 'plan',
        sessionPrompt: 'hello',
        resumeSessionId: '',
        agentNewSessionOptions: null,
        machineEnvPresence,
        secrets: [],
        secretBindingsByProfileId: {},
        selectedSecretIdByProfileIdByEnvVarName: {},
        sessionOnlySecretValueByProfileIdByEnvVarName: {},
        selectedMachineCapabilities: null,
        targetServerId: null,
        allowedTargetServerIds: ['server-a'],
      } as any);

      handleCreateSession = hook.handleCreateSession as () => Promise<void>;
      return React.createElement('View');
    }

    await renderScreen(React.createElement(Test));

    await act(async () => {
      await handleCreateSession?.();
    });

    expect(publishModeSpy).not.toHaveBeenCalled();
    expect(machineSpawnNewSessionSpy).toHaveBeenCalledWith(expect.objectContaining({
      agentModeId: 'plan',
    }));
    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
  });

  it('passes agent mode through spawn options for Codex appServer', async () => {
    const { useCreateNewSession, machineSpawnNewSessionSpy, publishModeSpy, sendMessageSpy } = await setupHarness();

    let handleCreateSession: null | (() => Promise<void>) = null;
    const settings = { codexBackendMode: 'appServer' } as unknown as Settings;
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
        selectedMachine: { metadata: {} },
        setIsCreating: vi.fn(),
        setIsResumeSupportChecking: vi.fn(),
        settings,
        useProfiles: false,
        selectedProfileId: null,
        profileMap: new Map(),
        recentMachinePaths: [],
        agentType: 'codex' as any,
        permissionMode: 'default' as PermissionMode,
        modelMode: 'default' as ModelMode,
        acpSessionModeId: 'plan',
        sessionPrompt: 'hello',
        resumeSessionId: '',
        agentNewSessionOptions: null,
        machineEnvPresence,
        secrets: [],
        secretBindingsByProfileId: {},
        selectedSecretIdByProfileIdByEnvVarName: {},
        sessionOnlySecretValueByProfileIdByEnvVarName: {},
        selectedMachineCapabilities: null,
        targetServerId: null,
        allowedTargetServerIds: ['server-a'],
      } as any);

      handleCreateSession = hook.handleCreateSession as () => Promise<void>;
      return React.createElement('View');
    }

    await renderScreen(React.createElement(Test));

    await act(async () => {
      await handleCreateSession?.();
    });

    expect(publishModeSpy).not.toHaveBeenCalled();
    expect(machineSpawnNewSessionSpy).toHaveBeenCalledWith(expect.objectContaining({
      agentModeId: 'plan',
    }));
    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
  });

  it('passes transient ACP config option overrides through spawn options for Codex appServer', async () => {
    const { useCreateNewSession, machineSpawnNewSessionSpy, sendMessageSpy } = await setupHarness();

    let handleCreateSession: null | (() => Promise<void>) = null;
    const settings = { codexBackendMode: 'appServer' } as unknown as Settings;
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
        selectedMachine: { metadata: {} },
        setIsCreating: vi.fn(),
        setIsResumeSupportChecking: vi.fn(),
        settings,
        useProfiles: false,
        selectedProfileId: null,
        profileMap: new Map(),
        recentMachinePaths: [],
        agentType: 'codex' as any,
        permissionMode: 'default' as PermissionMode,
        modelMode: 'default' as ModelMode,
        acpSessionModeId: null,
        sessionConfigOptionOverrides: {
          v: 1,
          updatedAt: 123,
          overrides: {
            speed: { updatedAt: 123, value: 'fast' },
          },
        },
        sessionPrompt: 'hello',
        resumeSessionId: '',
        agentNewSessionOptions: null,
        machineEnvPresence,
        secrets: [],
        secretBindingsByProfileId: {},
        selectedSecretIdByProfileIdByEnvVarName: {},
        sessionOnlySecretValueByProfileIdByEnvVarName: {},
        selectedMachineCapabilities: null,
        targetServerId: null,
        allowedTargetServerIds: ['server-a'],
      } as any);

      handleCreateSession = hook.handleCreateSession as () => Promise<void>;
      return React.createElement('View');
    }

    await renderScreen(React.createElement(Test));

    await act(async () => {
      await handleCreateSession?.();
    });

    expect(machineSpawnNewSessionSpy).toHaveBeenCalledWith(expect.objectContaining({
      sessionConfigOptionOverrides: {
        v: 1,
        updatedAt: 123,
        overrides: {
          speed: { updatedAt: 123, value: 'fast' },
        },
      },
    }));
    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
  });

  it('prefers an explicit codex backend-mode override when spawning a seeded Codex session', async () => {
    const { useCreateNewSession, machineSpawnNewSessionSpy } = await setupHarness();

    const { buildSpawnSessionExtrasFromUiState } = await import('@/agents/catalog/catalog');
    (buildSpawnSessionExtrasFromUiState as any).mockImplementation(({ settings }: { settings: { codexBackendMode?: string } }) => ({
      codexBackendMode: settings.codexBackendMode,
      experimentalCodexAcp: settings.codexBackendMode === 'acp',
    }));

    let handleCreateSession: null | (() => Promise<void>) = null;
    const settings = { codexBackendMode: 'acp' } as unknown as Settings;
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
        selectedMachine: { metadata: {} },
        setIsCreating: vi.fn(),
        setIsResumeSupportChecking: vi.fn(),
        settings,
        useProfiles: false,
        selectedProfileId: null,
        profileMap: new Map(),
        recentMachinePaths: [],
        agentType: 'codex' as any,
        permissionMode: 'default' as PermissionMode,
        modelMode: 'default' as ModelMode,
        acpSessionModeId: null,
        sessionPrompt: 'hello',
        resumeSessionId: '',
        agentNewSessionOptions: null,
        machineEnvPresence,
        secrets: [],
        secretBindingsByProfileId: {},
        selectedSecretIdByProfileIdByEnvVarName: {},
        sessionOnlySecretValueByProfileIdByEnvVarName: {},
        selectedMachineCapabilities: null,
        targetServerId: null,
        allowedTargetServerIds: ['server-a'],
      } as any);

      handleCreateSession = hook.handleCreateSession as () => Promise<void>;
      return React.createElement('View');
    }

    await renderScreen(React.createElement(Test));

    await act(async () => {
      await handleCreateSession?.();
    });

    expect(machineSpawnNewSessionSpy).toHaveBeenCalledWith(expect.objectContaining({
      codexBackendMode: 'acp',
      experimentalCodexAcp: true,
    }));
  });

  it('expands prompt templates before sending the initial session message', async () => {
    const { useCreateNewSession, sendMessageSpy } = await setupHarness({
      storageState: {
        settings: {
          promptInvocationsV1: {
            v: 1,
            entries: [
              {
                id: 'tmpl_1',
                token: '/qa-check',
                title: 'QA Template',
                target: { kind: 'doc', artifactId: 'artifact_prompt_1' },
                behavior: 'insert_and_send',
                allowArgs: true,
                availableIn: 'global',
              },
            ],
          },
        },
        artifacts: {
          artifact_prompt_1: {
            id: 'artifact_prompt_1',
            body: JSON.stringify({
              v: 1,
              markdown: 'Expanded QA Template',
              createdAtMs: 1,
              updatedAtMs: 1,
            }),
          },
        },
      },
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
        selectedMachine: { metadata: {} },
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
        acpSessionModeId: null,
        sessionPrompt: '/qa-check this is a UI QA check',
        resumeSessionId: '',
        agentNewSessionOptions: null,
        machineEnvPresence,
        secrets: [],
        secretBindingsByProfileId: {},
        selectedSecretIdByProfileIdByEnvVarName: {},
        sessionOnlySecretValueByProfileIdByEnvVarName: {},
        selectedMachineCapabilities: null,
        targetServerId: null,
        allowedTargetServerIds: ['server-a'],
      } as any);

      handleCreateSession = hook.handleCreateSession as () => Promise<void>;
      return React.createElement('View');
    }

    await renderScreen(React.createElement(Test));

    await act(async () => {
      await handleCreateSession?.();
    });

    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
    const call = sendMessageSpy.mock.calls[0];
    expect(call).toBeDefined();
    if (!call) {
      throw new Error('expected sendMessage to be called');
    }
    const [sessionId, initialMessageText, displayText, metaOverrides, options] = call;
    expect(sessionId).toBe('sess_new');
    expect(initialMessageText).toBe('Expanded QA Template\n\nthis is a UI QA check');
    expect(displayText).toBeUndefined();
    expect(metaOverrides).toBeUndefined();
    expect(options).toBeUndefined();
  });
});
