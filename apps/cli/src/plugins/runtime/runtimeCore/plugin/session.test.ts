import { describe, expect, it, vi } from 'vitest';

import type { RuntimeTurnOperations } from '@/agent/runtime/turns/runtimeTurnOperations';
import type { Credentials } from '@/persistence';
import { ProviderConnectionIdSchema } from '@happier-dev/protocol';

import {
    createNativeAgentHostSessionRuntimePlan as createPublicPluginSessionRuntimePlan,
    createPluginSessionRuntimePlan,
} from './session';
import { buildPluginHostSessionRuntimeOptions, buildPluginSessionBindingInput } from './sessionLaunch';
import { decorateRuntimeTurnOperationsWithMetadata } from './sessionMetadata';

const releasedCacheMocks = vi.hoisted(() => ({
  read: vi.fn(),
  write: vi.fn(),
}));

vi.mock('@/agent/runtime/startup/releasedStartupOverridesCacheV1', () => ({
  readReleasedStartupOverridesCacheV1: releasedCacheMocks.read,
  writeReleasedStartupOverridesCacheV1: releasedCacheMocks.write,
}));

const credentials: Credentials = {
  token: 'test-token',
  encryption: {
    type: 'legacy',
    secret: new Uint8Array([1, 2, 3]),
  },
};

function createBackendFixture() {
  return {
    id: 'acme.sample.backend',
    agentId: 'acme.sample.provider',
    provenance: 'external',
    source: { kind: 'path' },
    runtimeKind: 'native',
    richDefinition: {
      provenance: 'external',
      definition: {
        catalogAgentId: 'claude',
      },
    },
    definition: {
      id: 'acme.sample.backend',
      agentId: 'acme.sample.provider',
      catalogAgentId: 'claude',
    },
  } as never;
}

function createAgentFixture() {
  return {
    id: 'acme.sample.provider',
    provenance: 'external',
    source: { kind: 'path' },
    runtimeSpec: {
      title: 'Acme Sample Provider',
    },
    richDefinition: {
      provenance: 'external',
      definition: {
        catalogAgentId: 'claude',
      },
    },
    definition: {
      id: 'acme.sample.provider',
      ownedBackendIds: ['acme.sample.backend'],
      catalogAgentId: 'claude',
    },
  } as never;
}

function createRuntimeTurnOperations(): RuntimeTurnOperations & Readonly<{
  sendTurnPrompt: ReturnType<typeof vi.fn>;
}> {
  return {
    beginTurnLifecycle: vi.fn(),
    sendTurnPrompt: vi.fn(async () => undefined),
    steerInFlightTurn: vi.fn(async () => undefined),
    waitForTurnCompletion: vi.fn(async () => undefined),
    subscribeRuntimeEvents: vi.fn(() => () => undefined),
    cancelTurn: vi.fn(async () => undefined),
    readSessionIdentity: vi.fn(() => ({ sessionId: 'plugin-session-1' })),
    updateSessionRuntimeConfig: vi.fn(async () => undefined),
    resetOrDisposeRuntime: vi.fn(async () => undefined),
  };
}

function createHostFactoryParams() {
  return {
    directory: '/tmp/plugin-backend',
    metadata: {} as never,
    machineId: 'machine-1',
    session: { sessionId: 'host-session-1' } as never,
    transcriptSession: {} as never,
    messageBuffer: {} as never,
    mcpServers: {},
    permissionHandler: {} as never,
    getPermissionMode: () => 'default' as const,
    setThinking: () => undefined,
    memoryRecallGuidanceEnabled: false,
  };
}

describe('plugin session runtime adapters', () => {
  it('preserves the canonical native fork-open source through session binding', () => {
    const nativeForkSource = {
      sessionId: 'host-parent',
      providerSessionId: 'provider-parent',
      cwd: '/source',
      target: {
        turnId: 'host-turn-42',
        providerCheckpoint: { kind: 'grok_prompt_index', promptIndex: 42 },
      },
    } as const;

    expect(buildPluginSessionBindingInput({
      credentials,
      nativeForkSource,
    }).nativeForkSource).toEqual(nativeForkSource);
  });

  it('rejects an explicit blank provider continuation before constructing a session binding', () => {
    expect(() => buildPluginSessionBindingInput({
      credentials,
      resume: '   ',
    })).toThrow(/non-empty provider continuation id/i);
  });

  it('preserves explicit terminal-mode intent through the plugin session binding', () => {
    const input = buildPluginSessionBindingInput({
      credentials,
      startingMode: 'terminal',
    });

    expect(input.runtimePreferences.startingMode).toBe('terminal');
    expect(buildPluginHostSessionRuntimeOptions(input)).toMatchObject({
      startingMode: 'terminal',
    });
  });

  it('preserves the one-shot Happier attach path through the native session binding', () => {
    const input = buildPluginSessionBindingInput({
      credentials,
      existingSessionId: 'happy-session',
      sessionAttachFilePath: '/tmp/session-attach.json',
    });

    expect(input.resume.sessionAttachFilePath).toBe('/tmp/session-attach.json');
    expect(buildPluginHostSessionRuntimeOptions(input)).toMatchObject({
      existingSessionId: 'happy-session',
      sessionAttachFilePath: '/tmp/session-attach.json',
    });
  });

  it('consumes provider-owned deferred-startup policy only on the native Agent plan', async () => {
    const shouldUseDeferredBootstrap = vi.fn(() => true);
    const baseAgent = createAgentFixture() as unknown as Record<string, unknown>;
    const agent = {
      ...baseAgent,
      catalogEntry: {
        id: 'acme.sample.provider',
        cliSubcommand: 'acme.sample.provider',
        shouldUseDeferredSessionStartup: shouldUseDeferredBootstrap,
      },
    } as never;
    const sessionInput = buildPluginSessionBindingInput({
      credentials,
      directory: '/tmp/plugin-backend',
      startedBy: 'terminal',
      startingMode: 'terminal',
      permissionMode: 'acceptEdits',
      existingSessionId: 'happy-session',
      sessionAttachFilePath: '/tmp/session-attach.json',
      resume: 'vendor-session',
    });

    const nativePlan = await createPublicPluginSessionRuntimePlan({
      backend: createBackendFixture(),
      agent,
      createSessionRuntime: async () => createRuntimeTurnOperations(),
      sessionInput,
    });
    const legacyPlan = await createPluginSessionRuntimePlan({
      backend: createBackendFixture(),
      agent,
      launch: async () => ({
        operations: createRuntimeTurnOperations(),
      }) as never,
      sessionInput,
    });

    expect(nativePlan.config.startupBootstrap?.shouldCreate?.({
      opts: nativePlan.opts,
      seed: {
        permissionMode: 'safe-yolo',
        permissionModeUpdatedAt: 42,
        permissionModeSource: 'explicit',
        modelSelection: null,
      },
    })).toBe(true);
    expect(nativePlan.config.startupBootstrap?.shouldCreate?.({
      opts: nativePlan.opts,
      seed: {
        permissionMode: 'safe-yolo',
        permissionModeUpdatedAt: 43,
        permissionModeSource: 'explicit',
        modelSelection: {
          v: 1,
          updatedAt: 44,
          ref: {
            agentTargetKey: 'backend:acme.sample.backend',
            providerConnectionId: ProviderConnectionIdSchema.parse('pc_work'),
            modelId: 'authorized-provider-model',
          },
        },
      },
    })).toBe(false);
    expect(shouldUseDeferredBootstrap).toHaveBeenCalledWith({
      startedBy: 'terminal',
      startingMode: 'terminal',
      existingSessionId: 'happy-session',
      sessionAttachFilePath: '/tmp/session-attach.json',
      providerResumeId: 'vendor-session',
      hasExplicitPermissionMode: true,
      permissionModeSeedSource: 'explicit',
      hasTerminalTty: expect.any(Boolean),
    });
    expect(legacyPlan.config.startupBootstrap).toBeUndefined();
  });

  it('adopts the deployed Codex V1 cache only as a lowest-priority provider-resume seed', async () => {
    releasedCacheMocks.read.mockReturnValue({
      permissionMode: 'safe-yolo',
      permissionModeUpdatedAt: 101,
      modelId: 'cached-codex-model',
      modelUpdatedAt: 102,
      updatedAt: 103,
    });
    const baseAgent = createAgentFixture() as unknown as Record<string, unknown>;
    const agent = {
      ...baseAgent,
      catalogEntry: {
        id: 'acme.sample.provider',
        cliSubcommand: 'acme.sample.provider',
        releasedStartupOverridesCacheV1: true,
        shouldUseDeferredSessionStartup: () => true,
      },
    } as never;
    const plan = await createPublicPluginSessionRuntimePlan({
      backend: createBackendFixture(),
      agent,
      createSessionRuntime: async () => createRuntimeTurnOperations(),
      sessionInput: buildPluginSessionBindingInput({
        credentials,
        resume: 'codex-thread',
      }),
    });
    const resolveSeed = plan.config.startupBootstrap?.resolveSeed;
    if (!resolveSeed) throw new Error('expected released cache seed resolver');

    expect(await resolveSeed({
      opts: plan.opts,
      seed: {
        permissionMode: 'default',
        permissionModeUpdatedAt: 100,
        permissionModeSource: 'fallback',
        modelSelection: null,
      },
    })).toMatchObject({
      permissionMode: 'safe-yolo',
      permissionModeUpdatedAt: 101,
      permissionModeSource: 'released_cache_v1',
      modelSelection: {
        updatedAt: 102,
        ref: {
          modelId: 'cached-codex-model',
          providerConnectionId: null,
        },
      },
    });

    expect(await resolveSeed({
      opts: plan.opts,
      seed: {
        permissionMode: 'read-only',
        permissionModeUpdatedAt: 104,
        permissionModeSource: 'account_default',
        modelSelection: {
          v: 1,
          updatedAt: 104,
          ref: {
            agentTargetKey: 'backend:acme.sample.backend',
            providerConnectionId: null,
            modelId: 'current-model',
          },
        },
      },
    })).toMatchObject({
      permissionMode: 'safe-yolo',
      permissionModeUpdatedAt: 101,
      permissionModeSource: 'released_cache_v1',
      modelSelection: {
        ref: { modelId: 'cached-codex-model' },
      },
    });

    releasedCacheMocks.read.mockClear();
    expect(await resolveSeed({
      opts: { ...plan.opts, permissionMode: 'yolo' },
      seed: {
        permissionMode: 'yolo',
        permissionModeUpdatedAt: 105,
        permissionModeSource: 'explicit',
        modelSelection: null,
      },
    })).toMatchObject({
      permissionMode: 'yolo',
      permissionModeUpdatedAt: 105,
      permissionModeSource: 'explicit',
    });
    expect(releasedCacheMocks.read).not.toHaveBeenCalled();

    releasedCacheMocks.read.mockReturnValue({
      permissionMode: 'safe-yolo',
      permissionModeUpdatedAt: 106,
      modelId: 'cached-codex-model',
      modelUpdatedAt: 107,
      updatedAt: 108,
    });
    const providerBoundModelSelection = {
      v: 1 as const,
      updatedAt: 109,
      ref: {
        agentTargetKey: 'backend:acme.sample.backend',
        providerConnectionId: ProviderConnectionIdSchema.parse('pc_work'),
        modelId: 'authorized-provider-model',
      },
    };
    expect(await resolveSeed({
      opts: plan.opts,
      seed: {
        permissionMode: 'default',
        permissionModeUpdatedAt: 109,
        permissionModeSource: 'fallback',
        modelSelection: providerBoundModelSelection,
      },
    })).toMatchObject({
      permissionMode: 'safe-yolo',
      permissionModeSource: 'released_cache_v1',
      modelSelection: providerBoundModelSelection,
    });

    releasedCacheMocks.read.mockReturnValue({
      permissionMode: 'safe-yolo',
      permissionModeUpdatedAt: 110,
      modelId: null,
      modelUpdatedAt: 0,
      updatedAt: 111,
    });
    const currentModelSelection = {
      v: 1 as const,
      updatedAt: 112,
      ref: {
        agentTargetKey: 'backend:acme.sample.backend',
        providerConnectionId: null,
        modelId: 'current-model',
      },
    };
    expect(await resolveSeed({
      opts: plan.opts,
      seed: {
        permissionMode: 'default',
        permissionModeUpdatedAt: 112,
        permissionModeSource: 'fallback',
        modelSelection: currentModelSelection,
      },
    })).toMatchObject({
      permissionMode: 'safe-yolo',
      permissionModeSource: 'released_cache_v1',
      modelSelection: currentModelSelection,
    });

    plan.config.startupBootstrap?.writeRuntimeOverrides?.({
      permissionMode: 'yolo',
      permissionModeUpdatedAt: 113,
      modelSelection: currentModelSelection,
    });
    expect(releasedCacheMocks.write).toHaveBeenCalledWith(expect.objectContaining({
      backendId: 'acme.sample.backend',
      permissionMode: 'yolo',
      permissionModeUpdatedAt: 113,
      modelId: 'current-model',
      modelUpdatedAt: 112,
    }));
  });

  it('keeps provider-bound model identity structured until the host runtime boundary', () => {
    const input = buildPluginSessionBindingInput({
      credentials,
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      modelSelection: {
        v: 1,
        updatedAt: 56,
        ref: {
          agentTargetKey: 'backend:codex',
          providerConnectionId: 'pc_work',
          modelId: 'provider-model',
        },
      },
    });

    expect(input.runtimePreferences.modelSelection).toEqual({
      v: 1,
      updatedAt: 56,
      ref: {
        agentTargetKey: 'backend:codex',
        providerConnectionId: 'pc_work',
        modelId: 'provider-model',
      },
    });
    expect(buildPluginHostSessionRuntimeOptions(input)).toMatchObject({
      modelSelection: input.runtimePreferences.modelSelection,
    });
  });

  it('projects the generic host-private late environment resolver without exposing Provider policy', () => {
    const resolveLateEnvironment = vi.fn(async () => ({
      environmentVariables: { PROFILE_SECRET: 'secret' },
      unsetEnvironmentVariables: [],
      sensitiveEnvironmentVariableNames: ['PROFILE_SECRET'],
    }));
    const input = buildPluginSessionBindingInput({
      credentials,
      resolveLateEnvironment,
    });

    expect(input.bootstrap.resolveLateEnvironment)
      .toBe(resolveLateEnvironment);
    expect(buildPluginHostSessionRuntimeOptions(input).resolveLateEnvironment)
      .toBe(resolveLateEnvironment);
  });

  it('normalizes a deployed bare plugin model only when its target is explicit', () => {
    expect(buildPluginSessionBindingInput({
      credentials,
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      modelId: 'legacy-model',
      modelUpdatedAt: 57,
    }).runtimePreferences.modelSelection).toEqual({
      v: 1,
      updatedAt: 57,
      ref: {
        agentTargetKey: 'backend:codex',
        providerConnectionId: null,
        modelId: 'legacy-model',
      },
    });
    expect(() => buildPluginSessionBindingInput({ credentials, modelId: 'legacy-model' }))
      .toThrow(/target is unavailable/i);
    expect(buildPluginSessionBindingInput({
      credentials,
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      modelId: 'default',
    }).runtimePreferences.modelSelection).toBeUndefined();
  });

  it('rejects a malformed canonical selection instead of falling back to the legacy model field', () => {
    expect(() => buildPluginSessionBindingInput({
      credentials,
      backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
      modelSelection: {
        v: 1,
        updatedAt: 58,
        ref: {
          agentTargetKey: 'backend:codex',
          providerConnectionId: 'pc_work',
          modelId: '',
        },
      },
      modelId: 'legacy-model',
    })).toThrow(/model selection/i);
  });

  it('requires an explicit target before accepting a canonical model selection', () => {
    expect(() => buildPluginSessionBindingInput({
      credentials,
      modelSelection: {
        v: 1,
        updatedAt: 59,
        ref: {
          agentTargetKey: 'backend:codex',
          providerConnectionId: 'pc_work',
          modelId: 'provider-model',
        },
      },
    })).toThrow(/target is unavailable/i);
  });

  it('keeps explicit not-applicable authority over a historical capability bit and producer-shaped runtime method', async () => {
    const baseAgent = createAgentFixture() as unknown as Record<string, unknown>;
    const agent = {
      ...baseAgent,
      catalogEntry: {
        id: 'acme.sample.provider',
        cliSubcommand: 'acme.sample.provider',
        runtimeActivityApplicability: 'not_applicable',
      },
      richDefinition: {
        provenance: 'external',
        definition: {
          catalogAgentId: 'claude',
          capabilities: { sessions: { runtimeActivitySnapshots: true } },
        },
      },
    } as never;
    const plan = await createPublicPluginSessionRuntimePlan({
      backend: createBackendFixture(),
      agent,
      createSessionRuntime: async () => ({
        ...createRuntimeTurnOperations(),
        subscribeCanonicalAgentSessionEvents: () => () => undefined,
      }),
      sessionInput: buildPluginSessionBindingInput({ credentials }),
    });

    expect(plan.config.runtimeActivityApplicability).toBe('not_applicable');
  });

  it.each([
    { applicability: 'supported' as const, hasProducerMethod: true },
    { applicability: 'supported' as const, hasProducerMethod: false },
    { applicability: 'unavailable' as const, hasProducerMethod: true },
    { applicability: 'unavailable' as const, hasProducerMethod: false },
    { applicability: 'not_applicable' as const, hasProducerMethod: true },
    { applicability: 'not_applicable' as const, hasProducerMethod: false },
  ])('keeps $applicability authoritative when producer method presence is $hasProducerMethod', async ({
    applicability,
    hasProducerMethod,
  }) => {
    const baseAgent = createAgentFixture() as unknown as Record<string, unknown>;
    const agent = {
      ...baseAgent,
      catalogEntry: {
        id: 'acme.sample.provider',
        cliSubcommand: 'acme.sample.provider',
        runtimeActivityApplicability: applicability,
      },
    } as never;
    const plan = await createPublicPluginSessionRuntimePlan({
      backend: createBackendFixture(),
      agent,
      createSessionRuntime: async () => ({
        ...createRuntimeTurnOperations(),
        ...(hasProducerMethod
          ? { subscribeCanonicalAgentSessionEvents: () => () => undefined }
          : {}),
      }),
      sessionInput: buildPluginSessionBindingInput({ credentials }),
    });

    expect(plan.config.runtimeActivityApplicability).toBe(applicability);
  });

  it('does not infer Runtime Activity participation from a historical capability or producer-shaped method', async () => {
    const baseAgent = createAgentFixture() as unknown as Record<string, unknown>;
    const agent = {
      ...baseAgent,
      richDefinition: {
        provenance: 'external',
        definition: {
          catalogAgentId: 'claude',
          capabilities: { sessions: { runtimeActivitySnapshots: true } },
        },
      },
    } as never;
    const plan = await createPublicPluginSessionRuntimePlan({
      backend: createBackendFixture(),
      agent,
      createSessionRuntime: async () => ({
        ...createRuntimeTurnOperations(),
        subscribeCanonicalAgentSessionEvents: () => () => undefined,
      }),
      sessionInput: buildPluginSessionBindingInput({ credentials }),
    });

    expect(plan.config.runtimeActivityApplicability).toBe('not_applicable');
  });

  it('passes provider-acceptance user message seqs to native Agent operations', async () => {
    const runtime = createRuntimeTurnOperations();
    const plan = await createPublicPluginSessionRuntimePlan({
      backend: createBackendFixture(),
      agent: createAgentFixture(),
      createSessionRuntime: async () => runtime,
      sessionInput: buildPluginSessionBindingInput({
        credentials,
        directory: '/tmp/plugin-backend',
      }),
    });

    const created = await plan.config.createSessionRuntime?.({
      directory: '/tmp/plugin-backend',
      metadata: {} as never,
      machineId: 'machine-1',
      session: { sessionId: 'host-session-1' } as never,
      transcriptSession: {} as never,
      messageBuffer: {} as never,
      mcpServers: {},
      permissionHandler: {} as never,
      getPermissionMode: () => 'default',
      setThinking: () => undefined,
      memoryRecallGuidanceEnabled: false,
    });

    const operations = (created as Readonly<{ operations: RuntimeTurnOperations }>).operations;
    await operations.sendTurnPrompt('hello', { userMessageSeq: 42, modelId: 'opencode/big-pickle' });

    expect(runtime.sendTurnPrompt).toHaveBeenCalledWith(
      'hello',
      { modelId: 'opencode/big-pickle', userMessageSeq: 42 },
    );
  });

  it('passes provider-acceptance user message seqs to native Agent steer operations', async () => {
    const runtime = createRuntimeTurnOperations();
    const plan = await createPublicPluginSessionRuntimePlan({
      backend: createBackendFixture(),
      agent: createAgentFixture(),
      createSessionRuntime: async () => runtime,
      sessionInput: buildPluginSessionBindingInput({
        credentials,
        directory: '/tmp/plugin-backend',
      }),
    });

    const created = await plan.config.createSessionRuntime?.({
      directory: '/tmp/plugin-backend',
      metadata: {} as never,
      machineId: 'machine-1',
      session: { sessionId: 'host-session-1' } as never,
      transcriptSession: {} as never,
      messageBuffer: {} as never,
      mcpServers: {},
      permissionHandler: {} as never,
      getPermissionMode: () => 'default',
      setThinking: () => undefined,
      memoryRecallGuidanceEnabled: false,
    });

    const operations = (created as Readonly<{ operations: RuntimeTurnOperations }>).operations;
    await operations.steerInFlightTurn('hello steer', { userMessageSeq: 43 });

    expect(runtime.steerInFlightTurn).toHaveBeenCalledWith('hello steer', { userMessageSeq: 43 });
  });

  it('forwards permission-mode runtime config updates to native Agent operations', async () => {
    const updateConfig = vi.fn(async () => undefined);
    const runtime = {
      ...createRuntimeTurnOperations(),
      updateSessionRuntimeConfig: updateConfig,
    };
    const plan = await createPublicPluginSessionRuntimePlan({
      backend: createBackendFixture(),
      agent: createAgentFixture(),
      createSessionRuntime: async () => runtime,
      sessionInput: buildPluginSessionBindingInput({
        credentials,
        directory: '/tmp/plugin-backend',
      }),
    });

    const created = await plan.config.createSessionRuntime?.({
      directory: '/tmp/plugin-backend',
      metadata: {} as never,
      machineId: 'machine-1',
      session: { sessionId: 'host-session-1' } as never,
      transcriptSession: {} as never,
      messageBuffer: {} as never,
      mcpServers: {},
      permissionHandler: {} as never,
      getPermissionMode: () => 'default',
      setThinking: () => undefined,
      memoryRecallGuidanceEnabled: false,
    });

    const operations = (created as Readonly<{ operations: RuntimeTurnOperations }>).operations;
    await operations.updateSessionRuntimeConfig({ permissionMode: 'read-only' });

    expect(updateConfig).toHaveBeenCalledWith({ permissionMode: 'read-only' });
  });

  it('passes explicit provider resume ids through the native open intent', async () => {
    let capturedOpenIntent: unknown = null;
    const runtime = createRuntimeTurnOperations();
    const plan = await createPublicPluginSessionRuntimePlan({
      backend: createBackendFixture(),
      agent: createAgentFixture(),
      createSessionRuntime: async (params) => {
        capturedOpenIntent = params;
        return runtime;
      },
      sessionInput: buildPluginSessionBindingInput({
        credentials,
        directory: '/tmp/plugin-backend',
        resume: 'vendor-session-1',
      }),
    });

    await plan.config.createSessionRuntime?.({
      directory: '/tmp/plugin-backend',
      metadata: {} as never,
      machineId: 'machine-1',
      session: { sessionId: 'host-session-1' } as never,
      transcriptSession: {} as never,
      messageBuffer: {} as never,
      mcpServers: {},
      permissionHandler: {} as never,
      getPermissionMode: () => 'default',
      setThinking: () => undefined,
      memoryRecallGuidanceEnabled: false,
    });

    expect(capturedOpenIntent).toEqual({
      kind: 'resume',
      providerSessionId: 'vendor-session-1',
      importHistory: true,
    });
  });

  it('does not advertise unsupported public provider-acceptance hook setters', async () => {
    const runtime = createRuntimeTurnOperations();
    const plan = await createPublicPluginSessionRuntimePlan({
      backend: createBackendFixture(),
      agent: createAgentFixture(),
      createSessionRuntime: async () => runtime,
      sessionInput: buildPluginSessionBindingInput({
        credentials,
        directory: '/tmp/plugin-backend',
      }),
    });

    const created = await plan.config.createSessionRuntime?.({
      directory: '/tmp/plugin-backend',
      metadata: {} as never,
      machineId: 'machine-1',
      session: { sessionId: 'host-session-1' } as never,
      transcriptSession: {} as never,
      messageBuffer: {} as never,
      mcpServers: {},
      permissionHandler: {} as never,
      getPermissionMode: () => 'default',
      setThinking: () => undefined,
      memoryRecallGuidanceEnabled: false,
    });

    const operations = (created as Readonly<{
      operations: RuntimeTurnOperations & Record<string, unknown>;
    }>).operations;

    expect(operations.setOnPromptAcceptedByProvider).toBeUndefined();
    expect(typeof operations.setOnPromptTerminallyRejectedBeforeProvider).toBe('function');
  });

  it('preserves provider-acceptance user message seqs through runtime metadata decoration', async () => {
    const runtime = createRuntimeTurnOperations();
    const decorated = decorateRuntimeTurnOperationsWithMetadata({
      runtime,
      runtimeDescriptor: null,
      runtimeCapabilities: null,
      runtimeFacets: null,
    });

    await decorated.sendTurnPrompt('hello', { userMessageSeq: 77 });

    expect(runtime.sendTurnPrompt).toHaveBeenCalledWith('hello', { userMessageSeq: 77 });
  });

  it('preserves provider-acceptance steer user message seqs through runtime metadata decoration', async () => {
    const runtime = createRuntimeTurnOperations();
    const decorated = decorateRuntimeTurnOperationsWithMetadata({
      runtime,
      runtimeDescriptor: null,
      runtimeCapabilities: null,
      runtimeFacets: null,
    });

    await decorated.steerInFlightTurn('hello steer', { userMessageSeq: 78 });

    expect(runtime.steerInFlightTurn).toHaveBeenCalledWith('hello steer', { userMessageSeq: 78 });
  });

  it('preserves provider-acceptance and terminal-rejection hooks through runtime metadata decoration', () => {
    const setOnPromptAcceptedByProvider = vi.fn();
    const setOnPromptTerminallyRejectedBeforeProvider = vi.fn();
    const runtime = {
      ...createRuntimeTurnOperations(),
      setOnPromptAcceptedByProvider,
      setOnPromptTerminallyRejectedBeforeProvider,
    };
    const decorated = decorateRuntimeTurnOperationsWithMetadata({
      runtime,
      runtimeDescriptor: null,
      runtimeCapabilities: null,
      runtimeFacets: null,
    }) as typeof runtime;
    const acceptedHandler = vi.fn();
    const rejectedHandler = vi.fn();

    expect(typeof decorated.setOnPromptAcceptedByProvider).toBe('function');
    expect(typeof decorated.setOnPromptTerminallyRejectedBeforeProvider).toBe('function');

    decorated.setOnPromptAcceptedByProvider(acceptedHandler);
    decorated.setOnPromptTerminallyRejectedBeforeProvider(rejectedHandler);

    expect(setOnPromptAcceptedByProvider).toHaveBeenCalledWith(acceptedHandler);
    expect(setOnPromptTerminallyRejectedBeforeProvider).toHaveBeenCalledWith(rejectedHandler);
  });

  it('rebinds canonical native operations after reset and fences stale predecessor events', async () => {
    const lifecycleOrder: string[] = [];
    const firstEventHandlers: Array<(event: never) => void> = [];
    const secondEventHandlers: Array<(event: never) => void> = [];
    const firstInterruptPendingInputAndRun = vi.fn(async (request: Readonly<{
      sessionId: string;
      localId: string;
      expectedStateAtMs?: number;
    }>) => ({ ok: true as const, status: 'accepted' as const, ...request }));
    const secondInterruptPendingInputAndRun = vi.fn(async (request: Readonly<{
      sessionId: string;
      localId: string;
      expectedStateAtMs?: number;
    }>) => ({ ok: true as const, status: 'accepted' as const, ...request }));
    const first = {
      ...createRuntimeTurnOperations(),
      interruptPendingInputAndRun: firstInterruptPendingInputAndRun,
      sendTurnPrompt: vi.fn(async (prompt: string) => {
        lifecycleOrder.push(`first-prompt:${prompt}`);
      }),
      waitForTurnCompletion: vi.fn(async () => {
        lifecycleOrder.push('first-terminal');
      }),
      resetOrDisposeRuntime: vi.fn(async () => {
        lifecycleOrder.push('first-disposed');
      }),
      subscribeRuntimeEvents: vi.fn((handler: (event: never) => void) => {
        firstEventHandlers.push(handler);
        return () => undefined;
      }),
    };
    const second = {
      ...createRuntimeTurnOperations(),
      interruptPendingInputAndRun: secondInterruptPendingInputAndRun,
      sendTurnPrompt: vi.fn(async (prompt: string) => {
        lifecycleOrder.push(`second-prompt:${prompt}`);
      }),
      subscribeRuntimeEvents: vi.fn((handler: (event: never) => void) => {
        secondEventHandlers.push(handler);
        return () => undefined;
      }),
    };
    const createSessionRuntime = vi.fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    const plan = await createPublicPluginSessionRuntimePlan({
      backend: createBackendFixture(),
      agent: createAgentFixture(),
      createSessionRuntime,
      sessionInput: buildPluginSessionBindingInput({ credentials }),
    });
    const created = await plan.config.createSessionRuntime?.(createHostFactoryParams());
    const operations = (created as Readonly<{
      operations: RuntimeTurnOperations & Readonly<{
        setRuntimeReplacementLifecycle(lifecycle: Readonly<{
          beforeReplacement(): Promise<void>;
          onSuccessorBound(): Promise<void>;
          onSuccessorUsable(): Promise<void>;
        }>): void;
        interruptPendingInputAndRun(request: Readonly<{
          sessionId: string;
          localId: string;
          expectedStateAtMs?: number;
        }>): Promise<unknown> | unknown;
      }>;
    }>).operations;
    operations.setRuntimeReplacementLifecycle({
      beforeReplacement: async () => { lifecycleOrder.push('before'); },
      onSuccessorBound: async () => { lifecycleOrder.push('bound'); },
      onSuccessorUsable: async () => { lifecycleOrder.push('usable'); },
    });
    const observed: unknown[] = [];
    operations.subscribeRuntimeEvents((event) => observed.push(event));

    await operations.sendTurnPrompt('first');
    await expect(operations.interruptPendingInputAndRun({
      sessionId: 'host-session-1',
      localId: 'pending-first',
      expectedStateAtMs: 1,
    })).resolves.toMatchObject({
      ok: true,
      localId: 'pending-first',
    });
    await operations.waitForTurnCompletion();
    await operations.resetOrDisposeRuntime('runtime_recovery', {
      kind: 'resume',
      providerSessionId: 'provider-successor',
      importHistory: false,
    });
    await operations.sendTurnPrompt('second');
    await expect(operations.interruptPendingInputAndRun({
      sessionId: 'host-session-1',
      localId: 'pending-second',
      expectedStateAtMs: 2,
    })).resolves.toMatchObject({
      ok: true,
      localId: 'pending-second',
    });

    const event = {
      kind: 'turn-start',
      sessionId: 'host-session-1',
      turnId: 'turn-1',
      emittedAtMs: 1,
    } as never;
    firstEventHandlers[0]?.(event);
    secondEventHandlers[0]?.(event);

    expect(observed).toEqual([event]);
    expect(lifecycleOrder).toEqual([
      'first-prompt:first',
      'first-terminal',
      'before',
      'first-disposed',
      'bound',
      'usable',
      'second-prompt:second',
    ]);
    expect(first.sendTurnPrompt).toHaveBeenCalledOnce();
    expect(firstInterruptPendingInputAndRun).toHaveBeenCalledWith({
      sessionId: 'host-session-1',
      localId: 'pending-first',
      expectedStateAtMs: 1,
    });
    expect(first.resetOrDisposeRuntime).toHaveBeenCalledOnce();
    expect(second.sendTurnPrompt).toHaveBeenCalledOnce();
    expect(secondInterruptPendingInputAndRun).toHaveBeenCalledWith({
      sessionId: 'host-session-1',
      localId: 'pending-second',
      expectedStateAtMs: 2,
    });
    expect(second.resetOrDisposeRuntime).not.toHaveBeenCalled();
    expect(createSessionRuntime).toHaveBeenCalledTimes(2);
    expect(createSessionRuntime.mock.calls[1]?.[0]).toMatchObject({
      kind: 'resume',
      providerSessionId: 'provider-successor',
      importHistory: false,
    });
  });

  it('fails closed when a successor drops an activated prompt-delivery outcome seam', async () => {
    const firstSetOutcome = vi.fn();
    const first = {
      ...createRuntimeTurnOperations(),
      setOnPromptDeliveryOutcome: firstSetOutcome,
    };
    const second = createRuntimeTurnOperations();
    const createSessionRuntime = vi.fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    const plan = await createPublicPluginSessionRuntimePlan({
      backend: createBackendFixture(),
      agent: createAgentFixture(),
      createSessionRuntime,
      sessionInput: buildPluginSessionBindingInput({ credentials }),
    });
    const created = await plan.config.createSessionRuntime?.(createHostFactoryParams());
    const operations = (created as Readonly<{
      operations: RuntimeTurnOperations & Readonly<{
        setOnPromptDeliveryOutcome(handler: ((outcome: unknown) => void) | null): void;
      }>;
    }>).operations;
    operations.setOnPromptDeliveryOutcome(vi.fn());

    await expect(operations.resetOrDisposeRuntime('runtime_recovery', {
      kind: 'resume',
      providerSessionId: 'provider-successor',
      importHistory: false,
    }))
      .rejects.toThrow(/dropped its prompt-delivery-outcome seam/i);

    expect(firstSetOutcome).toHaveBeenCalledOnce();
    expect(second.resetOrDisposeRuntime).toHaveBeenCalledOnce();
  });
});
