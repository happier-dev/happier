import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createCurrentGlobalExternalSessionsRouter,
  type CurrentGlobalExternalSessionsRouter,
} from '@/session/external/currentGlobalRouting';
import type { ProvidersService } from '@happier-dev/plugin-sdk/providers';

import type { PluginReloadController } from '@/plugins/runtime/reload/controller';
import type { StablePluginConnectedAccountsOwner } from '@/plugins/runtime/invocation/services/connectedAccounts';
import { createTargetedContributionsService } from '@/plugins/runtime/invocation/services/targetedContributions';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import type { PluginRegistryAvailabilityInventory } from '@/plugins/store/registry/currentState';
import type { PluginChangeRequest, PreparedDaemonPluginChange } from './changeContract';

const ownerMocks = vi.hoisted(() => ({
  runtimeLifecycleParams: null as null | Readonly<Record<string, unknown>>,
  resolveRuntimeRegistryParams: null as null | Readonly<Record<string, unknown>>,
  resolveRuntimeRegistryOverride: null as null | Readonly<Record<string, unknown>>,
  changeServiceParams: null as null | Readonly<Record<string, unknown>>,
  stateStoreParams: null as null | Readonly<Record<string, unknown>>,
  pathPreparerParams: null as null | Readonly<Record<string, unknown>>,
  npmPreparerParams: null as null | Readonly<Record<string, unknown>>,
  archivePreparerParams: null as null | Readonly<Record<string, unknown>>,
  bundledSourceOverlayGenerationIds: null as null | readonly string[],
  prepareNpm: vi.fn(),
  preparePath: vi.fn(),
  prepareArchive: vi.fn(),
  readStore: vi.fn(),
  initializeStore: vi.fn(async () => undefined),
  readAvailabilityInventory: vi.fn(async (): Promise<PluginRegistryAvailabilityInventory> => Object.freeze({
    revision: 0,
    releasePublications: Object.freeze([]),
    materializations: Object.freeze([]),
  })),
  readAvailabilityInventoryForCommit: vi.fn(async (): Promise<PluginRegistryAvailabilityInventory> => Object.freeze({
    revision: 0,
    releasePublications: Object.freeze([]),
    materializations: Object.freeze([]),
  })),
  releaseInitialLease: vi.fn(async () => undefined),
  stableEventsBroker: Object.freeze({ marker: 'daemon-stable-events' }),
}));

vi.mock('@/plugins/daemon/archiveChangePreparer', () => ({
  createDaemonArchivePluginChangePreparer: (params: Readonly<Record<string, unknown>>) => {
    ownerMocks.archivePreparerParams = params;
    return ownerMocks.prepareArchive;
  },
}));
vi.mock('@/plugins/daemon/changeService', () => ({
  createDaemonPluginChangeService: (params: Readonly<Record<string, unknown>>) => {
    ownerMocks.changeServiceParams = params;
    return Object.freeze({
      requestPluginChange: vi.fn(),
      decidePluginChange: vi.fn(),
      runHardRevocationCurrentnessChange: vi.fn(),
      quiesceForHandoff: vi.fn(),
      shutdown: vi.fn(),
    });
  },
}));
vi.mock('@/plugins/daemon/npmChangePreparer', () => ({
  createDaemonNpmPluginChangePreparer: (params: Readonly<Record<string, unknown>>) => {
    ownerMocks.npmPreparerParams = params;
    return ownerMocks.prepareNpm;
  },
}));
vi.mock('@/plugins/daemon/pathChangePreparer', () => ({
  createDaemonPathPluginChangePreparer: (params: Readonly<Record<string, unknown>>) => {
    ownerMocks.pathPreparerParams = params;
    return ownerMocks.preparePath;
  },
}));
vi.mock('@/plugins/daemon/currentCatalog', () => ({
  readCurrentDaemonPluginCatalog: vi.fn(async () => []),
}));
vi.mock('@/plugins/runtime/reload/registryRuntimeLifecycle', () => ({
  createDaemonPluginRegistryRuntimeLifecycle: (params: Readonly<Record<string, unknown>>) => {
    ownerMocks.runtimeLifecycleParams = params;
    return Object.freeze({});
  },
}));
vi.mock('@/plugins/runtime/resolveExecutablePluginRuntimeRegistry', () => ({
  resolveExecutablePluginRuntimeRegistry: vi.fn(async (params: Readonly<Record<string, unknown>>) => {
    ownerMocks.resolveRuntimeRegistryParams = params;
    return ownerMocks.resolveRuntimeRegistryOverride ?? Object.freeze({
      contributes: Object.freeze({ generationId: 'candidate-generation' }),
      stableEventsBroker: ownerMocks.stableEventsBroker,
    });
  }),
}));
vi.mock('@/plugins/projection/registry/sources/generatedBundledPluginArtifacts', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('@/plugins/projection/registry/sources/generatedBundledPluginArtifacts')
  >();
  const sourceOverlayRunnerPluginIds = new Set([
    'happier.agent.codex',
    'happier.agent.cursor',
    'happier.agent.ohmypi',
    'happier.agent.pi',
  ]);
  const artifacts = actual.BUNDLED_FIRST_PARTY_IMMUTABLE_ARTIFACTS.filter((artifact) => (
    sourceOverlayRunnerPluginIds.has(artifact.record.pluginId)
  ));
  if (artifacts.length !== sourceOverlayRunnerPluginIds.size) {
    throw new Error('Expected every source-overlay runner bundled artifact');
  }
  ownerMocks.bundledSourceOverlayGenerationIds = Object.freeze(
    artifacts.map((artifact) => artifact.record.immutableGenerationId),
  );
  return {
    // The generated projection is a boundary. Keep the four source overlays
    // real so this owner cannot mistake activation-source selection for custody retention.
    BUNDLED_FIRST_PARTY_IMMUTABLE_ARTIFACTS: Object.freeze(artifacts),
  };
});
vi.mock('@/plugins/projection/registry/sources/generatedBundledPlugins', () => ({
  // Registry construction is mocked below; loading bundled plugin packages is not part of this owner test.
  BUNDLED_FIRST_PARTY_PLUGINS: Object.freeze([]),
}));
vi.mock('@/plugins/projection/registry/sources/generatedBundledPluginManifests', () => ({
  BUNDLED_FIRST_PARTY_PLUGIN_PACKAGE_NAMES: Object.freeze([]),
}));
vi.mock('@/plugins/projection/registry/createResolvedContributionRegistry', () => ({
  // Recovery-mode contribution projection is separately owned; this test only
  // verifies that the daemon runtime owner supplies its built-in snapshot.
  getResolvedContributionRegistry: vi.fn(() => Object.freeze({})),
}));
vi.mock('@/plugins/store/registry/currentState', () => ({
  createPluginRegistryStateStore: (params: Readonly<Record<string, unknown>>) => {
    ownerMocks.stateStoreParams = params;
    return Object.freeze({
    read: ownerMocks.readStore,
    initialize: ownerMocks.initializeStore,
    readAvailabilityInventory: ownerMocks.readAvailabilityInventory,
    readAvailabilityInventoryForCommit: ownerMocks.readAvailabilityInventoryForCommit,
    });
  },
}));
vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
    warn: vi.fn(),
  },
}));

type CreateDaemonPluginRuntimeOwner = typeof import('./runtimeOwner').createDaemonPluginRuntimeOwner;

let createDaemonPluginRuntimeOwner: CreateDaemonPluginRuntimeOwner;

function createUnusedConnectedAccountsOwner(): StablePluginConnectedAccountsOwner {
  return Object.freeze({
    getBinding: vi.fn(async () => null),
    requestSelection: vi.fn(async () => {
      throw new Error('unexpected connected-account selection');
    }),
    materialize: vi.fn(async () => {
      throw new Error('unexpected connected-account materialization');
    }),
    listAccounts: async () => {
        throw new Error('Connected Account listing is outside this fixture');
    },
    materializeListedAccount: async () => {
        throw new Error('Exact-listed Connected Account materialization is outside this fixture');
    },
    watch: vi.fn(() => Object.freeze({ dispose() {} })),
  });
}

describe('createDaemonPluginRuntimeOwner publication join', () => {
  beforeAll(async () => {
    ({ createDaemonPluginRuntimeOwner } = await import('./runtimeOwner'));
  });

  beforeEach(() => {
    ownerMocks.runtimeLifecycleParams = null;
    ownerMocks.resolveRuntimeRegistryParams = null;
    ownerMocks.resolveRuntimeRegistryOverride = null;
    ownerMocks.changeServiceParams = null;
    ownerMocks.stateStoreParams = null;
    ownerMocks.pathPreparerParams = null;
    ownerMocks.npmPreparerParams = null;
    ownerMocks.archivePreparerParams = null;
    ownerMocks.prepareNpm.mockReset();
    ownerMocks.preparePath.mockReset();
    ownerMocks.prepareArchive.mockReset();
    ownerMocks.readStore.mockReset();
    ownerMocks.initializeStore.mockClear();
    ownerMocks.readAvailabilityInventory.mockClear();
    ownerMocks.readAvailabilityInventoryForCommit.mockClear();
    ownerMocks.releaseInitialLease.mockClear();
  });

  it('retains every executable source-overlay generation for custody cleanup', async () => {
    const reloadController: PluginReloadController = {
      adoptPreparedRuntimeRegistry: vi.fn(),
      acquireRuntimeRegistry: vi.fn(async (params = {}) => {
        const registry = await params.resolveRuntimeRegistry?.();
        if (!registry) throw new Error('missing initial registry');
        return Object.freeze({
          registry,
          source: 'active' as const,
          release: ownerMocks.releaseInitialLease,
        });
      }),
      tryAcquireRuntimeRegistry: vi.fn(() => null),
      isRuntimeRegistryCurrent: vi.fn(() => true),
      invalidateRuntimeProjection: vi.fn(),
      applyResourceSessionAccessWitness: vi.fn(),
      shutdown: vi.fn(),
      getState: () => ({ generation: 0, activeRegistry: null, lastResult: null }),
      subscribe: vi.fn(() => () => undefined),
      publishDurableRunningSessionDisposition: vi.fn(),
      currentGlobalExternalSessions: createCurrentGlobalExternalSessionsRouter(
        () => null,
      ),
      subscribeRunningSessionDisposition: vi.fn(() => () => undefined),
    };
    const owner = createDaemonPluginRuntimeOwner({
      happyHomeDir: '/tmp/happier-runtime-owner-source-overlay-retention-test',
      staleCandidateCleanup: 'disabled',
      reloadController,
      connectedAccounts: createUnusedConnectedAccountsOwner(),
    });

    await owner.initialize();

    const expectedGenerationIds = ownerMocks.bundledSourceOverlayGenerationIds;
    if (!expectedGenerationIds) {
      throw new Error('Expected source-overlay runner generation identities');
    }
    expect(expectedGenerationIds).toHaveLength(4);
    expect(ownerMocks.stateStoreParams?.retainedCurrentHostGenerationIds).toEqual(
      expectedGenerationIds,
    );
  });

  it('publishes the initial registry before gating its one-time background activation', async () => {
    let releaseActivation!: () => void;
    const activationReady = new Promise<void>((resolve) => {
      releaseActivation = resolve;
    });
    let observedProviderService: unknown = null;
    const providerService: ProvidersService = Object.freeze({
      connections: Object.freeze({ describe: vi.fn(), mutate: vi.fn(), bindingStatus: vi.fn() }),
      catalog: Object.freeze({
        probe: vi.fn(),
        listModels: vi.fn(),
        setModelLoad: vi.fn(),
        projectModels: vi.fn(),
        mutateModelSettings: vi.fn(),
      }),
      migrations: Object.freeze({ preview: vi.fn(), confirm: vi.fn(), confirmConflict: vi.fn() }),
    });
    let producer: Readonly<{
      bind(binding: Readonly<{ signal: AbortSignal; isCurrent(): boolean }>): ProvidersService;
    }> | null = null;
    const providers = Object.freeze({
      bind(binding: Readonly<{ signal: AbortSignal; isCurrent(): boolean }>) {
        return producer?.bind(binding) ?? null;
      },
    });
    const published = vi.fn();
    const startAdoptedBackgroundServices = vi.fn(() => {
      const source = ownerMocks.resolveRuntimeRegistryParams?.providers as typeof providers | undefined;
      observedProviderService = source?.bind({
        signal: new AbortController().signal,
        isCurrent: () => true,
      }) ?? null;
    });
    const reloadController: PluginReloadController = {
      adoptPreparedRuntimeRegistry: vi.fn(),
      acquireRuntimeRegistry: vi.fn(async (params = {}) => {
        const registry = await params.resolveRuntimeRegistry?.();
        if (!registry || !params.beforePublish) throw new Error('missing initial registry publication');
        await params.beforePublish(registry, published);
        startAdoptedBackgroundServices();
        return Object.freeze({
          registry,
          source: 'active' as const,
          release: ownerMocks.releaseInitialLease,
        });
      }),
      tryAcquireRuntimeRegistry: vi.fn(() => null),
      isRuntimeRegistryCurrent: vi.fn(() => true),
      invalidateRuntimeProjection: vi.fn(),
      applyResourceSessionAccessWitness: vi.fn(),
      shutdown: vi.fn(),
      getState: () => ({ generation: 0, activeRegistry: null, lastResult: null }),
      subscribe: vi.fn(() => () => undefined),
      publishDurableRunningSessionDisposition: vi.fn(),
      currentGlobalExternalSessions: createCurrentGlobalExternalSessionsRouter(
        () => null,
      ),
      subscribeRunningSessionDisposition: vi.fn(() => () => undefined),
    };
    const onInitialRegistryPublished = vi.fn();
    const onDurableRegistryApplied = vi.fn();
    const onRuntimeProjectionInvalidated = vi.fn();
    const ownerParams = {
      happyHomeDir: '/tmp/happier-runtime-owner-provider-order-test',
      staleCandidateCleanup: 'disabled' as const,
      reloadController,
      connectedAccounts: createUnusedConnectedAccountsOwner(),
      providers,
      onInitialRegistryPublished,
      awaitInitialRuntimeActivation: async () => await activationReady,
      onDurableRegistryApplied,
      onRuntimeProjectionInvalidated,
    };
    const owner = createDaemonPluginRuntimeOwner(ownerParams);

    let initializationSettled = false;
    const initialization = owner.initialize().finally(() => {
      initializationSettled = true;
    });
    await vi.waitFor(() => expect(onInitialRegistryPublished).toHaveBeenCalledOnce());
    expect(published).toHaveBeenCalledOnce();
    expect(initializationSettled).toBe(false);
    expect(startAdoptedBackgroundServices).not.toHaveBeenCalled();
    expect(onDurableRegistryApplied).not.toHaveBeenCalled();

    producer = Object.freeze({ bind: vi.fn(() => providerService) });
    releaseActivation();
    await initialization;

    expect(startAdoptedBackgroundServices).toHaveBeenCalledOnce();
    expect(observedProviderService).toBe(providerService);
    expect(onDurableRegistryApplied).toHaveBeenCalledOnce();
    expect(reloadController.adoptPreparedRuntimeRegistry).not.toHaveBeenCalled();

    const invalidateRuntimeProjection = ownerMocks.resolveRuntimeRegistryParams
      ?.onTerminalActivationFailure;
    if (typeof invalidateRuntimeProjection !== 'function') {
      throw new Error('expected terminal activation projection invalidation');
    }
    invalidateRuntimeProjection('acme.failed');
    expect(reloadController.invalidateRuntimeProjection).toHaveBeenCalledOnce();
    expect(onRuntimeProjectionInvalidated).toHaveBeenCalledOnce();
  });

  it('joins every post-startup durable registry application to the same projection notification', async () => {
    const onDurableRegistryApplied = vi.fn();
    const reloadController: PluginReloadController = {
      adoptPreparedRuntimeRegistry: vi.fn(),
      acquireRuntimeRegistry: vi.fn(async (params = {}) => {
        const registry = await params.resolveRuntimeRegistry?.();
        if (!registry || !params.beforePublish) throw new Error('missing initial registry publication');
        await params.beforePublish(registry, () => undefined);
        return Object.freeze({
          registry,
          source: 'active' as const,
          release: ownerMocks.releaseInitialLease,
        });
      }),
      tryAcquireRuntimeRegistry: vi.fn(() => null),
      isRuntimeRegistryCurrent: vi.fn(() => true),
      applyResourceSessionAccessWitness: vi.fn(),
      shutdown: vi.fn(),
      getState: () => ({ generation: 0, activeRegistry: null, lastResult: null }),
      subscribe: vi.fn(() => () => undefined),
      publishDurableRunningSessionDisposition: vi.fn(),
      currentGlobalExternalSessions: createCurrentGlobalExternalSessionsRouter(
        () => null,
      ),
      subscribeRunningSessionDisposition: vi.fn(() => () => undefined),
    };
    const ownerParams = {
      happyHomeDir: '/tmp/happier-runtime-owner-applied-notification-test',
      staleCandidateCleanup: 'disabled' as const,
      reloadController,
      connectedAccounts: createUnusedConnectedAccountsOwner(),
      onDurableRegistryApplied,
    };
    const owner = createDaemonPluginRuntimeOwner(ownerParams);

    await owner.initialize();
    expect(onDurableRegistryApplied).toHaveBeenCalledOnce();

    const committedRecord = Object.freeze({ revision: 8 });
    const notifyApplied = (params: Readonly<Record<string, unknown>> | null): void => {
      const onRegistryApplied = params?.onRegistryApplied ?? params?.onApplied;
      if (typeof onRegistryApplied !== 'function') {
        throw new Error('expected canonical registry-application callback');
      }
      onRegistryApplied(committedRecord);
    };
    notifyApplied(ownerMocks.pathPreparerParams);
    notifyApplied(ownerMocks.npmPreparerParams);
    notifyApplied(ownerMocks.archivePreparerParams);
    notifyApplied(ownerMocks.stateStoreParams);

    expect(onDurableRegistryApplied).toHaveBeenCalledTimes(5);
  });

  it('threads fresh execution-origin context into the initial registry as well as reloads', async () => {
    const resolveCurrentMachineExecutionOriginContext = vi.fn(async () => Object.freeze({
      serverIdentityId: 'srv_runtime_owner_fixture',
      machineId: 'machine-runtime-owner',
    }));
    const reloadController: PluginReloadController = {
      adoptPreparedRuntimeRegistry: vi.fn(),
      acquireRuntimeRegistry: vi.fn(async (params = {}) => {
        const registry = await params.resolveRuntimeRegistry?.();
        if (!registry) throw new Error('missing initial registry');
        return Object.freeze({
          registry,
          source: 'active' as const,
          release: ownerMocks.releaseInitialLease,
        });
      }),
      tryAcquireRuntimeRegistry: vi.fn(() => null),
      isRuntimeRegistryCurrent: vi.fn(() => true),
      applyResourceSessionAccessWitness: vi.fn(),
      shutdown: vi.fn(),
      getState: () => ({ generation: 0, activeRegistry: null, lastResult: null }),
      subscribe: vi.fn(() => () => undefined),
      publishDurableRunningSessionDisposition: vi.fn(),
      currentGlobalExternalSessions: createCurrentGlobalExternalSessionsRouter(
        () => null,
      ),
      subscribeRunningSessionDisposition: vi.fn(() => () => undefined),
    };
    const owner = createDaemonPluginRuntimeOwner({
      happyHomeDir: '/tmp/happier-runtime-owner-origin-context-test',
      staleCandidateCleanup: 'disabled',
      reloadController,
      connectedAccounts: createUnusedConnectedAccountsOwner(),
      resolveCurrentMachineExecutionOriginContext,
    });

    await owner.initialize();

    expect(ownerMocks.resolveRuntimeRegistryParams?.resolveCurrentMachineExecutionOriginContext)
      .toBe(resolveCurrentMachineExecutionOriginContext);
    expect(ownerMocks.runtimeLifecycleParams?.resolveCurrentMachineExecutionOriginContext)
      .toBe(resolveCurrentMachineExecutionOriginContext);
  });

  it('threads the controller-owned targeted contribution observer into the initial registry', async () => {
    const targetedContributions = createTargetedContributionsService({
      subscribeToCatalogChanges: () => () => undefined,
      readAdmittedSnapshot: async () => Object.freeze({
        generation: 'unused-target-generation',
        contributions: Object.freeze([]),
      }),
    });
    const getTargetedContributionsOwner = vi.fn(() => targetedContributions);
    const reloadController: PluginReloadController = {
      adoptPreparedRuntimeRegistry: vi.fn(),
      acquireRuntimeRegistry: vi.fn(async (params = {}) => {
        const registry = await params.resolveRuntimeRegistry?.();
        if (!registry) throw new Error('missing initial registry');
        return Object.freeze({
          registry,
          source: 'active' as const,
          release: ownerMocks.releaseInitialLease,
        });
      }),
      tryAcquireRuntimeRegistry: vi.fn(() => null),
      isRuntimeRegistryCurrent: vi.fn(() => true),
      applyResourceSessionAccessWitness: vi.fn(),
      shutdown: vi.fn(),
      getState: () => ({ generation: 0, activeRegistry: null, lastResult: null }),
      subscribe: vi.fn(() => () => undefined),
      getTargetedContributionsOwner,
      publishDurableRunningSessionDisposition: vi.fn(),
      currentGlobalExternalSessions: createCurrentGlobalExternalSessionsRouter(
        () => null,
      ),
      subscribeRunningSessionDisposition: vi.fn(() => () => undefined),
    };
    const owner = createDaemonPluginRuntimeOwner({
      happyHomeDir: '/tmp/happier-runtime-owner-targeted-observer-test',
      staleCandidateCleanup: 'disabled',
      reloadController,
      connectedAccounts: createUnusedConnectedAccountsOwner(),
    });

    await owner.initialize();

    expect(getTargetedContributionsOwner).toHaveBeenCalledOnce();
    expect(ownerMocks.resolveRuntimeRegistryParams?.targetedContributions)
      .toBe(targetedContributions);
  });

  it('routes the cold-start registry through the controller-lifetime current-global External Sessions router', async () => {
    // The daemon's first registry is exactly the one whose long-lived plugin
    // contexts survive the first peer Agent replacement. If it self-targets,
    // those contexts keep resolving the predecessor after publication.
    const activations: string[] = [];
    const publishedOwner = { label: 'published' } as unknown as NonNullable<
      ReturnType<CurrentGlobalExternalSessionsRouter['resolveCurrent']>
    >;
    const controllerRouter = createCurrentGlobalExternalSessionsRouter(
      () => Object.freeze({
        resolveCurrent: () => publishedOwner,
        activateConfiguredSources: async (agentId?: string) => {
          activations.push(`published:${agentId ?? '*'}`);
        },
      }),
    );
    const reloadController: PluginReloadController = {
      adoptPreparedRuntimeRegistry: vi.fn(),
      acquireRuntimeRegistry: vi.fn(async (params = {}) => {
        const registry = await params.resolveRuntimeRegistry?.();
        if (!registry) throw new Error('missing initial registry');
        return Object.freeze({
          registry,
          source: 'active' as const,
          release: ownerMocks.releaseInitialLease,
        });
      }),
      tryAcquireRuntimeRegistry: vi.fn(() => null),
      isRuntimeRegistryCurrent: vi.fn(() => true),
      applyResourceSessionAccessWitness: vi.fn(),
      shutdown: vi.fn(),
      getState: () => ({ generation: 0, activeRegistry: null, lastResult: null }),
      subscribe: vi.fn(() => () => undefined),
      publishDurableRunningSessionDisposition: vi.fn(),
      currentGlobalExternalSessions: controllerRouter,
      subscribeRunningSessionDisposition: vi.fn(() => () => undefined),
    };
    const owner = createDaemonPluginRuntimeOwner({
      happyHomeDir: '/tmp/happier-runtime-owner-current-global-router-test',
      staleCandidateCleanup: 'disabled',
      reloadController,
      connectedAccounts: createUnusedConnectedAccountsOwner(),
    });

    await owner.initialize();

    const coldRouter = ownerMocks.resolveRuntimeRegistryParams
      ?.currentGlobalExternalSessionsRouter as
        CurrentGlobalExternalSessionsRouter | undefined;
    expect(coldRouter?.resolveCurrent()).toBe(publishedOwner);
    await coldRouter?.activateConfiguredSources('codex');
    expect(activations).toEqual(['published:codex']);
  });

  it('threads the canonical exact Session-access resolver into initial and replacement Resource owners', async () => {
    const resolveSessionResourceAccess = vi.fn(async (input: Readonly<{
      accountId: string;
      sessionId: string;
      signal: AbortSignal;
    }>) => Object.freeze({
      accountId: input.accountId,
      throughCursor: 1,
      status: 'available' as const,
    }));
    const reloadController: PluginReloadController = {
      adoptPreparedRuntimeRegistry: vi.fn(),
      acquireRuntimeRegistry: vi.fn(async (params = {}) => {
        const registry = await params.resolveRuntimeRegistry?.();
        if (!registry) throw new Error('missing initial registry');
        return Object.freeze({
          registry,
          source: 'active' as const,
          release: ownerMocks.releaseInitialLease,
        });
      }),
      tryAcquireRuntimeRegistry: vi.fn(() => null),
      isRuntimeRegistryCurrent: vi.fn(() => true),
      applyResourceSessionAccessWitness: vi.fn(),
      shutdown: vi.fn(),
      getState: () => ({ generation: 0, activeRegistry: null, lastResult: null }),
      subscribe: vi.fn(() => () => undefined),
      publishDurableRunningSessionDisposition: vi.fn(),
      currentGlobalExternalSessions: createCurrentGlobalExternalSessionsRouter(
        () => null,
      ),
      subscribeRunningSessionDisposition: vi.fn(() => () => undefined),
    };
    const owner = createDaemonPluginRuntimeOwner({
      happyHomeDir: '/tmp/happier-runtime-owner-session-access-test',
      staleCandidateCleanup: 'disabled',
      reloadController,
      connectedAccounts: createUnusedConnectedAccountsOwner(),
      resolveSessionResourceAccess,
    });

    await owner.initialize();

    expect(ownerMocks.resolveRuntimeRegistryParams?.resolveSessionResourceAccess)
      .toBe(resolveSessionResourceAccess);
    expect(ownerMocks.runtimeLifecycleParams?.resolveSessionResourceAccess)
      .toBe(resolveSessionResourceAccess);
  });

  it('prepares declared daemon databases before publishing the initial registry', async () => {
    const events: string[] = [];
    const prepareDaemonDatabases = vi.fn(async () => {
      events.push('database-prepared');
    });
    const dispose = vi.fn(async () => undefined);
    ownerMocks.resolveRuntimeRegistryOverride = Object.freeze({
      contributes: Object.freeze({
        activationTargets: Object.freeze([
          Object.freeze({
            pluginId: 'com.acme.indexer',
            activationEvents: Object.freeze(['startup']),
            manifest: Object.freeze({
              contributes: Object.freeze({
                daemonDatabases: Object.freeze([Object.freeze({ id: 'index' })]),
              }),
            }),
          }),
          Object.freeze({
            pluginId: 'com.acme.no-database',
            manifest: Object.freeze({
              contributes: Object.freeze({
                daemonDatabases: Object.freeze([]),
              }),
            }),
          }),
          // Declared databases are not enough: a plugin whose activation never
          // succeeded must not have native handles opened on its behalf.
          Object.freeze({
            pluginId: 'com.acme.unactivated-indexer',
            manifest: Object.freeze({
              contributes: Object.freeze({
                daemonDatabases: Object.freeze([Object.freeze({ id: 'index' })]),
              }),
            }),
          }),
        ]),
      }),
      activatedPluginIds: new Set(['com.acme.indexer']),
      // Every activation target proves its readiness before publication, so this
      // fixture must satisfy that proof rather than rely on a swallowed rejection.
      activatePluginsForValidation: vi.fn(async () => Object.freeze([])),
      agentRuntimesByAgentId: new Map(),
      stableEventsBroker: ownerMocks.stableEventsBroker,
      prepareDaemonDatabases,
      dispose,
    });
    const reloadController: PluginReloadController = {
      adoptPreparedRuntimeRegistry: vi.fn(),
      acquireRuntimeRegistry: vi.fn(async (params = {}) => {
        const registry = await params.resolveRuntimeRegistry?.();
        if (!registry || !params.beforePublish) throw new Error('missing initial registry publication');
        await params.beforePublish(registry, () => events.push('published'));
        return Object.freeze({
          registry,
          source: 'active' as const,
          release: ownerMocks.releaseInitialLease,
        });
      }),
      tryAcquireRuntimeRegistry: vi.fn(() => null),
      isRuntimeRegistryCurrent: vi.fn(() => true),
      applyResourceSessionAccessWitness: vi.fn(),
      shutdown: vi.fn(),
      getState: () => ({ generation: 0, activeRegistry: null, lastResult: null }),
      subscribe: vi.fn(() => () => undefined),
      publishDurableRunningSessionDisposition: vi.fn(),
      currentGlobalExternalSessions: createCurrentGlobalExternalSessionsRouter(
        () => null,
      ),
      subscribeRunningSessionDisposition: vi.fn(() => () => undefined),
    };
    const daemonDatabaseLimits = Object.freeze({
      protocolMaximumDatabaseBytes: 128,
      resolvePluginLimits: () => Object.freeze({
        maximumDatabaseBytes: 128,
        maximumInputBytes: 128,
        maximumResultBytes: 128,
        maximumResultRows: 1,
        maximumAffectedRows: 1,
        maximumElapsedMs: 1,
      }),
    });
    const owner = createDaemonPluginRuntimeOwner({
      happyHomeDir: '/tmp/happier-runtime-owner-database-preparation-test',
      staleCandidateCleanup: 'disabled',
      reloadController,
      connectedAccounts: createUnusedConnectedAccountsOwner(),
      daemonDatabaseLimits,
      onInitialRegistryPublished: () => events.push('published-hook'),
    });

    await owner.initialize();

    expect(prepareDaemonDatabases).toHaveBeenCalledWith({
      pluginIds: ['com.acme.indexer'],
    });
    expect(events).toEqual(['database-prepared', 'published', 'published-hook']);
    expect(ownerMocks.resolveRuntimeRegistryParams?.daemonDatabaseLimits).toBe(daemonDatabaseLimits);
    expect(ownerMocks.runtimeLifecycleParams?.daemonDatabaseLimits).toBe(daemonDatabaseLimits);
    expect(dispose).not.toHaveBeenCalled();
  });

  function createColdStartReloadController(events: string[]): PluginReloadController {
    return {
      adoptPreparedRuntimeRegistry: vi.fn(),
      acquireRuntimeRegistry: vi.fn(async (params = {}) => {
        const registry = await params.resolveRuntimeRegistry?.();
        if (!registry) throw new Error('missing initial registry publication');
        // Mirrors the real controller: an owner that supplies no `beforePublish`
        // publishes directly rather than failing the cold start.
        const publish = () => events.push('published');
        if (params.beforePublish) await params.beforePublish(registry, publish);
        else publish();
        return Object.freeze({
          registry,
          source: 'active' as const,
          release: ownerMocks.releaseInitialLease,
        });
      }),
      tryAcquireRuntimeRegistry: vi.fn(() => null),
      isRuntimeRegistryCurrent: vi.fn(() => true),
      applyResourceSessionAccessWitness: vi.fn(),
      shutdown: vi.fn(),
      getState: () => ({ generation: 0, activeRegistry: null, lastResult: null }),
      subscribe: vi.fn(() => () => undefined),
      publishDurableRunningSessionDisposition: vi.fn(),
      currentGlobalExternalSessions: createCurrentGlobalExternalSessionsRouter(
        () => null,
      ),
      subscribeRunningSessionDisposition: vi.fn(() => () => undefined),
    };
  }

  function createReadinessActivationTarget(
    pluginId: string,
    provenance: 'first_party' | 'external',
    daemonDatabases: readonly unknown[],
    options: Readonly<{
      activationEvents?: readonly string[];
      contributes?: Readonly<Record<string, unknown>>;
    }> = {},
  ) {
    return Object.freeze({
      pluginId,
      provenance,
      activationEvents: Object.freeze(options.activationEvents ?? ['startup']),
      manifest: Object.freeze({
        contributes: Object.freeze({
          daemonDatabases: Object.freeze([...daemonDatabases]),
          ...(options.contributes ?? {}),
        }),
      }),
    });
  }

  // Records exactly what the canonical activation owner was asked to fence, and
  // mirrors the one effect cold start reads back from it: a fenced plugin leaves
  // the activated set. A published cold registry may not advertise a participant
  // whose readiness was rejected, and it may not fence a healthy peer either.
  function createReadinessFencingRecorder(activatedPluginIds: Set<string>) {
    const fenced: Array<Readonly<{ pluginId: string; message: string }>> = [];
    return Object.freeze({
      fenced,
      recordPluginActivationFailure(pluginId: string, message: string): void {
        fenced.push(Object.freeze({ pluginId, message }));
        activatedPluginIds.delete(pluginId);
      },
    });
  }

  // Cold start has no serving incumbent to fall back to, so one participant's
  // readiness failure must never abort the whole projection. Keyed on the
  // structural fact that a participant failed — bundled and external alike.
  it('isolates a failing daemon-database participant and still publishes the initial registry', async () => {
    const events: string[] = [];
    const prepareDaemonDatabases = vi.fn(async (input: Readonly<{ pluginIds: readonly string[] }>) => {
      if (input.pluginIds.includes('com.acme.bundled-indexer')) {
        throw new Error('bundled daemon database preparation rejected');
      }
      events.push(`database-prepared:${input.pluginIds.join(',')}`);
    });
    const dispose = vi.fn(async () => undefined);
    const activatedPluginIds = new Set(['com.acme.bundled-indexer', 'com.zeta.external-indexer']);
    const fencing = createReadinessFencingRecorder(activatedPluginIds);
    // The fenced plugin also owns a primary Agent runtime. Its generation is
    // already retired, so the later readiness step must not construct it and
    // record a second reason for one rejection.
    const fencedCreateRuntime = vi.fn(async () => {
      events.push('fenced-runtime-created');
      return Object.freeze({});
    });
    ownerMocks.resolveRuntimeRegistryOverride = Object.freeze({
      contributes: Object.freeze({
        activationTargets: Object.freeze([
          createReadinessActivationTarget('com.acme.bundled-indexer', 'first_party', [{ id: 'index' }]),
          createReadinessActivationTarget('com.zeta.external-indexer', 'external', [{ id: 'index' }]),
        ]),
      }),
      activatedPluginIds,
      activatePluginsForValidation: vi.fn(async () => Object.freeze([])),
      agentRuntimesByAgentId: new Map<string, unknown>([
        ['indexer', Object.freeze({
          agentId: 'indexer',
          pluginId: 'com.acme.bundled-indexer',
          hasPrimaryRuntime: true,
          retirementSignal: new AbortController().signal,
          createRuntime: fencedCreateRuntime,
        })],
      ]),
      stableEventsBroker: ownerMocks.stableEventsBroker,
      prepareDaemonDatabases,
      recordPluginActivationFailure: fencing.recordPluginActivationFailure,
      dispose,
    });
    const owner = createDaemonPluginRuntimeOwner({
      happyHomeDir: '/tmp/happier-runtime-owner-database-isolation-test',
      staleCandidateCleanup: 'disabled',
      reloadController: createColdStartReloadController(events),
      connectedAccounts: createUnusedConnectedAccountsOwner(),
    });

    await owner.initialize();

    // Each participant is prepared on its own so a rejection cannot take its peers with it.
    expect(prepareDaemonDatabases).toHaveBeenCalledWith({ pluginIds: ['com.acme.bundled-indexer'] });
    expect(prepareDaemonDatabases).toHaveBeenCalledWith({ pluginIds: ['com.zeta.external-indexer'] });
    expect(events).toEqual(['database-prepared:com.zeta.external-indexer', 'published']);
    // The rejected participant is fenced once at the canonical activation owner;
    // the healthy peer is left untouched.
    expect(fencing.fenced.map((entry) => entry.pluginId)).toEqual(['com.acme.bundled-indexer']);
    expect(fencing.fenced[0]?.message).toContain('cold-start daemon database preparation failed');
    expect(fencing.fenced[0]?.message).toContain('bundled daemon database preparation rejected');
    expect(fencedCreateRuntime).not.toHaveBeenCalled();
    expect(dispose).not.toHaveBeenCalled();
  });

  it('isolates failing activation and primary-Agent-runtime participants at cold start', async () => {
    const events: string[] = [];
    const dispose = vi.fn(async () => undefined);
    const activatedPluginIds = new Set([
      'com.acme.broken-activation',
      'com.beta.broken-agent',
      'com.zeta.healthy',
    ]);
    const fencing = createReadinessFencingRecorder(activatedPluginIds);
    const activatePluginsForValidation = vi.fn(async (pluginIds: readonly string[]) => {
      if (pluginIds.includes('com.acme.broken-activation')) {
        throw new Error('plugin activation rejected');
      }
      events.push(`activated:${pluginIds.join(',')}`);
      return Object.freeze([]);
    });
    const brokenCreateRuntime = vi.fn(async () => {
      throw new Error('agent runtime factory rejected');
    });
    const healthyCreateRuntime = vi.fn(async () => {
      events.push('healthy-runtime-created');
      return Object.freeze({});
    });
    ownerMocks.resolveRuntimeRegistryOverride = Object.freeze({
      contributes: Object.freeze({
        activationTargets: Object.freeze([
          createReadinessActivationTarget('com.acme.broken-activation', 'external', []),
          createReadinessActivationTarget('com.beta.broken-agent', 'external', []),
          createReadinessActivationTarget('com.zeta.healthy', 'external', []),
        ]),
      }),
      activatedPluginIds,
      activatePluginsForValidation,
      agentRuntimesByAgentId: new Map<string, unknown>([
        ['broken', Object.freeze({
          agentId: 'broken',
          pluginId: 'com.beta.broken-agent',
          hasPrimaryRuntime: true,
          retirementSignal: new AbortController().signal,
          createRuntime: brokenCreateRuntime,
        })],
        ['healthy', Object.freeze({
          agentId: 'healthy',
          pluginId: 'com.zeta.healthy',
          hasPrimaryRuntime: true,
          retirementSignal: new AbortController().signal,
          createRuntime: healthyCreateRuntime,
        })],
      ]),
      stableEventsBroker: ownerMocks.stableEventsBroker,
      recordPluginActivationFailure: fencing.recordPluginActivationFailure,
      dispose,
    });
    const owner = createDaemonPluginRuntimeOwner({
      happyHomeDir: '/tmp/happier-runtime-owner-readiness-isolation-test',
      staleCandidateCleanup: 'disabled',
      reloadController: createColdStartReloadController(events),
      connectedAccounts: createUnusedConnectedAccountsOwner(),
    });

    await owner.initialize();

    // A rejected activation and a rejected Agent-runtime factory are both isolated:
    // their healthy peers still complete and the registry still becomes serving.
    expect(brokenCreateRuntime).toHaveBeenCalledOnce();
    expect(healthyCreateRuntime).toHaveBeenCalledOnce();
    expect(events).toEqual([
      'activated:com.beta.broken-agent',
      'activated:com.zeta.healthy',
      'healthy-runtime-created',
      'published',
    ]);
    // Both rejected participants are fenced as one typed activation failure each,
    // so neither is advertised as ready by the published cold registry. The
    // healthy peer is never fenced.
    expect(fencing.fenced.map((entry) => entry.pluginId)).toEqual([
      'com.acme.broken-activation',
      'com.beta.broken-agent',
    ]);
    expect(fencing.fenced[0]?.message).toContain('cold-start activation failed');
    expect(fencing.fenced[0]?.message).toContain('plugin activation rejected');
    expect(fencing.fenced[1]?.message).toContain('cold-start primary Agent runtime construction failed');
    expect(fencing.fenced[1]?.message).toContain('agent runtime factory rejected');
    expect(dispose).not.toHaveBeenCalled();
  });

  it('keeps demand-ready bundled Agent runtimes cold while proving cold-start participants', async () => {
    const events: string[] = [];
    const dispose = vi.fn(async () => undefined);
    const activatedPluginIds = new Set(['com.acme.bundled-startup']);
    const fencing = createReadinessFencingRecorder(activatedPluginIds);
    const activatePluginsForValidation = vi.fn(async (pluginIds: readonly string[]) => {
      for (const pluginId of pluginIds) {
        activatedPluginIds.add(pluginId);
      }
      events.push(`activated:${pluginIds.join(',')}`);
      return Object.freeze([]);
    });
    const demandReadyAgentCreateRuntime = vi.fn(async () => {
      events.push('demand-ready-agent-runtime-created');
      return Object.freeze({});
    });
    ownerMocks.resolveRuntimeRegistryOverride = Object.freeze({
      contributes: Object.freeze({
        activationTargets: Object.freeze([
          createReadinessActivationTarget('com.acme.bundled-startup', 'first_party', []),
          createReadinessActivationTarget(
            'com.beta.bundled-demand-ready-agent',
            'first_party',
            [],
            {
              activationEvents: [],
              contributes: {
                agents: [{
                  id: 'demand-ready-agent',
                  title: 'Demand-ready Agent',
                  runtime: { kind: 'custom' },
                  primary: 'sessions',
                  capabilities: {
                    sessions: {
                      open: ['create'],
                      delivery: ['newTurn'],
                      cancel: true,
                    },
                  },
                }],
              },
            },
          ),
        ]),
      }),
      activatedPluginIds,
      activatePluginsForValidation,
      agentRuntimesByAgentId: new Map<string, unknown>([
        ['bundled', Object.freeze({
          agentId: 'bundled',
          pluginId: 'com.beta.bundled-demand-ready-agent',
          hasPrimaryRuntime: true,
          retirementSignal: new AbortController().signal,
          createRuntime: demandReadyAgentCreateRuntime,
        })],
      ]),
      stableEventsBroker: ownerMocks.stableEventsBroker,
      recordPluginActivationFailure: fencing.recordPluginActivationFailure,
      dispose,
    });
    const owner = createDaemonPluginRuntimeOwner({
      happyHomeDir: '/tmp/happier-runtime-owner-bundled-readiness-test',
      staleCandidateCleanup: 'disabled',
      reloadController: createColdStartReloadController(events),
      connectedAccounts: createUnusedConnectedAccountsOwner(),
    });

    await owner.initialize();

    expect(activatePluginsForValidation).toHaveBeenCalledTimes(1);
    expect(activatePluginsForValidation).toHaveBeenCalledWith(['com.acme.bundled-startup']);
    expect(demandReadyAgentCreateRuntime).not.toHaveBeenCalled();
    expect(events).toEqual(['activated:com.acme.bundled-startup', 'published']);
    expect(fencing.fenced).toEqual([]);
    expect(dispose).not.toHaveBeenCalled();
  });

  it('disposes the initial registry when cold-start readiness fails registry-wide', async () => {
    const readinessError = new Error('activation targets are unavailable');
    const dispose = vi.fn(async () => undefined);
    ownerMocks.resolveRuntimeRegistryOverride = Object.freeze({
      contributes: Object.freeze({
        get activationTargets(): never {
          throw readinessError;
        },
      }),
      activatedPluginIds: new Set<string>(),
      stableEventsBroker: ownerMocks.stableEventsBroker,
      dispose,
    });
    const owner = createDaemonPluginRuntimeOwner({
      happyHomeDir: '/tmp/happier-runtime-owner-readiness-custody-test',
      staleCandidateCleanup: 'disabled',
      reloadController: createColdStartReloadController([]),
      connectedAccounts: createUnusedConnectedAccountsOwner(),
    });

    // A registry-wide readiness failure is not a participant failure: it must not
    // leak the registry's activated modules and native database handles.
    await expect(owner.initialize()).rejects.toBe(readinessError);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('passes the publication callback through the connected-account owner after durable contraction', async () => {
    const events: string[] = [];
    const previous = Object.freeze({ generationId: 'previous-generation' });
    const candidateActivationIds = new Set(['acme.available']);
    const reconcile = vi.fn(async (input: Readonly<{
      previous: unknown;
      candidate: unknown;
      candidateActivePluginIds?: ReadonlySet<string>;
      resolveOptionalAccess(pluginId: string): readonly unknown[];
      publish(): void;
    }>) => {
      expect(input.previous).toBe(previous);
      expect(input.candidate).toEqual({ generationId: 'candidate-generation' });
      candidateActivationIds.clear();
      expect(input.candidateActivePluginIds).toEqual(new Set(['acme.available']));
      expect(input.resolveOptionalAccess('acme.plugin')).toEqual([]);
      events.push('durable-contraction');
      input.publish();
      events.push('reconciled');
    });
    // This owner-boundary fixture deliberately supplies only the registry field the owner reads.
    const previousRegistry = Object.freeze({
      contributes: previous,
      activatedPluginIds: new Set(['acme.previous']),
    }) as unknown as ResolvedExecutablePluginRuntimeRegistry;
    ownerMocks.resolveRuntimeRegistryOverride = Object.freeze({
      contributes: Object.freeze({ generationId: 'candidate-generation' }),
      activatedPluginIds: candidateActivationIds,
      stableEventsBroker: ownerMocks.stableEventsBroker,
    });
    type AcquireRuntimeRegistryParams = NonNullable<
      Parameters<PluginReloadController['acquireRuntimeRegistry']>[0]
    >;
    const acquireRuntimeRegistry = vi.fn(async (params: AcquireRuntimeRegistryParams = {}) => {
      const registry = await params.resolveRuntimeRegistry?.();
      if (!registry || !params.beforePublish) throw new Error('missing initial publication inputs');
      await params.beforePublish(registry, () => {
        events.push('published');
      });
      return Object.freeze({
        registry,
        source: 'active' as const,
        release: ownerMocks.releaseInitialLease,
      });
    });
    const reloadController: PluginReloadController = {
      adoptPreparedRuntimeRegistry: vi.fn(async () => {
        throw new Error('unexpected prepared-registry adoption');
      }),
      acquireRuntimeRegistry,
      tryAcquireRuntimeRegistry: vi.fn(() => null),
      isRuntimeRegistryCurrent: vi.fn(() => false),
      applyResourceSessionAccessWitness: vi.fn(),
      shutdown: vi.fn(async () => undefined),
      getState: () => Object.freeze({
        generation: 1,
        activeRegistry: previousRegistry,
        lastResult: null,
      }),
      subscribe: vi.fn(() => () => undefined),
      publishDurableRunningSessionDisposition: vi.fn(),
      currentGlobalExternalSessions: createCurrentGlobalExternalSessionsRouter(
        () => null,
      ),
      subscribeRunningSessionDisposition: vi.fn(() => () => undefined),
    };

    const owner = createDaemonPluginRuntimeOwner({
      happyHomeDir: '/tmp/happier-runtime-owner-test',
      staleCandidateCleanup: 'disabled',
      reloadController,
      connectedAccounts: createUnusedConnectedAccountsOwner(),
      reconcileConnectedAccountPurposePublication: reconcile,
    });
    await owner.initialize();

    expect(events).toEqual(['durable-contraction', 'published', 'reconciled']);
    expect(ownerMocks.releaseInitialLease).toHaveBeenCalledOnce();
    expect(ownerMocks.runtimeLifecycleParams?.beforePublish).toBe(
      acquireRuntimeRegistry.mock.calls[0]?.[0]?.beforePublish,
    );
  });

  it('reports exact persisted inventories only after registry application without owning machine or server facts', async () => {
    const startupInventory: PluginRegistryAvailabilityInventory = Object.freeze({
      revision: 7,
      releasePublications: Object.freeze([]),
      materializations: Object.freeze([]),
    });
    const committedInventory: PluginRegistryAvailabilityInventory = Object.freeze({
      revision: 8,
      releasePublications: Object.freeze([]),
      materializations: Object.freeze([]),
    });
    const committedRecord = Object.freeze({ revision: 8 });
    ownerMocks.readAvailabilityInventory.mockResolvedValue(startupInventory);
    ownerMocks.readAvailabilityInventoryForCommit.mockResolvedValue(committedInventory);
    const reporter = Object.freeze({ report: vi.fn(async () => undefined) });
    const reloadController: PluginReloadController = {
      adoptPreparedRuntimeRegistry: vi.fn(),
      acquireRuntimeRegistry: vi.fn(async (params = {}) => {
        const registry = await params.resolveRuntimeRegistry?.();
        if (!registry) throw new Error('missing initial registry');
        return Object.freeze({
          registry,
          source: 'active' as const,
          release: ownerMocks.releaseInitialLease,
        });
      }),
      tryAcquireRuntimeRegistry: vi.fn(() => null),
      isRuntimeRegistryCurrent: vi.fn(() => true),
      applyResourceSessionAccessWitness: vi.fn(),
      shutdown: vi.fn(),
      getState: () => ({ generation: 0, activeRegistry: null, lastResult: null }),
      subscribe: vi.fn(() => () => undefined),
      publishDurableRunningSessionDisposition: vi.fn(),
      currentGlobalExternalSessions: createCurrentGlobalExternalSessionsRouter(
        () => null,
      ),
      subscribeRunningSessionDisposition: vi.fn(() => () => undefined),
    };
    const owner = createDaemonPluginRuntimeOwner({
      happyHomeDir: '/tmp/happier-runtime-owner-availability-test',
      staleCandidateCleanup: 'disabled',
      reloadController,
      connectedAccounts: createUnusedConnectedAccountsOwner(),
      availabilityReporter: reporter,
    });

    await owner.initialize();
    await vi.waitFor(() => expect(reporter.report).toHaveBeenCalledWith(startupInventory));

    const onApplied = ownerMocks.stateStoreParams?.onApplied as
      | ((record: typeof committedRecord) => void)
      | undefined;
    expect(onApplied).toEqual(expect.any(Function));
    onApplied?.(committedRecord);

    await vi.waitFor(() => {
      expect(ownerMocks.readAvailabilityInventoryForCommit).toHaveBeenCalledWith(committedRecord);
      expect(reporter.report).toHaveBeenCalledWith(committedInventory);
    });
  });

  it('retries the full current Availability snapshot after reconnect without a plugin mutation', async () => {
    const currentInventory: PluginRegistryAvailabilityInventory = Object.freeze({
      revision: 9,
      releasePublications: Object.freeze([]),
      // A stale A row reported before the failed revision is intentionally
      // absent. Re-sending this complete N snapshot is what retires it.
      materializations: Object.freeze([Object.freeze({
        materializationId: 'materialization-current-b',
        pluginId: 'com.acme.current-b',
        version: '1.0.0',
        sourceClass: 'registryPackage' as const,
        portableRelease: true,
        archiveDigestSha256: `sha256:${'b'.repeat(64)}`,
        uiArtifacts: Object.freeze([]),
        enabled: true,
        trustState: 'trusted' as const,
        observedAt: 9,
      })]),
    });
    ownerMocks.readAvailabilityInventory.mockResolvedValue(currentInventory);
    const reporter = Object.freeze({
      report: vi.fn()
        .mockRejectedValueOnce(new Error('offline'))
        .mockResolvedValueOnce(undefined),
    });
    const reloadController: PluginReloadController = {
      adoptPreparedRuntimeRegistry: vi.fn(),
      acquireRuntimeRegistry: vi.fn(async (params = {}) => {
        const registry = await params.resolveRuntimeRegistry?.();
        if (!registry) throw new Error('missing initial registry');
        return Object.freeze({
          registry,
          source: 'active' as const,
          release: ownerMocks.releaseInitialLease,
        });
      }),
      tryAcquireRuntimeRegistry: vi.fn(() => null),
      isRuntimeRegistryCurrent: vi.fn(() => true),
      applyResourceSessionAccessWitness: vi.fn(),
      shutdown: vi.fn(),
      getState: () => ({ generation: 0, activeRegistry: null, lastResult: null }),
      subscribe: vi.fn(() => () => undefined),
      publishDurableRunningSessionDisposition: vi.fn(),
      currentGlobalExternalSessions: createCurrentGlobalExternalSessionsRouter(
        () => null,
      ),
      subscribeRunningSessionDisposition: vi.fn(() => () => undefined),
    };
    const owner = createDaemonPluginRuntimeOwner({
      happyHomeDir: '/tmp/happier-runtime-owner-availability-reconnect-test',
      staleCandidateCleanup: 'disabled',
      reloadController,
      connectedAccounts: createUnusedConnectedAccountsOwner(),
      availabilityReporter: reporter,
    });

    await owner.initialize();
    await vi.waitFor(() => expect(reporter.report).toHaveBeenCalledTimes(1));

    owner.reportCurrentAvailability();

    await vi.waitFor(() => expect(reporter.report).toHaveBeenCalledTimes(2));
    expect(ownerMocks.readAvailabilityInventory).toHaveBeenCalledTimes(2);
    expect(reporter.report).toHaveBeenNthCalledWith(1, currentInventory);
    expect(reporter.report).toHaveBeenNthCalledWith(2, currentInventory);
    expect(ownerMocks.readAvailabilityInventoryForCommit).not.toHaveBeenCalled();
  });

  it('resolves an explicit npm update inside the daemon and preserves its durable channel policy', async () => {
    ownerMocks.readStore.mockResolvedValue({
      t: 'happier_plugin_state_v1',
      schemaVersion: 1,
      plugins: {
        'acme.plugin': {
          source: {
            kind: 'package',
            locator: '@acme/plugin',
            trustPolicy: 'prompt',
            installPolicy: 'managed_install',
            resolvedPath: '/tmp/installed',
            manifestPath: '/tmp/installed/.happier-plugin/plugin.json',
          },
          compatibility: { status: 'compatible', diagnostics: [] },
          install: {
            mode: 'managed_install',
            manifestVersion: '1.0.0',
            updatePolicy: 'automatic',
            curatedUpdateSource: {
              id: 'marketplace:curated',
              sourceUrl: 'https://marketplace.example.test/catalog.json',
              registryProfileId: 'registry_private',
            },
            trust: {
              pluginId: 'acme.plugin',
              state: 'trusted',
              approvedAtMs: 1,
              distribution: {
                kind: 'npm',
                packageName: '@acme/plugin',
                registryOrigin: 'https://registry.example.test',
                registryProfileId: 'registry_private',
              },
            },
          },
          state: { enabled: true },
        },
      },
    });
    const prepared = Object.freeze({
      pluginId: 'acme.plugin',
      apply: vi.fn(),
      cleanup: vi.fn(),
    }) as unknown as PreparedDaemonPluginChange;
    ownerMocks.prepareNpm.mockResolvedValue(prepared);
    createDaemonPluginRuntimeOwner({
      happyHomeDir: '/tmp/happier-runtime-owner-test',
      staleCandidateCleanup: 'disabled',
      reloadController: {
        adoptPreparedRuntimeRegistry: vi.fn(),
        acquireRuntimeRegistry: vi.fn(),
        tryAcquireRuntimeRegistry: vi.fn(() => null),
        isRuntimeRegistryCurrent: vi.fn(() => false),
        applyResourceSessionAccessWitness: vi.fn(),
        shutdown: vi.fn(),
        getState: () => ({ generation: 0, activeRegistry: null, lastResult: null }),
        subscribe: vi.fn(() => () => undefined),
        publishDurableRunningSessionDisposition: vi.fn(),
        currentGlobalExternalSessions: createCurrentGlobalExternalSessionsRouter(
          () => null,
        ),
        subscribeRunningSessionDisposition: vi.fn(() => () => undefined),
      },
      connectedAccounts: createUnusedConnectedAccountsOwner(),
    });
    const prepare = ownerMocks.changeServiceParams?.prepare as
      | ((request: PluginChangeRequest) => Promise<PreparedDaemonPluginChange>)
      | undefined;
    if (!prepare) throw new Error('Expected daemon change preparation owner');

    await expect(prepare({ kind: 'update', pluginId: 'acme.plugin' })).resolves.toBe(prepared);
    expect(ownerMocks.prepareNpm).toHaveBeenCalledWith({
      kind: 'installNpm',
      packageName: '@acme/plugin',
      selector: '>=1.0.0',
      registryOrigin: 'https://registry.example.test',
      registryProfileId: 'registry_private',
    }, {
      installedUpdate: {
        pluginId: 'acme.plugin',
        updatePolicy: 'automatic',
      },
    });
  });

  it('threads stable service producers through initial and replacement registry lifecycles', async () => {
    const establishedConnectedAccounts = Object.freeze({
      invoke: vi.fn(),
    });
    const providers = Object.freeze({ bind: vi.fn(() => null) });
    const runtimeActionExecute = vi.fn(async () => Object.freeze({ ok: true }));
    const reloadController: PluginReloadController = {
      adoptPreparedRuntimeRegistry: vi.fn(async () => {
        throw new Error('unexpected prepared-registry adoption');
      }),
      acquireRuntimeRegistry: vi.fn(async (params = {}) => {
        const registry = await params.resolveRuntimeRegistry?.();
        if (!registry) throw new Error('missing initial registry');
        return Object.freeze({
          registry,
          source: 'active' as const,
          release: ownerMocks.releaseInitialLease,
        });
      }),
      tryAcquireRuntimeRegistry: vi.fn(() => null),
      isRuntimeRegistryCurrent: vi.fn(() => false),
      applyResourceSessionAccessWitness: vi.fn(),
      shutdown: vi.fn(async () => undefined),
      getState: () => Object.freeze({
        generation: 0,
        activeRegistry: null,
        lastResult: null,
      }),
      subscribe: vi.fn(() => () => undefined),
      publishDurableRunningSessionDisposition: vi.fn(),
      currentGlobalExternalSessions: createCurrentGlobalExternalSessionsRouter(
        () => null,
      ),
      subscribeRunningSessionDisposition: vi.fn(() => () => undefined),
    };
    const owner = createDaemonPluginRuntimeOwner({
      happyHomeDir: '/tmp/happier-runtime-owner-test',
      staleCandidateCleanup: 'disabled',
      reloadController,
      connectedAccounts: createUnusedConnectedAccountsOwner(),
      providers,
      runtimeActionExecute,
      qualifiedConnectedAccountEstablishedRuntimeOwner:
        establishedConnectedAccounts,
    });

    await owner.initialize();

    expect(
      ownerMocks.resolveRuntimeRegistryParams
        ?.qualifiedConnectedAccountEstablishedRuntimeOwner,
    ).toBe(establishedConnectedAccounts);
    expect(
      ownerMocks.runtimeLifecycleParams
        ?.qualifiedConnectedAccountEstablishedRuntimeOwner,
    ).toBe(establishedConnectedAccounts);
    expect(ownerMocks.resolveRuntimeRegistryParams?.providers).toBe(providers);
    expect(ownerMocks.runtimeLifecycleParams?.providers).toBe(providers);
    expect(ownerMocks.resolveRuntimeRegistryParams?.runtimeActionExecute)
      .toBe(runtimeActionExecute);
    expect(ownerMocks.runtimeLifecycleParams?.runtimeActionExecute)
      .toBe(runtimeActionExecute);
    const readStableEventsBroker = ownerMocks.runtimeLifecycleParams
      ?.readStableEventsBroker as (() => unknown) | undefined;
    expect(readStableEventsBroker?.())
      .toBe(ownerMocks.stableEventsBroker);
  });

  it('uses built-in-only contribution projection for explicit plugin recovery startup', async () => {
    const reloadController: PluginReloadController = {
      adoptPreparedRuntimeRegistry: vi.fn(async () => {
        throw new Error('unexpected prepared-registry adoption');
      }),
      acquireRuntimeRegistry: vi.fn(async (params = {}) => {
        const registry = await params.resolveRuntimeRegistry?.();
        if (!registry) throw new Error('missing recovery registry');
        return Object.freeze({
          registry,
          source: 'active' as const,
          release: ownerMocks.releaseInitialLease,
        });
      }),
      tryAcquireRuntimeRegistry: vi.fn(() => null),
      isRuntimeRegistryCurrent: vi.fn(() => false),
      applyResourceSessionAccessWitness: vi.fn(),
      shutdown: vi.fn(async () => undefined),
      getState: () => ({ generation: 0, activeRegistry: null, lastResult: null }),
      subscribe: vi.fn(() => () => undefined),
      publishDurableRunningSessionDisposition: vi.fn(),
      currentGlobalExternalSessions: createCurrentGlobalExternalSessionsRouter(
        () => null,
      ),
      subscribeRunningSessionDisposition: vi.fn(() => () => undefined),
    };
    const recoveryInput = {
      happyHomeDir: '/tmp/happier-runtime-owner-plugin-recovery-test',
      staleCandidateCleanup: 'disabled' as const,
      reloadController,
      connectedAccounts: createUnusedConnectedAccountsOwner(),
      startupMode: 'pluginRecovery' as const,
    };
    const owner = createDaemonPluginRuntimeOwner(recoveryInput);

    await owner.initialize();

    expect(ownerMocks.runtimeLifecycleParams?.startupMode).toBe('pluginRecovery');
    expect(ownerMocks.resolveRuntimeRegistryParams?.contributes)
      .toEqual(expect.any(Object));
  });

  it('does not publish when durable connected-account reconciliation fails', async () => {
    const failure = new Error('durable contraction failed');
    const publish = vi.fn();
    const reloadController: PluginReloadController = {
      adoptPreparedRuntimeRegistry: vi.fn(async () => {
        throw new Error('unexpected prepared-registry adoption');
      }),
      acquireRuntimeRegistry: vi.fn(async (params = {}) => {
        const registry = await params.resolveRuntimeRegistry?.();
        if (!registry || !params.beforePublish) throw new Error('missing initial publication inputs');
        await params.beforePublish(registry, publish);
        return Object.freeze({
          registry,
          source: 'active' as const,
          release: ownerMocks.releaseInitialLease,
        });
      }),
      tryAcquireRuntimeRegistry: vi.fn(() => null),
      isRuntimeRegistryCurrent: vi.fn(() => false),
      applyResourceSessionAccessWitness: vi.fn(),
      shutdown: vi.fn(async () => undefined),
      getState: () => Object.freeze({
        generation: 0,
        activeRegistry: null,
        lastResult: null,
      }),
      subscribe: vi.fn(() => () => undefined),
      publishDurableRunningSessionDisposition: vi.fn(),
      currentGlobalExternalSessions: createCurrentGlobalExternalSessionsRouter(
        () => null,
      ),
      subscribeRunningSessionDisposition: vi.fn(() => () => undefined),
    };
    const owner = createDaemonPluginRuntimeOwner({
      happyHomeDir: '/tmp/happier-runtime-owner-test',
      staleCandidateCleanup: 'disabled',
      reloadController,
      connectedAccounts: createUnusedConnectedAccountsOwner(),
      reconcileConnectedAccountPurposePublication: async () => {
        throw failure;
      },
    });

    await expect(owner.initialize()).rejects.toBe(failure);
    expect(publish).not.toHaveBeenCalled();
    expect(ownerMocks.releaseInitialLease).not.toHaveBeenCalled();
  });

});
