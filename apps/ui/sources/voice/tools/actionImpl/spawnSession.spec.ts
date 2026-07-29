import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import {
  primeServerFeaturesSnapshot,
  resetServerFeaturesClientForTests,
  type ServerFeaturesSnapshot,
} from '@/sync/api/capabilities/serverFeaturesClient';
import { installVoiceToolActionImplCommonModuleMocks } from './voiceToolActionImplTestHelpers';

type MachineContributionRegistryProjectionDescribeFn =
  typeof import('@/sync/ops/machineContributionRegistryProjection').machineContributionRegistryProjectionDescribe;

const {
  machineContributionRegistryProjectionDescribe,
} = vi.hoisted(() => ({
  machineContributionRegistryProjectionDescribe: vi.fn<MachineContributionRegistryProjectionDescribeFn>(
    async () => ({ supported: false, reason: 'not-supported' }),
  ),
}));

type MachineSpawnNewSessionMockResult = {
  type: string;
  sessionId?: string;
  errorCode?: string;
  errorMessage?: string;
};

const machineSpawnNewSession = vi.fn(async (_params: unknown): Promise<MachineSpawnNewSessionMockResult> => ({
  type: 'success',
  sessionId: 's_new',
}));
const getActiveServerSnapshot = vi.fn(() => ({ serverId: 'server-a' }));
const resolveEffectiveWindowsRemoteSessionLaunchMode = vi.fn((_params: any) => ({ mode: null }));
const postprocessSpawnedSession = vi.fn(async (_params: any) => {});
const voiceTargetState = {
  primaryActionSessionId: null as string | null,
  lastFocusedSessionId: null as string | null,
};

function createBaseState(): any {
  return {
    sessions: {
      s_new: {
        id: 's_new',
        metadata: { summary: { text: 'Voice Workspace Label Probe' } },
      },
    },
    machines: {
      m1: {
        id: 'm1',
        active: true,
        activeAt: Date.now(),
        metadata: { displayName: 'Leeroy MacBook Pro', host: 'leeroy-mbp' },
      },
    },
    settings: {
      recentMachinePaths: [
        { machineId: 'm1', path: '/Users/leeroy/projects/happier' },
      ],
    },
    sessionListRenderables: {},
    sessionListIndexByServerId: {},
    concurrentSessionListCacheByServerId: {},
  };
}

let state: any = createBaseState();

type ProvidersFeatureSnapshotMode = 'enabled' | 'disabled' | 'missing' | 'malformed' | 'unknown';

function primeProvidersFeatureSnapshot(
  mode: ProvidersFeatureSnapshotMode,
  serverId = 'server-a',
): void {
  if (serverId === 'server-a') {
    resetServerFeaturesClientForTests();
  }
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
  primeServerFeaturesSnapshot({ serverId, snapshot });
}

installVoiceToolActionImplCommonModuleMocks({
  storage: async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
      storage: {
        getState: () => state,
      } as typeof import('@/sync/domains/state/storage').storage,
    });
  },
});

vi.mock('@/sync/ops/machines', () => ({
  machineSpawnNewSession: (params: any) => machineSpawnNewSession(params),
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
  getActiveServerSnapshot: () => getActiveServerSnapshot(),
}));

vi.mock('@/sync/ops/machineContributionRegistryProjection', () => ({
  machineContributionRegistryProjectionDescribe: (...args: Parameters<MachineContributionRegistryProjectionDescribeFn>) =>
    machineContributionRegistryProjectionDescribe(...args),
}));

vi.mock('@/voice/runtime/voiceTargetStore', () => ({
  useVoiceTargetStore: {
    getState: () => voiceTargetState,
  },
}));

vi.mock('@/sync/domains/session/spawn/windowsRemoteSessionLaunchMode', () => ({
  resolveEffectiveWindowsRemoteSessionLaunchMode: (params: any) => resolveEffectiveWindowsRemoteSessionLaunchMode(params),
}));

vi.mock('./spawnSessionPostProcess', () => ({
  postprocessSpawnedSession: (params: any) => postprocessSpawnedSession(params),
  resolveVoiceSpawnedFirstTurnLocalId: ({ requestedSpawnNonce }: { requestedSpawnNonce: string }) =>
    `spawn-first-turn:${requestedSpawnNonce}`,
}));

describe('spawnSessionForVoiceTool', () => {
  beforeEach(() => {
    primeProvidersFeatureSnapshot('enabled');
    state = createBaseState();
    machineSpawnNewSession.mockClear();
    postprocessSpawnedSession.mockClear();
    getActiveServerSnapshot.mockClear();
    resolveEffectiveWindowsRemoteSessionLaunchMode.mockClear();
    machineContributionRegistryProjectionDescribe.mockReset();
    machineContributionRegistryProjectionDescribe.mockResolvedValue({ supported: false, reason: 'not-supported' });
    voiceTargetState.primaryActionSessionId = null;
    voiceTargetState.lastFocusedSessionId = null;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('spawns from the explicit path and returns human-readable target and session labels', async () => {
    const { spawnSessionForVoiceTool } = await import('./spawnSession');

    const result: any = await spawnSessionForVoiceTool({
      path: '/Users/leeroy/projects/happier',
      tag: 'voice-qa',
    });

    expect(machineSpawnNewSession).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'm1',
      directory: '/Users/leeroy/projects/happier',
    }));
    expect(result).toMatchObject({
      type: 'success',
      sessionId: 's_new',
      session: {
        id: 's_new',
        title: 'Voice Workspace Label Probe',
      },
      target: {
        label: 'happier — Leeroy MacBook Pro',
      },
    });
  });

  it('lets the spawn operation decide exact readiness for a structurally ready machine and propagates its error', async () => {
    machineSpawnNewSession.mockResolvedValueOnce({
      type: 'error',
      errorCode: 'daemon_unavailable',
      errorMessage: 'daemon unavailable',
    });
    const { spawnSessionForVoiceTool } = await import('./spawnSession');

    const result = await spawnSessionForVoiceTool({
      path: '/Users/leeroy/projects/happier',
    });

    expect(machineSpawnNewSession).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'm1',
      directory: '/Users/leeroy/projects/happier',
    }));
    expect(result).toMatchObject({
      type: 'error',
      errorCode: 'daemon_unavailable',
      errorMessage: 'daemon unavailable',
    });
  });

  it('uses the same spawn attempt key when retrying the same voice spawn request', async () => {
    const { spawnSessionForVoiceTool } = await import('./spawnSession');

    await spawnSessionForVoiceTool({
      path: '/Users/leeroy/projects/happier',
      tag: 'voice-qa',
      initialMessage: 'Start here',
    });
    await spawnSessionForVoiceTool({
      path: '/Users/leeroy/projects/happier',
      tag: 'voice-qa',
      initialMessage: 'Start here',
    });

    expect(machineSpawnNewSession.mock.calls[0]?.[0]).not.toHaveProperty('spawnAttemptKey');
    expect(machineSpawnNewSession.mock.calls[1]?.[0]).not.toHaveProperty('spawnAttemptKey');
  });

  it('routes a voice first turn through the post-spawn Pending path', async () => {
    machineSpawnNewSession.mockResolvedValueOnce({
      type: 'success',
      sessionId: 's_new',
    });
    const { spawnSessionForVoiceTool } = await import('./spawnSession');

    await spawnSessionForVoiceTool({
      path: '/Users/leeroy/projects/happier',
      initialMessage: '  Start here  ',
    });

    const spawnOptions = machineSpawnNewSession.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(spawnOptions).not.toHaveProperty('initialPrompt');
    expect(postprocessSpawnedSession).toHaveBeenCalledWith({
      sessionId: 's_new',
      serverId: 'server-a',
      tag: null,
      initialMessage: 'Start here',
      initialMessageMetaOverrides: null,
      firstTurnLocalId: `spawn-first-turn:${String(spawnOptions.spawnNonce)}`,
    });
  });

  it('keeps slash-prefixed voice initial messages on the post-spawn fallback path', async () => {
    const { spawnSessionForVoiceTool } = await import('./spawnSession');

    await spawnSessionForVoiceTool({
      path: '/Users/leeroy/projects/happier',
      initialMessage: '  /h.runs  ',
    });

    const spawnOptions = machineSpawnNewSession.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(spawnOptions).not.toHaveProperty('initialPrompt');
    expect(postprocessSpawnedSession).toHaveBeenCalledWith({
      sessionId: 's_new',
      serverId: 'server-a',
      tag: null,
      initialMessage: '/h.runs',
      initialMessageMetaOverrides: null,
      firstTurnLocalId: `spawn-first-turn:${String(spawnOptions.spawnNonce)}`,
    });
  });

  it('keeps next-prompt model first turns on the post-spawn fallback path with model metadata', async () => {
    const { spawnSessionForVoiceTool } = await import('./spawnSession');

    await spawnSessionForVoiceTool({
      agentId: 'opencode',
      path: '/Users/leeroy/projects/happier',
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
    expect(postprocessSpawnedSession).toHaveBeenCalledWith({
      sessionId: 's_new',
      serverId: 'server-a',
      tag: null,
      initialMessage: 'Use the selected model for this first turn',
      initialMessageMetaOverrides: { model: 'gpt-5' },
      firstTurnLocalId: `spawn-first-turn:${String(spawnOptions.spawnNonce)}`,
    });
  });

  it('keeps selected model in the spawn payload while Pending owns the first turn', async () => {
    machineSpawnNewSession.mockResolvedValueOnce({
      type: 'success',
      sessionId: 's_new',
    });
    const { spawnSessionForVoiceTool } = await import('./spawnSession');

    await spawnSessionForVoiceTool({
      agentId: 'codex',
      path: '/Users/leeroy/projects/happier',
      modelId: 'gpt-5.4',
      initialMessage: 'Use the selected model for this first turn',
    });

    expect(machineSpawnNewSession).toHaveBeenCalledWith(expect.objectContaining({
      modelSelection: {
        v: 1,
        ref: {
          agentTargetKey: 'backend:codex',
          providerConnectionId: null,
          modelId: 'gpt-5.4',
        },
        updatedAt: expect.any(Number),
      },
    }));
    const spawnOptions = machineSpawnNewSession.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(spawnOptions).not.toHaveProperty('initialPrompt');
    expect(postprocessSpawnedSession).toHaveBeenCalledWith({
      sessionId: 's_new',
      serverId: 'server-a',
      tag: null,
      initialMessage: 'Use the selected model for this first turn',
      initialMessageMetaOverrides: null,
      firstTurnLocalId: `spawn-first-turn:${String(spawnOptions.spawnNonce)}`,
    });
  });

  it('preserves provider connection identity for a provider model literally named default', async () => {
    const { spawnSessionForVoiceTool } = await import('./spawnSession');

    await spawnSessionForVoiceTool({
      agentId: 'codex',
      path: '/Users/leeroy/projects/happier',
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
  ] as const)('refuses a Provider-bound direct spawn without invoking the machine when the feature snapshot is %s', async (mode) => {
    primeProvidersFeatureSnapshot(mode);
    const { spawnSessionForVoiceTool } = await import('./spawnSession');

    const result = await spawnSessionForVoiceTool({
      agentId: 'codex',
      path: '/Users/leeroy/projects/happier',
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
          machineId: 'm1',
          retryable: false,
          action: 'review_features',
        },
      },
    });
  });

  it('uses the requested spawn server feature decision instead of the active runtime server', async () => {
    primeProvidersFeatureSnapshot('disabled', 'server-b');
    const { spawnSessionForVoiceTool } = await import('./spawnSession');

    const result = await spawnSessionForVoiceTool({
      agentId: 'codex',
      path: '/Users/leeroy/projects/happier',
      providerConnectionId: 'pc_openrouter',
      modelId: 'gpt-5',
      serverId: 'server-b',
    } as any);

    expect(machineSpawnNewSession).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      type: 'error',
      errorCode: 'provider_feature_disabled',
      errorDetail: {
        kind: 'provider_error',
        providerError: {
          code: 'provider_feature_disabled',
          connectionId: 'pc_openrouter',
          machineId: 'm1',
        },
      },
    });
  });

  it('does no projection or spawn work while the Provider decision is loading and returns a typed refusal on network error', async () => {
    resetServerFeaturesClientForTests();
    let rejectFeatureFetch: (reason?: unknown) => void = () => undefined;
    const featureFetch = new Promise<Response>((_resolve, reject) => {
      rejectFeatureFetch = reject;
    });
    const fetchSpy = vi.fn(async () => await featureFetch);
    vi.stubGlobal('fetch', fetchSpy);
    const { spawnSessionForVoiceTool } = await import('./spawnSession');

    const resultPromise = spawnSessionForVoiceTool({
      agentId: 'codex',
      path: '/Users/leeroy/projects/happier',
      providerConnectionId: 'pc_openrouter',
      modelId: 'gpt-5',
    });
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalled());

    expect(machineContributionRegistryProjectionDescribe).not.toHaveBeenCalled();
    expect(machineSpawnNewSession).not.toHaveBeenCalled();

    rejectFeatureFetch(new Error('network unavailable'));
    const result = await resultPromise;
    expect(result).toMatchObject({
      type: 'error',
      errorCode: 'provider_feature_disabled',
      errorDetail: {
        kind: 'provider_error',
        providerError: {
          code: 'provider_feature_disabled',
          connectionId: 'pc_openrouter',
          machineId: 'm1',
        },
      },
    });
    expect(machineContributionRegistryProjectionDescribe).not.toHaveBeenCalled();
    expect(machineSpawnNewSession).not.toHaveBeenCalled();
  });

  it('keeps native direct spawns unchanged when the Provider feature decision is unknown', async () => {
    resetServerFeaturesClientForTests();
    const fetchSpy = vi.fn(async () => {
      throw new Error('native spawn must not probe Provider feature state');
    });
    vi.stubGlobal('fetch', fetchSpy);
    const { spawnSessionForVoiceTool } = await import('./spawnSession');

    await spawnSessionForVoiceTool({
      agentId: 'codex',
      path: '/Users/leeroy/projects/happier',
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

  it('falls back to the freshest recent target when no explicit path is provided', async () => {
    state.settings.recentMachinePaths = [
      { machineId: 'm1', path: 'C:/Repo/.worktrees/Feature-Auth' },
    ];
    state.sessions = {
      ...state.sessions,
      s_windows_old: {
        id: 's_windows_old',
        updatedAt: 100,
        metadata: { machineId: 'm1', path: 'C:/Repo/.worktrees/Feature-Auth' },
      },
      s_windows_new: {
        id: 's_windows_new',
        updatedAt: 250,
        metadata: { machineId: 'm1', path: 'c:\\repo\\.worktrees\\feature-auth\\' },
      },
    };

    const { spawnSessionForVoiceTool } = await import('./spawnSession');

    await spawnSessionForVoiceTool({});

    expect(machineSpawnNewSession).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'm1',
      directory: 'C:/Repo/.worktrees/Feature-Auth',
    }));
  });

  it('prefers the configured last-used backend target when no explicit agent override is provided', async () => {
    state.settings.lastUsedAgent = 'codex';
    state.settings.lastUsedBackendTarget = { kind: 'configuredAcpBackend', backendId: 'review-bot' };
    state.settings.acpCatalogSettingsV1 = {
      v: 2,
      backends: [{ id: 'review-bot', name: 'review-bot', title: 'Review Bot' }],
    };
    const { spawnSessionForVoiceTool } = await import('./spawnSession');

    await spawnSessionForVoiceTool({});

    expect(machineSpawnNewSession).toHaveBeenCalledWith(expect.objectContaining({
      backendTarget: { kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot' },
    }));
  });

  it('does not treat the legacy customAcp fallback as permission to select a plugin backend from merged projection truth', async () => {
    state.settings.lastUsedAgent = 'customAcp';
    machineContributionRegistryProjectionDescribe.mockResolvedValue({
      supported: true,
      projection: {
        v: 1,
        agentsById: {
          'acme.review.provider': {
            id: 'acme.review.provider',
            title: 'Acme Review Provider',
            channel: 'plugin',
            isBuiltIn: false,
            settingsBackendId: 'acme.review.backend',
          },
        },
        backendsById: {
          'acme.review.backend': {
            id: 'acme.review.backend',
            backendId: 'acme.review.backend',
            agentId: 'acme.review.provider',
            title: 'Acme Review Backend',
          },
        },
      },
    });

    const { spawnSessionForVoiceTool } = await import('./spawnSession');

    await spawnSessionForVoiceTool({});

    expect(machineContributionRegistryProjectionDescribe).toHaveBeenCalledWith('m1', expect.objectContaining({
      serverId: 'server-a',
      timeoutMs: 10_000,
    }));
    expect(machineSpawnNewSession).toHaveBeenCalledWith(expect.objectContaining({
      backendTarget: { kind: 'backend', backendId: 'claude' },
    }));
  });

  it('falls back to the last-used built-in target when the stored configured backend is stale', async () => {
    state.settings.lastUsedAgent = 'codex';
    state.settings.lastUsedBackendTarget = { kind: 'configuredAcpBackend', backendId: 'stale-review-bot' };
    state.settings.acpCatalogSettingsV1 = {
      v: 2,
      backends: [{ id: 'review-bot', name: 'review-bot', title: 'Review Bot' }],
    };
    const { spawnSessionForVoiceTool } = await import('./spawnSession');

    await spawnSessionForVoiceTool({});

    expect(machineSpawnNewSession).toHaveBeenCalledWith(expect.objectContaining({
      backendTarget: { kind: 'backend', backendId: 'codex' },
    }));
  });

  it('uses an explicit backendTargetKey for configured ACP backends instead of falling back to settings', async () => {
    state.settings.lastUsedAgent = 'claude';
    state.settings.lastUsedBackendTarget = { kind: 'builtInAgent', agentId: 'claude' };
    const { spawnSessionForVoiceTool } = await import('./spawnSession');

    await spawnSessionForVoiceTool({
      backendTargetKey: 'acpBackend:review-bot',
      path: '/Users/leeroy/projects/happier',
    } as any);

    expect(machineSpawnNewSession).toHaveBeenCalledWith(expect.objectContaining({
      backendTarget: expect.objectContaining({ kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot' }),
    }));
  });

  it('uses the canonical V2 backendTargetKey for configured ACP backends instead of falling back to settings', async () => {
    state.settings.lastUsedAgent = 'claude';
    state.settings.lastUsedBackendTarget = { kind: 'builtInAgent', agentId: 'claude' };
    const { spawnSessionForVoiceTool } = await import('./spawnSession');

    await spawnSessionForVoiceTool({
      backendTargetKey: 'backend:review-bot:configured:review-bot',
      path: '/Users/leeroy/projects/happier',
    } as any);

    expect(machineSpawnNewSession).toHaveBeenCalledWith(expect.objectContaining({
      backendTarget: expect.objectContaining({ kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot' }),
    }));
  });

  it('accepts a matching legacy configured ACP flavor carrier when a canonical configured backendTargetKey is provided', async () => {
    state.settings.lastUsedAgent = 'claude';
    state.settings.lastUsedBackendTarget = { kind: 'builtInAgent', agentId: 'claude' };
    const { spawnSessionForVoiceTool } = await import('./spawnSession');

    await spawnSessionForVoiceTool({
      agentId: 'acp:review-bot',
      backendTargetKey: 'backend:review-bot:configured:review-bot',
      path: '/Users/leeroy/projects/happier',
    } as any);

    expect(machineSpawnNewSession).toHaveBeenCalledWith(expect.objectContaining({
      backendTarget: expect.objectContaining({ kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot' }),
    }));
  });

  it('rejects the plain legacy customAcp carrier when a canonical configured backendTargetKey is provided', async () => {
    const { spawnSessionForVoiceTool } = await import('./spawnSession');

    const result = await spawnSessionForVoiceTool({
      agentId: 'customAcp',
      backendTargetKey: 'backend:review-bot:configured:review-bot',
      path: '/Users/leeroy/projects/happier',
    } as any);

    expect(machineSpawnNewSession).not.toHaveBeenCalled();
    expect(result).toEqual({
      type: 'error',
      errorCode: 'invalid_parameters',
      errorMessage: 'invalid_parameters',
    });
  });

  it('uses a canonical plugin backendTargetKey when the runtime carrier is explicit', async () => {
    const { spawnSessionForVoiceTool } = await import('./spawnSession');

    await spawnSessionForVoiceTool({
      agentId: 'claude',
      backendTargetKey: 'backend:plugin-review-bot',
      path: '/Users/leeroy/projects/happier',
    } as any);

    expect(machineSpawnNewSession).toHaveBeenCalledWith(expect.objectContaining({
      backendTarget: {
        kind: 'backend',
        backendId: 'plugin-review-bot',
        sourceKind: 'built_in',
      },
    }));
  });

  it('prefers visible lookup session metadata when choosing a spawn target for the voice session', async () => {
    state.sessions = {
      ...state.sessions,
      s_spawn_target: {
        id: 's_spawn_target',
        metadata: {
          machineId: 'm_stale',
          path: '/Users/leeroy/projects/stale-target',
        },
      },
    };
    state.sessionListRenderables = {
      ...state.sessionListRenderables,
      s_spawn_target: {
        id: 's_spawn_target',
        updatedAt: 999,
        metadata: {
          machineId: 'm1',
          path: '/Users/leeroy/projects/happier',
        },
      },
    };
    state.sessionListIndexByServerId = {
      'server-a': [
        { type: 'session', sessionId: 's_spawn_target', serverId: 'server-a', serverName: 'Server A' },
      ],
    };
    voiceTargetState.primaryActionSessionId = 's_spawn_target';

    const { spawnSessionForVoiceTool } = await import('./spawnSession');

    await spawnSessionForVoiceTool({});

    expect(machineSpawnNewSession).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'm1',
      directory: '/Users/leeroy/projects/happier',
    }));
  });

  it('spawns from the resolved session machine target before visible metadata', async () => {
    state.sessions = {
      ...state.sessions,
      s_spawn_target: {
        id: 's_spawn_target',
        active: false,
        metadata: {
          machineId: 'm_old',
          path: '/Users/leeroy/projects/stale-target',
        },
      },
    };
    state.sessionListRenderables = {
      ...state.sessionListRenderables,
      s_spawn_target: {
        id: 's_spawn_target',
        updatedAt: 999,
        metadata: {
          machineId: 'm1',
          path: '/Users/leeroy/projects/happier',
        },
      },
    };
    state.sessionListIndexByServerId = {
      'server-a': [
        { type: 'session', sessionId: 's_spawn_target', serverId: 'server-a', serverName: 'Server A' },
      ],
    };
    state.machines = {
      ...state.machines,
      m_old: {
        id: 'm_old',
        active: false,
        activeAt: 1,
        replacedByMachineId: 'm_target',
        replacedAt: 2,
        metadata: { host: 'old.local' },
      },
      m_target: {
        id: 'm_target',
        active: true,
        activeAt: Date.now(),
        metadata: { displayName: 'Target Mac', host: 'target.local' },
      },
    };
    state.getProjectForSession = (sessionId: string) =>
      sessionId === 's_spawn_target'
        ? { key: { machineId: 'm_target', rootPath: '/Users/leeroy/projects/live-target' } }
        : null;
    voiceTargetState.primaryActionSessionId = 's_spawn_target';

    const { spawnSessionForVoiceTool } = await import('./spawnSession');

    await spawnSessionForVoiceTool({});

    expect(machineSpawnNewSession).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'm_target',
      directory: '/Users/leeroy/projects/live-target',
    }));
  });

  it('fails when an explicit host cannot be resolved instead of falling back to another machine', async () => {
    const { spawnSessionForVoiceTool } = await import('./spawnSession');

    const result = await spawnSessionForVoiceTool({
      host: 'missing-host',
      path: '/Users/leeroy/projects/happier',
    });

    expect(machineSpawnNewSession).not.toHaveBeenCalled();
    expect(result).toEqual({
      type: 'error',
      errorCode: 'host_not_found',
      errorMessage: 'host_not_found',
      host: 'missing-host',
    });
  });

  it('returns ambiguity instead of picking the first same-host machine for explicit voice host requests', async () => {
    state.machines = {
      m_old: {
        id: 'm_old',
        active: true,
        activeAt: Date.now(),
        metadata: { displayName: 'Old', host: 'leeroy-mbp' },
      },
      m_current: {
        id: 'm_current',
        active: true,
        activeAt: Date.now(),
        metadata: { displayName: 'Current', host: 'leeroy-mbp' },
      },
    };
    state.settings.recentMachinePaths = [
      { machineId: 'm_current', path: '/Users/leeroy/projects/current' },
    ];

    const { spawnSessionForVoiceTool } = await import('./spawnSession');

    const result = await spawnSessionForVoiceTool({
      host: 'leeroy-mbp',
      path: '/Users/leeroy/projects/current',
    });

    expect(machineSpawnNewSession).not.toHaveBeenCalled();
    expect(result).toEqual({
      type: 'error',
      errorCode: 'host_ambiguous',
      errorMessage: 'host_ambiguous',
      host: 'leeroy-mbp',
    });
  });

  it('selects a unique host match when voice provides only host and path', async () => {
    state.machines = {
      m_voice: {
        id: 'm_voice',
        active: true,
        activeAt: Date.now(),
        metadata: { displayName: 'Voice Host', host: 'voice-host' },
      },
    };
    state.settings.recentMachinePaths = [];

    const { spawnSessionForVoiceTool } = await import('./spawnSession');

    const result = await spawnSessionForVoiceTool({
      host: 'voice-host',
      path: '/Users/leeroy/projects/voice',
    });

    expect(machineSpawnNewSession).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'm_voice',
      directory: '/Users/leeroy/projects/voice',
    }));
    expect(result).toMatchObject({
      type: 'success',
      target: { label: expect.any(String) },
    });
  });

  it('uses an explicit machine for its default path, Provider projection, and final spawn', async () => {
    const explicitMachine = {
      id: 'm_explicit',
      active: true,
      activeAt: Date.now(),
      metadata: { displayName: 'Explicit Mac', host: 'explicit-mac' },
    };
    state.machines = {
      ...state.machines,
      [explicitMachine.id]: explicitMachine,
    };
    state.machineListByServerId = {
      'server-a': Object.values(state.machines),
    };
    state.settings.recentMachinePaths = [
      { machineId: 'm1', path: '/Users/leeroy/projects/fallback' },
      { machineId: 'm_explicit', path: '/Users/leeroy/projects/explicit' },
    ];

    const { spawnSessionForVoiceTool } = await import('./spawnSession');

    const result = await spawnSessionForVoiceTool({
      machineId: 'm_explicit',
      host: 'EXPLICIT-MAC.local',
    });

    expect(machineContributionRegistryProjectionDescribe).toHaveBeenCalledWith('m_explicit', expect.objectContaining({
      serverId: 'server-a',
    }));
    expect(machineSpawnNewSession).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'm_explicit',
      directory: '/Users/leeroy/projects/explicit',
      serverId: 'server-a',
    }));
    expect(result).toMatchObject({
      type: 'success',
      target: { label: 'explicit — Explicit Mac' },
    });
  });

  it('uses the explicit machine identity in Provider refusal context before projection or spawn', async () => {
    const explicitMachine = {
      id: 'm_explicit',
      active: true,
      activeAt: Date.now(),
      metadata: { displayName: 'Explicit Mac', host: 'explicit-mac' },
    };
    state.machines = { ...state.machines, [explicitMachine.id]: explicitMachine };
    state.machineListByServerId = { 'server-a': Object.values(state.machines) };
    primeProvidersFeatureSnapshot('disabled');

    const { spawnSessionForVoiceTool } = await import('./spawnSession');

    const result = await spawnSessionForVoiceTool({
      machineId: 'm_explicit',
      path: '/Users/leeroy/projects/explicit',
      providerConnectionId: 'pc_openrouter',
      modelId: 'gpt-5',
    });

    expect(result).toMatchObject({
      type: 'error',
      errorCode: 'provider_feature_disabled',
      errorDetail: {
        providerError: { machineId: 'm_explicit' },
      },
    });
    expect(machineContributionRegistryProjectionDescribe).not.toHaveBeenCalled();
    expect(machineSpawnNewSession).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'unknown',
      machineId: 'm_missing',
      prepare: () => {},
    },
    {
      name: 'revoked',
      machineId: 'm_revoked',
      prepare: () => {
        state.machines.m_revoked = {
          id: 'm_revoked',
          active: true,
          activeAt: Date.now(),
          revokedAt: Date.now(),
          metadata: { host: 'revoked-mac' },
        };
      },
    },
    {
      name: 'replaced',
      machineId: 'm_replaced',
      prepare: () => {
        state.machines.m_replaced = {
          id: 'm_replaced',
          active: false,
          activeAt: 1,
          replacedByMachineId: 'm1',
          metadata: { host: 'replaced-mac' },
        };
      },
    },
    {
      name: 'stale',
      machineId: 'm_stale',
      prepare: () => {
        state.machines.m_stale = {
          id: 'm_stale',
          active: false,
          activeAt: 1,
          metadata: { host: 'stale-mac' },
        };
      },
    },
  ])('never falls back from an $name explicit machine', async ({ machineId, prepare }) => {
    prepare();
    state.machineListByServerId = { 'server-a': Object.values(state.machines) };
    const { spawnSessionForVoiceTool } = await import('./spawnSession');

    const result = await spawnSessionForVoiceTool({
      machineId,
      path: '/Users/leeroy/projects/explicit',
    });

    expect(result).toMatchObject({
      type: 'error',
      errorCode: machineId === 'm_missing' ? 'invalid_parameters' : 'spawn_target_unavailable',
    });
    expect(machineContributionRegistryProjectionDescribe).not.toHaveBeenCalled();
    expect(machineSpawnNewSession).not.toHaveBeenCalled();
  });

  it('fails an explicit machine host assertion with invalid_parameters before Provider work', async () => {
    state.machineListByServerId = { 'server-a': Object.values(state.machines) };
    primeProvidersFeatureSnapshot('disabled');
    const { spawnSessionForVoiceTool } = await import('./spawnSession');

    const result = await spawnSessionForVoiceTool({
      machineId: 'm1',
      host: 'another-host',
      path: '/Users/leeroy/projects/happier',
      providerConnectionId: 'pc_openrouter',
      modelId: 'gpt-5',
    });

    expect(result).toEqual({
      type: 'error',
      errorCode: 'invalid_parameters',
      errorMessage: 'invalid_parameters',
    });
    expect(machineContributionRegistryProjectionDescribe).not.toHaveBeenCalled();
    expect(machineSpawnNewSession).not.toHaveBeenCalled();
  });

  it('refuses an explicit machine outside the requested server scope', async () => {
    state.machineListByServerId = {
      'server-a': Object.values(state.machines),
      'server-b': [],
    };
    const { spawnSessionForVoiceTool } = await import('./spawnSession');

    const result = await spawnSessionForVoiceTool({
      machineId: 'm1',
      serverId: 'server-b',
      path: '/Users/leeroy/projects/happier',
    });

    expect(result).toEqual({
      type: 'error',
      errorCode: 'invalid_parameters',
      errorMessage: 'invalid_parameters',
    });
    expect(machineContributionRegistryProjectionDescribe).not.toHaveBeenCalled();
    expect(machineSpawnNewSession).not.toHaveBeenCalled();
  });

  it('lets a raw online host match reach the spawn operation without synthetic readiness', async () => {
    state.machines = {
      m_unknown: {
        id: 'm_unknown',
        active: true,
        activeAt: Date.now(),
        metadata: { displayName: 'Unknown Host', host: 'unknown-host' },
      },
    };
    state.settings.recentMachinePaths = [
      { machineId: 'm_unknown', path: '/Users/leeroy/projects/voice' },
    ];

    const { spawnSessionForVoiceTool } = await import('./spawnSession');

    const result = await spawnSessionForVoiceTool({
      host: 'unknown-host',
      path: '/Users/leeroy/projects/voice',
    });

    expect(machineSpawnNewSession).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'm_unknown',
      directory: '/Users/leeroy/projects/voice',
    }));
    expect(result).toMatchObject({ type: 'success' });
  });
});
