import { describe, expect, it, vi } from 'vitest';

import type { RuntimeTurnOperations } from '@/agent/runtime/turns/runtimeTurnOperations';
import type { Credentials, StoredCredentials } from '@/persistence';
import { logger } from '@/ui/logger';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';
import { createCurrentSessionPresentationHost } from '@/session/presentation/currentSessionPresentationService';
import { createNativeAgentSessionOperations } from '@/agent/runtime/registry/engineRegistry/nativeAgentSession';
import { createNativeAgentSessionPublications } from '@/agent/runtime/registry/engineRegistry/nativeAgentSessionPublications';
import { createSessionRuntimeModesPublisher } from '@/agent/runtime/controls/sessionRuntimeModesPublisher';
import { computeSessionModePickerControl } from '../../../../../../ui/sources/sync/domains/sessionControl/sessionModeControl';
import { MetadataSchema } from '@happier-dev/session-core/state';
import { projectAgentPreflightSessionControlsCatalogEntry } from '@/plugins/projection/registry/agentCatalogEntryHooks';
import { probeAgentModesBestEffort } from '@/capabilities/probes/agentModesProbe';
import { preflightCatalogEntryFixture } from '@/capabilities/probes/preflightSessionControlsProbeAdapter.testkit';
import { bindSessionProviderInputOutcome, createSessionProviderInputOutcomeNormalizer, type SessionProviderInputOutcome } from '@/agent/runtime/session/input/providerInputOutcome';
import type { AgentSessionModesSnapshot, AgentSessionRuntime, AgentSessionRuntimeContext } from '@happier-dev/plugin-sdk/agents/runtime';
import {
  ProviderConnectionIdSchema,
  PluginAgentContributionV2Schema,
  PluginBackendDefinitionV1Schema,
  SessionCreationCorrespondenceV1Schema,
  deriveSessionCreationTagV1,
  type ProviderBoundModelRef,
  type TeamCredentialProviderModelSelectionV1,
} from '@happier-dev/protocol';

import {
    createNativeAgentHostSessionRuntimePlan as createPublicPluginSessionRuntimePlan,
} from './session';
import { buildPluginHostSessionRuntimeOptions, buildPluginSessionBindingInput } from './sessionLaunch';
import type {
  ResolvedAgentContribution,
  ResolvedAgentRuntimeContribution,
} from '@/plugins/projection/registry/types';

const releasedCacheMocks = vi.hoisted(() => ({
  resolve: vi.fn(),
  compatibility: {
    read: vi.fn(),
    write: vi.fn(),
  },
}));

vi.mock('@/agent/runtime/startup/releasedStartupOverridesCacheV1', () => ({
  resolveReleasedCodexStartupOverridesCacheV1Compatibility: releasedCacheMocks.resolve,
}));

vi.mock('@/persistence', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/persistence')>(),
  readSettings: vi.fn(async () => ({ machineId: 'machine-1' })),
}));

const credentials: Credentials = {
  token: 'test-token',
  encryption: {
    type: 'legacy',
    secret: new Uint8Array([1, 2, 3]),
  },
};
const tokenOnlyCredentials = {
  token: 'plain-account-token',
  encryption: null,
} satisfies StoredCredentials;

function createBackendFixture(): ResolvedAgentRuntimeContribution {
  const definition = PluginBackendDefinitionV1Schema.parse({
    id: 'acme.sample.backend',
    agentId: 'acme.sample.provider',
    catalogAgentId: 'claude',
  });
  return {
    id: 'acme.sample.backend',
    agentId: 'acme.sample.provider',
    provenance: 'external',
    source: { kind: 'path' },
    runtimeKind: 'native',
    richDefinition: {
      provenance: 'external',
      definition,
    },
    definition: {
      kindVersion: 1,
      id: 'acme.sample.backend',
      agentId: 'acme.sample.provider',
    },
  };
}

function createAgentFixture(): ResolvedAgentContribution {
  const definition = PluginAgentContributionV2Schema.parse({
    id: 'sample-provider',
    title: 'Acme Sample Provider',
    runtime: { kind: 'custom' },
    primary: 'sessions',
    capabilities: {
      sessions: {
        open: ['create'],
        delivery: ['newTurn'],
        cancel: true,
      },
    },
  });
  return {
    id: 'acme.sample.provider',
    provenance: 'external',
    source: { kind: 'path' },
    runtimeSpec: {
      id: 'acme.sample.provider',
      title: 'Acme Sample Provider',
      binaryName: 'acme-sample-provider',
      knownUserBinDirSuffixes: null,
      sourcePreferenceDefault: 'system-first',
      managedInstall: null,
      manualInstallKind: 'none',
      manualInstallRecipes: null,
      acceptsJavaScriptFileOverride: false,
    },
    richDefinition: {
      provenance: 'external',
      definition,
    },
    definition: {
      kindVersion: 1,
      id: 'acme.sample.provider',
      ownedBackendIds: ['acme.sample.backend'],
    },
  };
}

function createRuntimeTurnOperations(): RuntimeTurnOperations & Readonly<{
  sendTurnPrompt: ReturnType<typeof vi.fn>;
  setOnPromptDeliveryOutcome: ReturnType<typeof vi.fn>;
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
    setOnPromptDeliveryOutcome: vi.fn(),
  };
}

function createHostFactoryParams() {
  const session = createMutableApiSessionClientFixture({ overrides: { sessionId: 'host-session-1' } });
  return {
    directory: '/tmp/plugin-backend',
    metadata: {} as never,
    machineId: 'machine-1',
    agentTargetKey: 'agent:happier.agent.claude/claude',
    session,
    currentSessionPresentation: createCurrentSessionPresentationHost({
      session,
      signal: new AbortController().signal,
    }).bindCurrentSession,
    transcriptSession: {} as never,
    messageBuffer: {} as never,
    mcpServers: {},
    permissionHandler: {} as never,
    getPermissionMode: () => 'default' as const,
    memoryRecallGuidanceEnabled: false,
    runnerProcessIdentity: null,
    startupModelSelection: null,
    runWithTerminalModelSelection: async <T>(
      effect: (
        selection: ProviderBoundModelRef | null,
        runWithCurrentPublisherPermit: <U>(
          localEffect: () => Promise<U>,
        ) => Promise<
          | Readonly<{ status: 'completed'; value: U }>
          | Readonly<{ status: 'blocked' }>
        >,
      ) => Promise<T>,
    ) => ({
      status: 'completed' as const,
      value: await effect(
        null,
        async <U>(localEffect: () => Promise<U>) => ({
          status: 'completed' as const,
          value: await localEffect(),
        }),
      ),
    }),
  };
}

describe('plugin session runtime adapters', () => {
  it.each([true, false])('retains native mode publication through the replaceable runtime into composer options (producer bound: %s)', async (bound) => {
    const host = createHostFactoryParams();
    const agentId = 'acme.sample.provider';
    const sources: Array<{ publish(snapshot: AgentSessionModesSnapshot): void; stalePublish(snapshot: AgentSessionModesSnapshot): void }> = [];
    let generation = 0;
    let nativePublication: ReturnType<typeof createNativeAgentSessionPublications> | null = null;
    const plan = await createPublicPluginSessionRuntimePlan({
      backend: createBackendFixture(), agent: createAgentFixture(), policyAgentId: agentId,
      sessionInput: buildPluginSessionBindingInput({ credentials: tokenOnlyCredentials, startedBy: 'daemon', startingMode: 'remote' }),
      createSessionRuntime: async () => {
        const modeId = generation++ === 0 ? 'build' : 'plan';
        let snapshot: AgentSessionModesSnapshot = { observedAt: generation, modes: [{ id: modeId, name: modeId }], currentModeId: modeId };
        const listeners = new Set<(value: AgentSessionModesSnapshot) => void>();
        const staleListeners = new Set<(value: AgentSessionModesSnapshot) => void>();
        const publications = createNativeAgentSessionPublications({ agentId, session: host.session,
          signal: new AbortController().signal, isCurrent: () => true, supportsInFlightSteer: false });
        nativePublication = publications;
        // An external native Agent is the boundary. Publication, replacement,
        // metadata projection and the composer's exact consumer remain real.
        if (bound) publications.services.modes.bind({ read: () => snapshot, subscribe(listener) {
          listeners.add(listener); staleListeners.add(listener);
          return { dispose: () => { listeners.delete(listener); } };
        } });
        sources.push({ publish(value) { snapshot = value; for (const listener of listeners) listener(value); },
          stalePublish(value) { for (const listener of staleListeners) listener(value); } });
        const native: AgentSessionRuntime = { send: async () => ({ status: 'admitted' }), watch: () => ({ dispose() {} }),
          dispose: async () => { publications.dispose(); } };
        return createNativeAgentSessionOperations(native, 'host-session-1', undefined, undefined, undefined, undefined, undefined, {
          context: { signal: new AbortController().signal } as AgentSessionRuntimeContext,
          cwd: host.directory, connectedAccounts: [], capabilities: { open: ['create'], delivery: ['newTurn'], cancel: false },
          cancellation: { declared: false }, configuration: { declared: false }, manualCompaction: { declared: false },
        }, publications);
      },
    });
    const runtime = (await plan.config.createSessionRuntime?.(host))?.nativeRuntime;
    if (!runtime) throw new Error('Missing composed native runtime');
    const projector = runtime.modes ? createSessionRuntimeModesPublisher({ agentId, session: host.session, source: runtime.modes }) : null;
    // The UI reads Session metadata through the shared stored-metadata parser.
    const control = () => {
      const snapshot = host.session.getMetadataSnapshot();
      return computeSessionModePickerControl({ agentId, metadata: snapshot ? MetadataSchema.parse(snapshot) : null });
    };
    const projected = projectAgentPreflightSessionControlsCatalogEntry({ agentId, systemTools: [],
      // This external Agent's native observation is also its preflight producer.
      preflightSessionControls: { probeModes: async () => nativePublication?.modesSource.read().modes ?? null },
      retirementSignal: new AbortController().signal, isCurrent: () => true });
    const adapter = await projected.getPreflightSessionControlsProbeAdapter!();
    if (!adapter) throw new Error('Missing external Agent preflight projection');
    const probe = () => probeAgentModesBestEffort({ agentId, cwd: `${host.directory}/${generation}/${bound}`,
      catalogEntry: preflightCatalogEntryFixture('claude', adapter) });
    try {
      await projector?.flush();
      expect(control()?.options ?? []).toEqual(bound ? [{ id: 'build', name: 'build' }] : []);
      expect(control()?.currentModeId ?? null).toBe(bound ? 'build' : null);
      expect(await probe()).toMatchObject({ source: bound ? 'dynamic' : 'unavailable', availableModes: control()?.options ?? [] });
      await runtime.resetOrDisposeRuntime('runtime_recovery', { kind: 'create' });
      await projector?.flush();
      expect(control()?.options ?? []).toEqual(bound ? [{ id: 'plan', name: 'plan' }] : []);
      expect(await probe()).toMatchObject({ source: bound ? 'dynamic' : 'unavailable', availableModes: control()?.options ?? [] });
      sources[0]!.stalePublish({ modes: [{ id: 'stale', name: 'Stale' }], currentModeId: 'stale' });
      await projector?.flush();
      expect(control()?.currentModeId ?? null).toBe(bound ? 'plan' : null);
      sources[1]!.publish({ observedAt: 3, modes: [], currentModeId: 'plan' });
      await projector?.flush();
      expect(control()).toBeNull();
    } finally { await runtime.resetOrDisposeRuntime(); await projector?.stopAndDrain(); }
  });

  it.each([false, true])('preserves exact native custody through composed runtime retirement (cleanup fails: %s)', async (cleanupFails) => {
    const cleanupFailure = new Error('native cleanup failed');
    let finishCleanup!: () => void;
    const cleanup = new Promise<void>(resolve => { finishCleanup = resolve; });
    let cleanupEntered!: () => void;
    const disposing = new Promise<void>(resolve => { cleanupEntered = resolve; });
    // The native process is the boundary. Host correlation, replacement and
    // Pending outcome normalization below use their production composition.
    const native: AgentSessionRuntime = {
      send: async () => ({ status: 'admitted' }),
      watch: () => ({ dispose() {} }),
      dispose: async () => {
        cleanupEntered();
        await cleanup;
        if (cleanupFails) throw cleanupFailure;
      },
    };
    const operations = createNativeAgentSessionOperations(native, 'host-session-1', undefined, undefined, undefined, undefined, undefined, {
      context: { signal: new AbortController().signal } as AgentSessionRuntimeContext,
      cwd: '/tmp/plugin-backend', connectedAccounts: [],
      capabilities: { open: ['create'], delivery: ['newTurn'], cancel: false },
      cancellation: { declared: false }, configuration: { declared: false }, manualCompaction: { declared: false },
    });
    const plan = await createPublicPluginSessionRuntimePlan({
      backend: createBackendFixture(), agent: createAgentFixture(),
      createSessionRuntime: async () => operations,
      sessionInput: buildPluginSessionBindingInput({ credentials, startedBy: 'daemon', startingMode: 'remote' }),
    });
    const created = await plan.config.createSessionRuntime?.(createHostFactoryParams());
    const runtime = created?.nativeRuntime;
    if (!runtime) throw new Error('Missing composed native runtime');
    const settlements: SessionProviderInputOutcome[] = [];
    const target = {
      sessionId: 'host-session-1', hasPendingProviderInput: (localId: string) => localId === 'native-retirement-input',
      observeProviderInputSettlement: (outcome: SessionProviderInputOutcome) => { settlements.push(outcome); },
    };
    const unbind = bindSessionProviderInputOutcome({
      runtime,
      observe: createSessionProviderInputOutcomeNormalizer({ getTarget: () => target }),
      wakePendingMaterialization: () => undefined,
    });
    await runtime.sendTurnPrompt('waiting for native trust', { localId: 'native-retirement-input', turnId: 'native-retirement-turn' });
    await runtime.cancelTurn();
    const retirement = runtime.resetOrDisposeRuntime('session_closed');
    const result = cleanupFails ? expect(retirement).rejects.toBe(cleanupFailure) : retirement;
    try {
      await disposing;
      expect(settlements).toEqual([{
        kind: 'effect_may_have_occurred', localId: 'native-retirement-input', userMessageSeq: null,
        issue: { code: 'native_runtime_disposed_with_input_in_flight', severity: 'warning' },
      }]);
    } finally {
      finishCleanup();
      await result;
      unbind();
    }
  });

  it('threads the exact selected Agent provider declaration into the host runtime plan', async () => {
    const providerRequirements = Object.freeze({
      acceptsProtocols: ['openai-responses'],
      required: { streaming: true },
      credentialSupport: {
        supportsNoAuth: true,
        apiKeyTransports: [],
      },
      authIsolation: {
        suppressConnectedServiceIds: [],
        ownedEnvKeys: ['EXTERNAL_PROVIDER_TOKEN'],
      },
      materialization: 'spawnEnv',
      applyPolicy: 'restart_session',
      supportsFreeformModelIds: true,
    });
    const baseAgent = createAgentFixture() as unknown as Record<
      string,
      unknown
    >;
    const agent = {
      ...baseAgent,
      richDefinition: {
        provenance: 'external',
        definition: {
          ...createAgentFixture().richDefinition!.definition,
          providerRequirements,
        },
      },
    } as never;
    const sessionInput = buildPluginSessionBindingInput({ credentials });
    const nativePlan = await createPublicPluginSessionRuntimePlan({
      backend: createBackendFixture(),
      agent,
      createSessionRuntime: async () => createRuntimeTurnOperations(),
      sessionInput,
    });
    expect(nativePlan.config.providerRequirements)
      .toBe(providerRequirements);
  });

  it('preserves token-only credentials through the host runtime binding', () => {
    const input = buildPluginSessionBindingInput({
      credentials: tokenOnlyCredentials,
    });

    expect(input.credentials).toEqual(tokenOnlyCredentials);
    expect(buildPluginHostSessionRuntimeOptions(input).credentials).toEqual(tokenOnlyCredentials);
  });

  it('rejects malformed credentials at the untyped session launch boundary', () => {
    expect(() => buildPluginSessionBindingInput({
      credentials: { token: 'malformed', encryption: { type: 'legacy' } },
    })).toThrow(/credentials/i);
  });

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

  it('preserves opaque Agent resume bytes through the plugin session binding round trip', () => {
    const opaqueResumeId = ' provider\nsession ';
    const input = buildPluginSessionBindingInput({ credentials, resume: opaqueResumeId });

    expect(input.resume.resumeSessionId).toBe(opaqueResumeId);
    expect(buildPluginHostSessionRuntimeOptions(input)).toMatchObject({ resume: opaqueResumeId });
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

  it('preserves the admitted spawn identity through the plugin host runtime binding', () => {
    const sessionCreationTag = deriveSessionCreationTagV1({
      callerCreationNamespace: 'plugin:acme.plugin',
      creationKey: 'external-action-spawn',
    });
    const sessionCreationCorrespondence = SessionCreationCorrespondenceV1Schema.parse({
      v: 1,
      sessionCreationTag,
      recipe: {
        execution: { machineId: 'machine-1', directory: { kind: 'path', path: '/tmp/plugin-backend' } },
        organization: { folderId: null, tagIds: [] },
        agentTarget: {
          kind: 'agent',
          identity: { pluginId: 'happier.agent.claude', localId: 'claude' },
        },
        modelSelection: null,
        profileId: null,
        requestedPermissionMode: null,
        agentModeId: null,
        configuration: null,
        connectedServices: null,
        capabilitySelection: null,
        transcriptStorage: null,
        terminal: null,
        agentSessionStartupInstructionsMarkerV1: null,
        checkout: null,
      },
    });

    const options = buildPluginHostSessionRuntimeOptions(
      buildPluginSessionBindingInput({
        credentials,
        sessionCreationTag,
        sessionCreationCorrespondence,
      }),
    );

    expect(options.sessionCreationTag).toBe(sessionCreationTag);
    expect(options.sessionCreationCorrespondence).toEqual(sessionCreationCorrespondence);

  });

  it('consumes provider-owned deferred-startup policy on the native Agent plan', async () => {
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
      hasExistingSession: true,
      hasSessionAttachFile: true,
      hasProviderResumeId: true,
      hasExplicitPermissionMode: true,
      hasPersistedPermissionModeSeed: false,
      hasTerminalTty: expect.any(Boolean),
    });
  });

  it('does not authorize an offline Session stub for native Agent startup', async () => {
    const baseAgent = createAgentFixture() as unknown as Record<string, unknown>;
    const plan = await createPublicPluginSessionRuntimePlan({
      backend: createBackendFixture(),
      agent: {
        ...baseAgent,
        catalogEntry: {
          id: 'acme.sample.provider',
          cliSubcommand: 'acme.sample.provider',
          shouldUseDeferredSessionStartup: () => true,
        },
      } as never,
      createSessionRuntime: async () => createRuntimeTurnOperations(),
      sessionInput: buildPluginSessionBindingInput({ credentials }),
    });
    const create = plan.config.startupBootstrap?.create;
    if (!create) throw new Error('expected deferred startup factory');
    const createPreparedDeferredStartupBootstrap = vi.fn(async (_params: unknown) => ({} as never));

    await create({
      opts: {
        ...plan.opts,
        launchControlMetadata: {} as never,
      },
      seed: {
        permissionMode: 'default',
        permissionModeUpdatedAt: 1,
        permissionModeSource: 'fallback',
        modelSelection: null,
      },
      createPreparedDeferredStartupBootstrap,
    });

    expect(createPreparedDeferredStartupBootstrap).toHaveBeenCalledOnce();
    expect(createPreparedDeferredStartupBootstrap.mock.calls[0]?.[0]).not.toHaveProperty(
      'allowOfflineStub',
    );
  });

  it('does not retain deferred-startup failure details in logs', async () => {
    const privatePayload = 'VOICE_PRIVATE_STARTUP_CONTROL_PAYLOAD';
    const debug = vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
    const baseAgent = createAgentFixture() as unknown as Record<string, unknown>;
    const plan = await createPublicPluginSessionRuntimePlan({
      backend: createBackendFixture(),
      agent: {
        ...baseAgent,
        catalogEntry: {
          id: 'acme.sample.provider',
          cliSubcommand: 'acme.sample.provider',
          shouldUseDeferredSessionStartup: () => true,
        },
      } as never,
      createSessionRuntime: async () => createRuntimeTurnOperations(),
      sessionInput: buildPluginSessionBindingInput({ credentials }),
    });
    const create = plan.config.startupBootstrap?.create;
    if (!create) throw new Error('expected deferred startup factory');

    await create({
      opts: {
        ...plan.opts,
        launchControlMetadata: {} as never,
      },
      seed: {
        permissionMode: 'default',
        permissionModeUpdatedAt: 1,
        permissionModeSource: 'fallback',
        modelSelection: null,
      },
      createPreparedDeferredStartupBootstrap: async (params) => {
        await params.onBackgroundStartFailure?.(
          new Error(privatePayload),
          { timing: {} as never },
        );
        return {} as never;
      },
    });

    expect(debug).toHaveBeenCalledWith(
      expect.stringContaining('Deferred Session startup failed'),
    );
    expect(JSON.stringify(debug.mock.calls)).not.toContain(privatePayload);
    debug.mockRestore();
  });

  it('adopts the deployed Codex V1 cache only as a lowest-priority provider-resume seed', async () => {
    releasedCacheMocks.resolve.mockImplementation((backendId: string) => (
      backendId === 'codex' ? releasedCacheMocks.compatibility : null
    ));
    releasedCacheMocks.compatibility.read.mockReturnValue({
      permissionMode: 'safe-yolo',
      permissionModeUpdatedAt: 101,
      modelId: 'cached-codex-model',
      modelUpdatedAt: 102,
      updatedAt: 103,
    });
    const baseAgent = createAgentFixture() as unknown as Record<string, unknown>;
    const backend = {
      ...createBackendFixture(),
      id: 'codex',
      agentId: 'codex',
    } as never;
    const agent = {
      ...baseAgent,
      catalogEntry: {
        id: 'codex',
        cliSubcommand: 'codex',
        shouldUseDeferredSessionStartup: () => true,
      },
    } as never;
    const plan = await createPublicPluginSessionRuntimePlan({
      backend,
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

    expect(releasedCacheMocks.resolve).toHaveBeenCalledWith('codex');

    releasedCacheMocks.compatibility.read.mockClear();
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
    expect(releasedCacheMocks.compatibility.read).not.toHaveBeenCalled();

    releasedCacheMocks.compatibility.read.mockReturnValue({
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

    releasedCacheMocks.compatibility.read.mockReturnValue({
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
    expect(releasedCacheMocks.compatibility.write).toHaveBeenCalledWith(expect.objectContaining({
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
          agentTargetKey: 'agent:happier.agent.codex/codex',
          providerConnectionId: 'pc_work',
          modelId: 'provider-model',
        },
      },
    });

    expect(input.runtimePreferences.modelSelection).toEqual({
      v: 1,
      updatedAt: 56,
      ref: {
        agentTargetKey: 'agent:happier.agent.codex/codex',
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
        agentTargetKey: 'agent:happier.agent.codex/codex',
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
          agentTargetKey: 'agent:happier.agent.codex/codex',
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
          agentTargetKey: 'agent:happier.agent.codex/codex',
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
          ...createAgentFixture().richDefinition!.definition,
          capabilities: {
            sessions: {
              open: ['create'],
              delivery: ['newTurn'],
              cancel: true,
              runtimeActivitySnapshots: true,
            },
          },
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
          ...createAgentFixture().richDefinition!.definition,
          capabilities: {
            sessions: {
              open: ['create'],
              delivery: ['newTurn'],
              cancel: true,
              runtimeActivitySnapshots: true,
            },
          },
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

    const created = await plan.config.createSessionRuntime?.(createHostFactoryParams());

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

    const created = await plan.config.createSessionRuntime?.(createHostFactoryParams());

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

    const created = await plan.config.createSessionRuntime?.(createHostFactoryParams());

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

    await plan.config.createSessionRuntime?.(createHostFactoryParams());

    expect(capturedOpenIntent).toEqual({
      kind: 'resume',
      providerSessionId: 'vendor-session-1',
      importHistory: true,
    });
  });

  it('hands the Agent its own opaque resume bytes through the native open intent', async () => {
    // The Agent minted this id; `session/load` must receive it byte for byte.
    const opaqueResumeId = ' provider\nsession ';
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
        resume: opaqueResumeId,
      }),
    });

    await plan.config.createSessionRuntime?.(createHostFactoryParams());

    expect(capturedOpenIntent).toEqual({
      kind: 'resume',
      providerSessionId: opaqueResumeId,
      importHistory: true,
    });
  });

  it('carries strict native-return identity only from the matching host intent', async () => {
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
      ...createHostFactoryParams(),
      strictNativeResumeIdentity: true,
    });

    expect(capturedOpenIntent).toEqual({
      kind: 'resume',
      providerSessionId: 'vendor-session-1',
      importHistory: true,
      strictNativeResumeIdentity: true,
    });
  });

  it('rejects a hookless public plugin Session runtime before host admission', async () => {
    const { setOnPromptDeliveryOutcome: _omittedOutcomePort, ...runtime } = createRuntimeTurnOperations();
    const plan = await createPublicPluginSessionRuntimePlan({
      backend: createBackendFixture(),
      agent: createAgentFixture(),
      createSessionRuntime: async () => runtime as never,
      sessionInput: buildPluginSessionBindingInput({
        credentials,
        directory: '/tmp/plugin-backend',
      }),
    });

    await expect(
      plan.config.createSessionRuntime?.(createHostFactoryParams()),
    ).rejects.toThrow(/provider delivery outcome/i);
    expect(runtime.resetOrDisposeRuntime).toHaveBeenCalledOnce();
  });

  it('rebinds canonical native operations after reset and fences stale predecessor events', async () => {
    const lifecycleOrder: string[] = [];
    const initialTeamSelection: TeamCredentialProviderModelSelectionV1 = {
      kind: 'team_credential_provider_model', resourceId: 'initial-resource', teamId: 'initial-team',
      expectedResourceRevision: 1, deliveryMode: 'brokered', agentTargetKey: 'backend:acme.sample.backend', modelId: 'initial-model',
    };
    const initialProviderBindingAdmission = Object.freeze({
      v: 1,
      connectionId: 'pc-initial',
    }) as never;
    const successorProviderBindingAdmission = Object.freeze({
      v: 1,
      connectionId: 'pc-successor',
    }) as never;
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
      readAppliedTeamCredentialModel: () => initialTeamSelection,
      canInterruptForPendingInput: () => false,
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
      readAppliedTeamCredentialModel: () => null,
      canInterruptForPendingInput: () => true,
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
      .mockResolvedValueOnce({
        operations: first,
        admittedProviderBindingHandoff: initialProviderBindingAdmission,
      })
      .mockResolvedValueOnce({
        operations: second,
        admittedProviderBindingHandoff: successorProviderBindingAdmission,
      });
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
          onSuccessorProviderBindingAdmitted(input: unknown): Promise<void>;
          onSuccessorBound(): Promise<void>;
          onSuccessorUsable(): Promise<void>;
        }>): void;
        interruptPendingInputAndRun(request: Readonly<{
          sessionId: string;
          localId: string;
          expectedStateAtMs?: number;
        }>): Promise<unknown> | unknown;
        canInterruptForPendingInput(): boolean;
        readAppliedTeamCredentialModel(): TeamCredentialProviderModelSelectionV1 | null | undefined;
      }>;
    }>).operations;
    expect((created as Readonly<{
      admittedProviderBindingHandoff?: unknown;
    }>).admittedProviderBindingHandoff).toBe(initialProviderBindingAdmission);
    operations.setRuntimeReplacementLifecycle({
      beforeReplacement: async () => { lifecycleOrder.push('before'); },
      onSuccessorProviderBindingAdmitted: async (input) => {
        expect(input).toBe(successorProviderBindingAdmission);
        lifecycleOrder.push('successor-admitted');
      },
      onSuccessorBound: async () => {
        expect(operations.readAppliedTeamCredentialModel()).toBeUndefined();
        lifecycleOrder.push('bound');
      },
      onSuccessorUsable: async () => {
        expect(operations.readAppliedTeamCredentialModel()).toBeNull();
        lifecycleOrder.push('usable');
      },
    });
    const observed: unknown[] = [];
    operations.subscribeRuntimeEvents((event) => observed.push(event));

    expect(operations.canInterruptForPendingInput()).toBe(false);
    expect(operations.readAppliedTeamCredentialModel()).toEqual(initialTeamSelection);
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
    expect(operations.canInterruptForPendingInput()).toBe(true);
    expect(operations.readAppliedTeamCredentialModel()).toBeNull();
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
      'successor-admitted',
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

  it('does not bind an ordinary-update successor path into the retained native runtime', async () => {
    const first = {
      ...createRuntimeTurnOperations(),
      readSessionIdentity: vi.fn(() => ({
        sessionId: 'provider-session-g',
      })),
      resetOrDisposeRuntime: vi.fn(async () => undefined),
    };
    const second = {
      ...createRuntimeTurnOperations(),
      readSessionIdentity: vi.fn(() => ({
        sessionId: 'provider-session-h',
      })),
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

    const created =
      await plan.config.createSessionRuntime?.(createHostFactoryParams());
    const operations = (created as Readonly<{
      operations: RuntimeTurnOperations;
    }>).operations;

    expect(first.resetOrDisposeRuntime).not.toHaveBeenCalled();
    expect(createSessionRuntime).toHaveBeenCalledOnce();
    await operations.sendTurnPrompt('retained G turn');
    expect(first.sendTurnPrompt).toHaveBeenCalledWith(
      'retained G turn',
      undefined,
    );
    expect(second.sendTurnPrompt).not.toHaveBeenCalled();
  });

  it('does not replay a pending prompt through a successor after a runtime error', async () => {
    const runtimeError = new Error(
      'retained runtime rejected before provider dispatch',
    );
    const first = {
      ...createRuntimeTurnOperations(),
      sendTurnPrompt: vi.fn(async () => {
        throw runtimeError;
      }),
      readSessionIdentity: vi.fn(() => ({
        sessionId: 'provider-session-g',
      })),
      resetOrDisposeRuntime: vi.fn(async () => undefined),
    };
    const second = {
      ...createRuntimeTurnOperations(),
      sendTurnPrompt: vi.fn(async () => undefined),
      readSessionIdentity: vi.fn(() => ({
        sessionId: 'provider-session-h',
      })),
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
    const created =
      await plan.config.createSessionRuntime?.(createHostFactoryParams());
    const operations = (created as Readonly<{
      operations: RuntimeTurnOperations;
    }>).operations;

    await expect(operations.sendTurnPrompt('pending prompt', {
      localId: 'pending-input-1',
      turnId: 'pending-turn-1',
    })).rejects.toBe(runtimeError);

    expect(first.sendTurnPrompt).toHaveBeenCalledOnce();
    expect(first.resetOrDisposeRuntime).not.toHaveBeenCalled();
    expect(second.sendTurnPrompt).not.toHaveBeenCalled();
    expect(createSessionRuntime).toHaveBeenCalledOnce();
  });

  it('does not replay a provider error that counterfeits the generation replacement shape', async () => {
    const counterfeit = Object.assign(
      new Error('provider failed after effect'),
      {
        name: 'RunnerAgentGenerationReplacementRequiredError',
        code: 'RUNNER_AGENT_GENERATION_REPLACED',
      },
    );
    const first = {
      ...createRuntimeTurnOperations(),
      sendTurnPrompt: vi.fn(async () => {
        throw counterfeit;
      }),
      readSessionIdentity: vi.fn(() => ({
        sessionId: 'provider-session-g',
      })),
      resetOrDisposeRuntime: vi.fn(async () => undefined),
    };
    const second = {
      ...createRuntimeTurnOperations(),
      sendTurnPrompt: vi.fn(async () => undefined),
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
    const created =
      await plan.config.createSessionRuntime?.(createHostFactoryParams());
    const operations = (created as Readonly<{
      operations: RuntimeTurnOperations;
    }>).operations;

    await expect(
      operations.sendTurnPrompt('do not replay'),
    ).rejects.toBe(counterfeit);
    expect(first.sendTurnPrompt).toHaveBeenCalledOnce();
    expect(first.resetOrDisposeRuntime).not.toHaveBeenCalled();
    expect(second.sendTurnPrompt).not.toHaveBeenCalled();
    expect(createSessionRuntime).toHaveBeenCalledOnce();
  });

  it('fails closed when a successor omits the mandatory provider delivery outcome port', async () => {
    const firstSetOutcome = vi.fn();
    const first = {
      ...createRuntimeTurnOperations(),
      setOnPromptDeliveryOutcome: firstSetOutcome,
    };
    const { setOnPromptDeliveryOutcome: _omittedOutcomePort, ...second } = createRuntimeTurnOperations();
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
      .rejects.toThrow(/provider delivery outcome/i);

    expect(firstSetOutcome).toHaveBeenCalledOnce();
    expect(second.resetOrDisposeRuntime).toHaveBeenCalledOnce();
  });
});
