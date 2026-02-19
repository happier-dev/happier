import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import type { PermissionMode, ModelMode } from '@/sync/domains/permissions/permissionTypes';
import type { Settings } from '@/sync/domains/settings/settings';
import type { UseMachineEnvPresenceResult } from '@/hooks/machine/useMachineEnvPresence';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function setupHarness() {
  const publishModeSpy = vi.fn(async (_params: any) => {});
  const sendMessageSpy = vi.fn(async () => {});
  const machineSpawnNewSessionSpy = vi.fn(async () => ({ type: 'success', sessionId: 'sess_new' }));

  vi.doMock('@/text', () => ({ t: (key: string) => key }));
  vi.doMock('@/modal', () => ({ Modal: { alert: vi.fn(), confirm: vi.fn(async () => false) } }));
  vi.doMock('@/sync/sync', () => ({
    sync: {
      applySettings: vi.fn(),
      encryption: { encryptRaw: vi.fn(), encryptAutomationTemplateRaw: vi.fn() },
      decryptSecretValue: vi.fn(),
      refreshAutomations: vi.fn(async () => {}),
      refreshSessions: vi.fn(async () => {}),
      refreshMachines: vi.fn(async () => {}),
      sendMessage: sendMessageSpy,
      publishSessionAcpSessionModeOverrideToMetadata: publishModeSpy,
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
      getAgentCore: vi.fn(() => ({ sessionModes: { kind: 'acpAgentModes' }, model: { supportsSelection: false } })),
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
  vi.doMock('@/sync/ops', () => ({ machineSpawnNewSession: (...args: unknown[]) => machineSpawnNewSessionSpy(...args) }));

  const { useCreateNewSession } = await import('./useCreateNewSession');
  return { useCreateNewSession, publishModeSpy, sendMessageSpy, machineSpawnNewSessionSpy };
}

describe('useCreateNewSession (ACP mode seeding)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-05T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('publishes acpSessionModeOverride before sending the initial message', async () => {
    const { useCreateNewSession, publishModeSpy, sendMessageSpy } = await setupHarness();

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
        sessionType: 'simple',
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

    act(() => {
      renderer.create(React.createElement(Test));
    });

    await act(async () => {
      await handleCreateSession?.();
    });

    expect(publishModeSpy).toHaveBeenCalledTimes(1);
    expect(sendMessageSpy).toHaveBeenCalledTimes(1);

    const publishOrder = publishModeSpy.mock.invocationCallOrder[0] ?? 0;
    const sendOrder = sendMessageSpy.mock.invocationCallOrder[0] ?? 0;
    expect(publishOrder).toBeGreaterThan(0);
    expect(sendOrder).toBeGreaterThan(0);
    expect(publishOrder).toBeLessThan(sendOrder);
  });
});

