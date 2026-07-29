import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import {
  primeServerFeaturesSnapshot,
  resetServerFeaturesClientForTests,
  type ServerFeaturesSnapshot,
} from '@/sync/api/capabilities/serverFeaturesClient';
import { installVoiceToolActionImplCommonModuleMocks } from './voiceToolActionImplTestHelpers';

type MachineContributionRegistryProjectionDescribeFn =
  typeof import('@/sync/ops/machineContributionRegistryProjection').machineContributionRegistryProjectionDescribe;

const modalShow = vi.fn();
const machineSpawnNewSession = vi.fn();
const refreshSessions = vi.fn(async () => {});
const patchSessionMetadataWithRetry = vi.fn(async (_sessionId: string, _patcher: unknown) => {});
const sendMessage = vi.fn(async (..._args: unknown[]) => {});
const followUpSpawnedSessionWithServerScope = vi.fn(async (_params: unknown) => {});
const machineContributionRegistryProjectionDescribe = vi.fn<MachineContributionRegistryProjectionDescribeFn>(
  async () => ({ supported: false, reason: 'not-supported' }),
);
const state: any = {
  settings: {
    ...settingsDefaults,
    lastUsedAgent: 'claude',
  },
};

type ProvidersFeatureSnapshotMode = 'enabled' | 'disabled' | 'missing' | 'malformed' | 'unknown';

function primeProvidersFeatureSnapshot(mode: ProvidersFeatureSnapshotMode): void {
  resetServerFeaturesClientForTests();
  let snapshot: ServerFeaturesSnapshot;
  if (mode === 'malformed') {
    snapshot = { status: 'unsupported', reason: 'invalid_payload' };
  } else if (mode === 'unknown') {
    snapshot = { status: 'error', reason: 'network' };
  } else {
    snapshot = {
      status: 'ready',
      features: FeaturesResponseSchema.parse({
        features: mode === 'missing' ? {} : { providers: { enabled: mode === 'enabled' } },
        capabilities: {},
      }),
    };
  }
  primeServerFeaturesSnapshot({ serverId: 'server-a', snapshot });
}

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

vi.mock('@/sync/ops/machineContributionRegistryProjection', () => ({
  machineContributionRegistryProjectionDescribe: (...args: Parameters<MachineContributionRegistryProjectionDescribeFn>) =>
    machineContributionRegistryProjectionDescribe(...args),
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
    primeProvidersFeatureSnapshot('enabled');
    state.settings = {
      ...settingsDefaults,
      lastUsedAgent: 'claude',
    };
    state.machines = {
      m2: {
        id: 'm2',
        active: true,
        activeAt: Date.now(),
        metadata: null,
      },
    };
    modalShow.mockReset();
    machineSpawnNewSession.mockReset();
    refreshSessions.mockClear();
    patchSessionMetadataWithRetry.mockClear();
    sendMessage.mockClear();
    followUpSpawnedSessionWithServerScope.mockClear();
    machineContributionRegistryProjectionDescribe.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('opens a picker and spawns a session from the user-selected machine + directory', async () => {
    modalShow.mockImplementationOnce((cfg: any) => {
      cfg?.props?.onResolve?.({ machineId: 'm2', directory: '/tmp/s2' });
      return 'modal_1';
    });
    machineSpawnNewSession.mockResolvedValue({
      type: 'success',
      sessionId: 's_new',
    });

    const { spawnSessionWithPickerForVoiceTool } = await import('./spawnSessionPicker');
    const res = await spawnSessionWithPickerForVoiceTool({ tag: 'T', initialMessage: 'Hi' });

    expect(res).toMatchObject({ type: 'success', sessionId: 's_new' });
    expect(machineSpawnNewSession).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'm2',
      directory: '/tmp/s2',
      backendTarget: { kind: 'backend', backendId: 'claude' },
      serverId: 'server-a',
    }));
    expect(machineSpawnNewSession.mock.calls[0]?.[0]).not.toHaveProperty('initialPrompt');
    expect(refreshSessions).toHaveBeenCalled();
    expect(patchSessionMetadataWithRetry).toHaveBeenCalledWith('s_new', expect.any(Function));
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('lets the spawn operation decide exact readiness for a structurally ready picked machine and propagates its error', async () => {
    modalShow.mockImplementationOnce((cfg: any) => {
      cfg?.props?.onResolve?.({ machineId: 'm2', directory: '/tmp/s2' });
      return 'modal_1';
    });
    machineSpawnNewSession.mockResolvedValue({
      type: 'error',
      errorCode: 'daemon_unavailable',
      errorMessage: 'daemon unavailable',
    });

    const { spawnSessionWithPickerForVoiceTool } = await import('./spawnSessionPicker');
    const result = await spawnSessionWithPickerForVoiceTool({});

    expect(machineSpawnNewSession).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'm2',
      directory: '/tmp/s2',
    }));
    expect(result).toEqual({
      type: 'error',
      errorCode: 'daemon_unavailable',
      errorMessage: 'daemon unavailable',
    });
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

    expect(machineSpawnNewSession.mock.calls[0]?.[0]).not.toHaveProperty('spawnAttemptKey');
    expect(machineSpawnNewSession.mock.calls[1]?.[0]).not.toHaveProperty('spawnAttemptKey');
  });

  it('routes the picked first turn through the post-spawn Pending path', async () => {
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

    const spawnOptions = machineSpawnNewSession.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(spawnOptions).not.toHaveProperty('initialPrompt');
    expect(refreshSessions).not.toHaveBeenCalled();
    expect(patchSessionMetadataWithRetry).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(followUpSpawnedSessionWithServerScope).toHaveBeenCalledWith({
      sessionId: 's_new',
      targetServerId: 'server-a',
      initialMessageText: 'Hi',
      metaOverrides: undefined,
      messageLocalId: `spawn-first-turn:${String(spawnOptions.spawnNonce)}`,
    });
  });

  it('keeps the post-spawn first message on the canonical Pending path', async () => {
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

    const spawnOptions = machineSpawnNewSession.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(spawnOptions).not.toHaveProperty('initialPrompt');
    expect(refreshSessions).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(followUpSpawnedSessionWithServerScope).toHaveBeenCalledWith({
      sessionId: 's_new',
      targetServerId: 'server-a',
      initialMessageText: 'Hi',
      metaOverrides: undefined,
      messageLocalId: `spawn-first-turn:${String(spawnOptions.spawnNonce)}`,
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
      modelSelection: {
        v: 1,
        ref: {
          agentTargetKey: 'backend:opencode',
          providerConnectionId: null,
          modelId: 'gpt-5',
        },
        updatedAt: expect.any(Number),
      },
    });
    expect(spawnOptions).not.toHaveProperty('initialPrompt');
    expect(sendMessage).not.toHaveBeenCalled();
    expect(followUpSpawnedSessionWithServerScope).toHaveBeenCalledWith({
      sessionId: 's_new',
      targetServerId: 'server-a',
      initialMessageText: 'Use the selected model for this first turn',
      metaOverrides: { model: 'gpt-5' },
      messageLocalId: `spawn-first-turn:${String(spawnOptions.spawnNonce)}`,
    });
  });

  it('preserves provider connection identity through the picker spawn path', async () => {
    modalShow.mockImplementationOnce((cfg: any) => {
      cfg?.props?.onResolve?.({ machineId: 'm2', directory: '/tmp/s2' });
      return 'modal_1';
    });
    machineSpawnNewSession.mockResolvedValue({ type: 'success', sessionId: 's_new' });

    const { spawnSessionWithPickerForVoiceTool } = await import('./spawnSessionPicker');
    await spawnSessionWithPickerForVoiceTool({
      agentId: 'codex',
      providerConnectionId: 'pc_openrouter',
      modelId: 'default',
    });

    const spawnOptions = machineSpawnNewSession.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(spawnOptions).toMatchObject({
      modelSelection: {
        v: 1,
        ref: {
          agentTargetKey: 'backend:codex',
          providerConnectionId: 'pc_openrouter',
          modelId: 'default',
        },
        updatedAt: expect.any(Number),
      },
    });
    expect(spawnOptions).not.toHaveProperty('modelId');
    expect(spawnOptions).not.toHaveProperty('modelUpdatedAt');
  });

  it.each([
    'disabled',
    'missing',
    'malformed',
    'unknown',
  ] as const)('refuses a Provider-bound picker spawn without invoking the machine when the feature snapshot is %s', async (mode) => {
    primeProvidersFeatureSnapshot(mode);
    modalShow.mockImplementationOnce((cfg: any) => {
      cfg?.props?.onResolve?.({ machineId: 'm2', directory: '/tmp/s2' });
      return 'modal_1';
    });
    const { spawnSessionWithPickerForVoiceTool } = await import('./spawnSessionPicker');

    const result = await spawnSessionWithPickerForVoiceTool({
      agentId: 'codex',
      providerConnectionId: 'pc_openrouter',
      modelId: 'gpt-5',
    });

    expect(machineSpawnNewSession).not.toHaveBeenCalled();
    expect(machineContributionRegistryProjectionDescribe).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: false,
      type: 'error',
      errorCode: 'provider_feature_disabled',
      errorMessage: 'provider_feature_disabled',
      errorDetail: {
        kind: 'provider_error',
        providerError: {
          v: 1,
          code: 'provider_feature_disabled',
          connectionId: 'pc_openrouter',
          machineId: 'm2',
          retryable: false,
          action: 'review_features',
        },
      },
    });
  });

  it('keeps native picker spawns unchanged when the Provider feature decision is unknown', async () => {
    resetServerFeaturesClientForTests();
    const fetchSpy = vi.fn(async () => {
      throw new Error('native picker spawn must not probe Provider feature state');
    });
    vi.stubGlobal('fetch', fetchSpy);
    modalShow.mockImplementationOnce((cfg: any) => {
      cfg?.props?.onResolve?.({ machineId: 'm2', directory: '/tmp/s2' });
      return 'modal_1';
    });
    machineSpawnNewSession.mockResolvedValue({ type: 'success', sessionId: 's_new' });
    const { spawnSessionWithPickerForVoiceTool } = await import('./spawnSessionPicker');

    await spawnSessionWithPickerForVoiceTool({
      agentId: 'codex',
      modelId: 'gpt-5',
    });

    expect(machineSpawnNewSession).toHaveBeenCalledWith(expect.objectContaining({
      modelSelection: expect.objectContaining({
        ref: {
          agentTargetKey: 'backend:codex',
          providerConnectionId: null,
          modelId: 'gpt-5',
        },
      }),
    }));
    expect(fetchSpy).not.toHaveBeenCalled();
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
