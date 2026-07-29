import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PluginReloadController } from '@/plugins/runtime/reload/controller';
import type { StablePluginConnectedAccountsOwner } from '@/plugins/runtime/invocation/services/connectedAccounts';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import type { PluginChangeRequest, PreparedDaemonPluginChange } from './changeContract';

const ownerMocks = vi.hoisted(() => ({
  runtimeLifecycleParams: null as null | Readonly<Record<string, unknown>>,
  resolveRuntimeRegistryParams: null as null | Readonly<Record<string, unknown>>,
  changeServiceParams: null as null | Readonly<Record<string, unknown>>,
  prepareNpm: vi.fn(),
  preparePath: vi.fn(),
  prepareArchive: vi.fn(),
  readStore: vi.fn(),
  initializeStore: vi.fn(async () => undefined),
  settleCurrentNonExecutableHealthAfterRuntimePublication: vi.fn(async () => undefined),
  releaseInitialLease: vi.fn(async () => undefined),
}));

vi.mock('@/plugins/daemon/archiveChangePreparer', () => ({
  createDaemonArchivePluginChangePreparer: () => ownerMocks.prepareArchive,
}));
vi.mock('@/plugins/daemon/changeService', () => ({
  createDaemonPluginChangeService: (params: Readonly<Record<string, unknown>>) => {
    ownerMocks.changeServiceParams = params;
    return Object.freeze({
      requestPluginChange: vi.fn(),
      decidePluginChange: vi.fn(),
      runAutomaticCurrentnessChange: vi.fn(),
      quiesceForHandoff: vi.fn(),
      shutdown: vi.fn(),
    });
  },
}));
vi.mock('@/plugins/daemon/npmChangePreparer', () => ({
  createDaemonNpmPluginChangePreparer: () => ownerMocks.prepareNpm,
}));
vi.mock('@/plugins/daemon/pathChangePreparer', () => ({
  createDaemonPathPluginChangePreparer: () => ownerMocks.preparePath,
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
    return Object.freeze({
      contributes: Object.freeze({ generationId: 'candidate-generation' }),
    });
  }),
}));
vi.mock('@/plugins/store/registry/currentState', () => ({
  createPluginRegistryStateStore: () => Object.freeze({
    read: ownerMocks.readStore,
    initialize: ownerMocks.initializeStore,
    settleCurrentNonExecutableHealthAfterRuntimePublication:
      ownerMocks.settleCurrentNonExecutableHealthAfterRuntimePublication,
    observeActivationAttempt: vi.fn(),
  }),
}));
vi.mock('@/ui/logger', () => ({
  logger: {
    warn: vi.fn(),
  },
}));

import { createDaemonPluginRuntimeOwner } from './runtimeOwner';

function createUnusedConnectedAccountsOwner(): StablePluginConnectedAccountsOwner {
  return Object.freeze({
    getBinding: vi.fn(async () => null),
    requestSelection: vi.fn(async () => {
      throw new Error('unexpected connected-account selection');
    }),
    materialize: vi.fn(async () => {
      throw new Error('unexpected connected-account materialization');
    }),
    watch: vi.fn(() => Object.freeze({ dispose() {} })),
  });
}

describe('createDaemonPluginRuntimeOwner publication join', () => {
  beforeEach(() => {
    ownerMocks.runtimeLifecycleParams = null;
    ownerMocks.resolveRuntimeRegistryParams = null;
    ownerMocks.changeServiceParams = null;
    ownerMocks.prepareNpm.mockReset();
    ownerMocks.preparePath.mockReset();
    ownerMocks.prepareArchive.mockReset();
    ownerMocks.readStore.mockReset();
    ownerMocks.initializeStore.mockClear();
    ownerMocks.settleCurrentNonExecutableHealthAfterRuntimePublication.mockClear();
    ownerMocks.releaseInitialLease.mockClear();
  });

  it('passes the publication callback through the connected-account owner after durable contraction', async () => {
    const events: string[] = [];
    const previous = Object.freeze({ generationId: 'previous-generation' });
    const reconcile = vi.fn(async (input: Readonly<{
      previous: unknown;
      candidate: unknown;
      resolveOptionalAccess(pluginId: string): readonly unknown[];
      publish(): void;
    }>) => {
      expect(input.previous).toBe(previous);
      expect(input.candidate).toEqual({ generationId: 'candidate-generation' });
      expect(input.resolveOptionalAccess('acme.plugin')).toEqual([]);
      events.push('durable-contraction');
      input.publish();
      events.push('reconciled');
    });
    // This owner-boundary fixture deliberately supplies only the registry field the owner reads.
    const previousRegistry = Object.freeze({
      contributes: previous,
    }) as unknown as ResolvedExecutablePluginRuntimeRegistry;
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
      shutdown: vi.fn(async () => undefined),
      getState: () => Object.freeze({
        generation: 1,
        activeRegistry: previousRegistry,
        lastResult: null,
      }),
      subscribe: vi.fn(() => () => undefined),
    };

    const owner = createDaemonPluginRuntimeOwner({
      happyHomeDir: '/tmp/happier-runtime-owner-test',
      staleCandidateCleanup: 'disabled',
      daemonInstanceId: 'daemon-test',
      daemonUptimeMs: () => 1,
      reloadController,
      connectedAccounts: createUnusedConnectedAccountsOwner(),
      reconcileConnectedAccountPurposePublication: reconcile,
    });
    await owner.initialize();

    expect(events).toEqual(['durable-contraction', 'published', 'reconciled']);
    expect(ownerMocks.settleCurrentNonExecutableHealthAfterRuntimePublication).toHaveBeenCalledOnce();
    expect(ownerMocks.releaseInitialLease).toHaveBeenCalledOnce();
    expect(
      ownerMocks.settleCurrentNonExecutableHealthAfterRuntimePublication.mock.invocationCallOrder[0],
    ).toBeLessThan(ownerMocks.releaseInitialLease.mock.invocationCallOrder[0]!);
    expect(ownerMocks.runtimeLifecycleParams?.beforePublish).toBe(
      acquireRuntimeRegistry.mock.calls[0]?.[0]?.beforePublish,
    );
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
      daemonInstanceId: 'daemon-test',
      daemonUptimeMs: () => 1,
      reloadController: {
        adoptPreparedRuntimeRegistry: vi.fn(),
        acquireRuntimeRegistry: vi.fn(),
        tryAcquireRuntimeRegistry: vi.fn(() => null),
        isRuntimeRegistryCurrent: vi.fn(() => false),
        shutdown: vi.fn(),
        getState: () => ({ generation: 0, activeRegistry: null, lastResult: null }),
        subscribe: vi.fn(() => () => undefined),
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
      registryOrigin: 'https://registry.example.test',
      registryProfileId: 'registry_private',
    }, {
      installedUpdate: {
        pluginId: 'acme.plugin',
        updatePolicy: 'automatic',
      },
    });
  });

  it('threads the single established-account owner through initial and replacement registry lifecycles', async () => {
    const establishedConnectedAccounts = Object.freeze({
      invoke: vi.fn(),
    });
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
      shutdown: vi.fn(async () => undefined),
      getState: () => Object.freeze({
        generation: 0,
        activeRegistry: null,
        lastResult: null,
      }),
      subscribe: vi.fn(() => () => undefined),
    };
    const owner = createDaemonPluginRuntimeOwner({
      happyHomeDir: '/tmp/happier-runtime-owner-test',
      staleCandidateCleanup: 'disabled',
      daemonInstanceId: 'daemon-test',
      daemonUptimeMs: () => 1,
      reloadController,
      connectedAccounts: createUnusedConnectedAccountsOwner(),
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
      shutdown: vi.fn(async () => undefined),
      getState: () => Object.freeze({
        generation: 0,
        activeRegistry: null,
        lastResult: null,
      }),
      subscribe: vi.fn(() => () => undefined),
    };
    const owner = createDaemonPluginRuntimeOwner({
      happyHomeDir: '/tmp/happier-runtime-owner-test',
      staleCandidateCleanup: 'disabled',
      daemonInstanceId: 'daemon-test',
      daemonUptimeMs: () => 1,
      reloadController,
      connectedAccounts: createUnusedConnectedAccountsOwner(),
      reconcileConnectedAccountPurposePublication: async () => {
        throw failure;
      },
    });

    await expect(owner.initialize()).rejects.toBe(failure);
    expect(publish).not.toHaveBeenCalled();
    expect(ownerMocks.settleCurrentNonExecutableHealthAfterRuntimePublication).not.toHaveBeenCalled();
    expect(ownerMocks.releaseInitialLease).not.toHaveBeenCalled();
  });

});
