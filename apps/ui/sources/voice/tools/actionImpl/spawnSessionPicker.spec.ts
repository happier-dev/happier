import { beforeEach, describe, expect, it, vi } from 'vitest';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { installVoiceToolActionImplCommonModuleMocks } from './voiceToolActionImplTestHelpers';

const modalShow = vi.fn();
const machineSpawnNewSession = vi.fn();
const refreshSessions = vi.fn(async () => {});
const patchSessionMetadataWithRetry = vi.fn(async (_sessionId: string, _patcher: unknown) => {});
const sendMessage = vi.fn(async (..._args: unknown[]) => {});
const followUpSpawnedSessionWithServerScope = vi.fn(async (_params: unknown) => {});
const state: any = {
  settings: {
    ...settingsDefaults,
    lastUsedAgent: 'claude',
  },
};

installVoiceToolActionImplCommonModuleMocks({
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                show: (cfg: any) => modalShow(cfg),
            },
        }).module;
    },

    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            storage: {
                getState: () => state,
            } as typeof import('@/sync/domains/state/storage').storage,
        });
    },
});

vi.mock('@/voice/pickers/VoiceSessionSpawnPickerModal', () => ({
  VoiceSessionSpawnPickerModal: () => null,
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
  getActiveServerSnapshot: () => ({ serverId: 'server-a' }),
}));

vi.mock('@/sync/ops/machines', () => ({
  machineSpawnNewSession: (opts: any) => machineSpawnNewSession(opts),
}));

vi.mock('@/agents/catalog/catalog', () => ({
  isAgentId: (agentId: unknown) => typeof agentId === 'string' && ['claude', 'codex', 'opencode'].includes(agentId),
  getAgentCore: (agentId: string) => ({
    displayNameKey: `agent.${agentId}`,
    model: {
      supportsSelection: true,
      nonAcpApplyScope: agentId === 'opencode' ? 'next_prompt' : 'spawn_only',
    },
  }),
}));

vi.mock('@/sync/sync', () => ({
  sync: {
    refreshSessions: () => refreshSessions(),
    patchSessionMetadataWithRetry: (sessionId: string, patcher: any) => patchSessionMetadataWithRetry(sessionId, patcher),
    sendMessage: (...args: unknown[]) => sendMessage(...args),
  },
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/followUpSpawnedSession', () => ({
  followUpSpawnedSessionWithServerScope: (params: unknown) => followUpSpawnedSessionWithServerScope(params),
}));

describe('spawnSessionWithPickerForVoiceTool', () => {
  beforeEach(() => {
    state.settings = {
      ...settingsDefaults,
      lastUsedAgent: 'claude',
    };
    state.machines = {
      m2: {
        id: 'm2',
        active: true,
        activeAt: Date.now(),
        spawnReadinessStatus: 'ready',
        metadata: null,
      },
    };
    modalShow.mockReset();
    machineSpawnNewSession.mockReset();
    refreshSessions.mockClear();
    patchSessionMetadataWithRetry.mockClear();
    sendMessage.mockClear();
    followUpSpawnedSessionWithServerScope.mockClear();
  });

  it('opens a picker and spawns a session from the user-selected machine + directory', async () => {
    modalShow.mockImplementationOnce((cfg: any) => {
      cfg?.props?.onResolve?.({ machineId: 'm2', directory: '/tmp/s2' });
      return 'modal_1';
    });
    machineSpawnNewSession.mockResolvedValue({
      type: 'success',
      sessionId: 's_new',
      usedInitialPrompt: true,
    });

    const { spawnSessionWithPickerForVoiceTool } = await import('./spawnSessionPicker');
    const res = await spawnSessionWithPickerForVoiceTool({ tag: 'T', initialMessage: 'Hi' });

    expect(res).toMatchObject({ type: 'success', sessionId: 's_new' });
    expect(machineSpawnNewSession).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'm2',
      directory: '/tmp/s2',
      backendTarget: { kind: 'backend', backendId: 'claude' },
      serverId: 'server-a',
      initialPrompt: 'Hi',
    }));
    expect(refreshSessions).toHaveBeenCalled();
    expect(patchSessionMetadataWithRetry).toHaveBeenCalledWith('s_new', expect.any(Function));
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('uses the same spawn attempt key when retrying the same picker spawn request', async () => {
    modalShow.mockImplementation((cfg: any) => {
      cfg?.props?.onResolve?.({ machineId: 'm2', directory: '/tmp/s2' });
      return 'modal_1';
    });
    machineSpawnNewSession.mockResolvedValue({
      type: 'success',
      sessionId: 's_new',
    });

    const { spawnSessionWithPickerForVoiceTool } = await import('./spawnSessionPicker');
    await spawnSessionWithPickerForVoiceTool({ tag: 'T', initialMessage: 'Hi' });
    await spawnSessionWithPickerForVoiceTool({ tag: 'T', initialMessage: 'Hi' });

    const firstSpawnOptions = machineSpawnNewSession.mock.calls[0]?.[0] as { spawnAttemptKey?: string };
    const secondSpawnOptions = machineSpawnNewSession.mock.calls[1]?.[0] as { spawnAttemptKey?: string };
    expect(firstSpawnOptions.spawnAttemptKey).toEqual(expect.stringMatching(/^voice\.tool\.spawn-session-picker:/));
    expect(secondSpawnOptions.spawnAttemptKey).toBe(firstSpawnOptions.spawnAttemptKey);
  });

  it('confirms daemon initialPrompt custody through the post-spawn send path', async () => {
    modalShow.mockImplementationOnce((cfg: any) => {
      cfg?.props?.onResolve?.({ machineId: 'm2', directory: '/tmp/s2' });
      return 'modal_1';
    });
    machineSpawnNewSession.mockResolvedValue({
      type: 'success',
      sessionId: 's_new',
      usedInitialPrompt: true,
    });

    const { spawnSessionWithPickerForVoiceTool } = await import('./spawnSessionPicker');
    await spawnSessionWithPickerForVoiceTool({ initialMessage: 'Hi' });

    expect(machineSpawnNewSession).toHaveBeenCalledWith(expect.objectContaining({
      initialPrompt: 'Hi',
    }));
    expect(refreshSessions).not.toHaveBeenCalled();
    expect(patchSessionMetadataWithRetry).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(followUpSpawnedSessionWithServerScope).toHaveBeenCalledWith({
      sessionId: 's_new',
      targetServerId: 'server-a',
      initialMessageText: 'Hi',
      metaOverrides: {
        source: 'daemon-initial-prompt',
        sentFrom: 'ui',
      },
      messageLocalId: 'daemon-initial-prompt:s_new',
    });
  });

  it('keeps the post-spawn first message when daemon initialPrompt custody is not confirmed', async () => {
    modalShow.mockImplementationOnce((cfg: any) => {
      cfg?.props?.onResolve?.({ machineId: 'm2', directory: '/tmp/s2' });
      return 'modal_1';
    });
    machineSpawnNewSession.mockResolvedValue({
      type: 'success',
      sessionId: 's_new',
    });

    const { spawnSessionWithPickerForVoiceTool } = await import('./spawnSessionPicker');
    await spawnSessionWithPickerForVoiceTool({ initialMessage: 'Hi' });

    expect(machineSpawnNewSession).toHaveBeenCalledWith(expect.objectContaining({
      initialPrompt: 'Hi',
    }));
    expect(refreshSessions).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(followUpSpawnedSessionWithServerScope).toHaveBeenCalledWith({
      sessionId: 's_new',
      targetServerId: 'server-a',
      initialMessageText: 'Hi',
      metaOverrides: undefined,
    });
  });

  it('keeps next-prompt model first turns on the post-spawn path with model metadata', async () => {
    modalShow.mockImplementationOnce((cfg: any) => {
      cfg?.props?.onResolve?.({ machineId: 'm2', directory: '/tmp/s2' });
      return 'modal_1';
    });
    machineSpawnNewSession.mockResolvedValue({
      type: 'success',
      sessionId: 's_new',
    });

    const { spawnSessionWithPickerForVoiceTool } = await import('./spawnSessionPicker');
    await spawnSessionWithPickerForVoiceTool({
      agentId: 'opencode',
      modelId: 'gpt-5',
      initialMessage: 'Use the selected model for this first turn',
    });

    const spawnOptions = machineSpawnNewSession.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(spawnOptions).toMatchObject({
      modelId: 'gpt-5',
      modelUpdatedAt: expect.any(Number),
    });
    expect(spawnOptions).not.toHaveProperty('initialPrompt');
    expect(sendMessage).not.toHaveBeenCalled();
    expect(followUpSpawnedSessionWithServerScope).toHaveBeenCalledWith({
      sessionId: 's_new',
      targetServerId: 'server-a',
      initialMessageText: 'Use the selected model for this first turn',
      metaOverrides: { model: 'gpt-5' },
    });
  });

  it('uses the configured last-used backend target when there is no explicit voice tool agent override', async () => {
    state.settings.lastUsedAgent = 'codex';
    state.settings.lastUsedBackendTarget = { kind: 'configuredAcpBackend', backendId: 'review-bot' };
    state.settings.acpCatalogSettingsV1 = {
      v: 2,
      backends: [{ id: 'review-bot', name: 'review-bot', title: 'Review Bot' }],
    };
    modalShow.mockImplementationOnce((cfg: any) => {
      cfg?.props?.onResolve?.({ machineId: 'm2', directory: '/tmp/s2' });
      return 'modal_1';
    });
    machineSpawnNewSession.mockResolvedValue({ type: 'success', sessionId: 's_new' });

    const { spawnSessionWithPickerForVoiceTool } = await import('./spawnSessionPicker');
    await spawnSessionWithPickerForVoiceTool({});

    expect(machineSpawnNewSession).toHaveBeenCalledWith(expect.objectContaining({
      backendTarget: { kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot' },
    }));
  });

  it('falls back to the built-in last-used target when the stored configured backend is stale', async () => {
    state.settings.lastUsedAgent = 'codex';
    state.settings.lastUsedBackendTarget = { kind: 'configuredAcpBackend', backendId: 'stale-review-bot' };
    state.settings.acpCatalogSettingsV1 = {
      v: 2,
      backends: [{ id: 'review-bot', name: 'review-bot', title: 'Review Bot' }],
    };
    modalShow.mockImplementationOnce((cfg: any) => {
      cfg?.props?.onResolve?.({ machineId: 'm2', directory: '/tmp/s2' });
      return 'modal_1';
    });
    machineSpawnNewSession.mockResolvedValue({ type: 'success', sessionId: 's_new' });

    const { spawnSessionWithPickerForVoiceTool } = await import('./spawnSessionPicker');
    await spawnSessionWithPickerForVoiceTool({});

    expect(machineSpawnNewSession).toHaveBeenCalledWith(expect.objectContaining({
      backendTarget: { kind: 'backend', backendId: 'codex' },
    }));
  });

  it('uses an explicit backendTargetKey for configured ACP backends instead of falling back to settings', async () => {
    state.settings.lastUsedAgent = 'claude';
    state.settings.lastUsedBackendTarget = { kind: 'builtInAgent', agentId: 'claude' };
    modalShow.mockImplementationOnce((cfg: any) => {
      cfg?.props?.onResolve?.({ machineId: 'm2', directory: '/tmp/s2' });
      return 'modal_1';
    });
    machineSpawnNewSession.mockResolvedValue({ type: 'success', sessionId: 's_new' });

    const { spawnSessionWithPickerForVoiceTool } = await import('./spawnSessionPicker');
    await spawnSessionWithPickerForVoiceTool({ backendTargetKey: 'acpBackend:review-bot' } as any);

    expect(machineSpawnNewSession).toHaveBeenCalledWith(expect.objectContaining({
      backendTarget: expect.objectContaining({ kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot' }),
    }));
  });

  it('uses a canonical plugin backendTargetKey in picker mode when the runtime carrier is explicit', async () => {
    modalShow.mockImplementationOnce((cfg: any) => {
      cfg?.props?.onResolve?.({ machineId: 'm2', directory: '/tmp/s2' });
      return 'modal_1';
    });
    machineSpawnNewSession.mockResolvedValue({ type: 'success', sessionId: 's_new' });

    const { spawnSessionWithPickerForVoiceTool } = await import('./spawnSessionPicker');
    await spawnSessionWithPickerForVoiceTool({
      agentId: 'claude',
      backendTargetKey: 'backend:plugin-review-bot',
    } as any);

    expect(machineSpawnNewSession).toHaveBeenCalledWith(expect.objectContaining({
      backendTarget: {
        kind: 'backend',
        backendId: 'plugin-review-bot',
        sourceKind: 'built_in',
      },
    }));
  });
});
