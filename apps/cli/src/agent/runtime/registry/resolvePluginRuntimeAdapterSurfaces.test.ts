import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readHookEventEnvelopeV1 } from '@happier-dev/protocol';
import type { BackendRuntimeAdapterV1 } from '@happier-dev/protocol';

import { createResolvedContributionRegistry } from '../../../extensions/registry/createResolvedContributionRegistry';
import type {
  ResolvedBackendContribution,
  ResolvedProviderContribution,
} from '../../../extensions/registry/types';
import type { ResolvedExecutablePluginRuntimeRegistry } from '../../../extensions/runtime/resolveExecutablePluginRuntimeRegistry';

const { loadPluginDaemonModuleMock } = vi.hoisted(() => ({
  loadPluginDaemonModuleMock: vi.fn(),
}));

vi.mock('../../../extensions/runtime/loadPluginDaemonModule', () => ({
  loadPluginDaemonModule: loadPluginDaemonModuleMock,
}));

import { resolvePluginRuntimeAdapterSurfaces } from './resolvePluginRuntimeAdapterSurfaces';

function createProviderContribution(): ResolvedProviderContribution {
    return {
        id: 'acme.runtime',
        provenance: 'external',
        source: { kind: 'path' },
        definition: {
            kindVersion: 1,
            id: 'acme.runtime',
            ownedBackendIds: ['acme.runtime.backend'],
        },
    };
}

function createBackendContribution(): ResolvedBackendContribution {
    return {
        id: 'acme.runtime.backend',
        providerId: 'acme.runtime',
        provenance: 'external',
        source: { kind: 'path' },
        definition: {
            kindVersion: 1,
            id: 'acme.runtime.backend',
            providerId: 'acme.runtime',
        },
        runtimeKind: 'acp',
        daemonEntryPath: '/tmp/acme-runtime/daemon.mjs',
        pluginId: 'acme.runtime',
        manifestPath: '/tmp/acme-runtime/.happier-plugin/plugin.json',
        manifestDigest: 'digest-1',
    };
}

function createRuntimeRegistry(backend: ResolvedBackendContribution): ResolvedExecutablePluginRuntimeRegistry {
  const provider = createProviderContribution();
  const contributions = createResolvedContributionRegistry({
    providers: [provider],
    backends: [backend],
    hookRegistrations: [],
  });

    return {
    contributions,
    actionHandlersByActionId: new Map(),
    hookHandlersByHookId: new Map(),
    runtimeAdapterHandlersByBackendId: new Map(),
    backendEnginesByBackendId: new Map(),
    pluginDiagnosticsByPluginId: Object.freeze({}),
    readHookEventEnvelopeV1,
    dispose: async () => undefined,
  };
}

describe('resolvePluginRuntimeAdapterSurfaces', () => {
  beforeEach(() => {
    loadPluginDaemonModuleMock.mockReset();
  });

  it('resolves daemon-backed runtime adapter handlers into the canonical execution surfaces', async () => {
    const backend = createBackendContribution();
    const provider = createProviderContribution();
    const runtimeAdapter: BackendRuntimeAdapterV1 = {
      runtimeAdapterApiVersion: 1,
      id: 'backend.terminalRuntime.launch',
      kind: 'terminalRuntime',
      operation: 'launch',
      handler: {
        target: 'daemon',
        exportName: 'launch',
      },
    };
    const backendWithRuntimeAdapters: ResolvedBackendContribution = {
      ...backend,
      runtimeAdapters: [runtimeAdapter],
    };
    const launch = vi.fn(async () => 'launched');
    loadPluginDaemonModuleMock.mockResolvedValue({
      launch,
    });

    const result = await resolvePluginRuntimeAdapterSurfaces({
      backend: backendWithRuntimeAdapters,
      provider,
      runtimeRegistry: createRuntimeRegistry(backendWithRuntimeAdapters),
    });

    expect('bindings' in result).toBe(false);
    expect(result.diagnostics).toEqual([]);
    await expect(result.surfaces.terminalRuntime?.launch?.({})).resolves.toBe('launched');
    expect(result.surfaces.directSessions).toBeNull();
    expect(result.surfaces.attach).toBeNull();
    expect(result.surfaces.sessionHandoff).toBeNull();
    expect(loadPluginDaemonModuleMock).toHaveBeenCalledWith({
      daemonEntryPath: '/tmp/acme-runtime/daemon.mjs',
      cacheKey: 'digest-1',
    });
  });

  it('reuses activated runtime adapter handlers from the executable runtime registry', async () => {
    const backend = createBackendContribution();
    const provider = createProviderContribution();
    const runtimeAdapter: BackendRuntimeAdapterV1 = {
      runtimeAdapterApiVersion: 1,
      id: 'backend.terminalRuntime.launch',
      kind: 'terminalRuntime',
      operation: 'launch',
      handler: {
        target: 'daemon',
        exportName: 'launch',
      },
    };
    const backendWithRuntimeAdapters: ResolvedBackendContribution = {
      ...backend,
      runtimeAdapters: [runtimeAdapter],
    };
    const launch = vi.fn(async () => 'activated-launched');
    loadPluginDaemonModuleMock.mockRejectedValue(new Error('direct module load should not be used'));

    const runtimeRegistry: ResolvedExecutablePluginRuntimeRegistry = {
      ...createRuntimeRegistry(backendWithRuntimeAdapters),
      runtimeAdapterHandlersByBackendId: new Map([
        [
          backend.id,
          new Map([
            ['terminalRuntime:launch', launch],
          ]),
        ],
      ]),
    };

    const result = await resolvePluginRuntimeAdapterSurfaces({
      backend: backendWithRuntimeAdapters,
      provider,
      runtimeRegistry,
    });

    expect(result.diagnostics).toEqual([]);
    await expect(result.surfaces.terminalRuntime?.launch?.({})).resolves.toBe('activated-launched');
    expect(loadPluginDaemonModuleMock).not.toHaveBeenCalled();
  });

  it('merges activated runtime adapter handlers with manifest-backed runtime adapter operations', async () => {
    const backend = createBackendContribution();
    const provider = createProviderContribution();
    const runtimeAdapters: BackendRuntimeAdapterV1[] = [
      {
        runtimeAdapterApiVersion: 1,
        id: 'backend.terminalRuntime.launch',
        kind: 'terminalRuntime',
        operation: 'launch',
        handler: {
          target: 'daemon',
          exportName: 'launch',
        },
      },
      {
        runtimeAdapterApiVersion: 1,
        id: 'backend.terminalRuntime.discoverIdentity',
        kind: 'terminalRuntime',
        operation: 'discoverIdentity',
        handler: {
          target: 'daemon',
          exportName: 'discoverIdentity',
        },
      },
    ];
    const backendWithRuntimeAdapters: ResolvedBackendContribution = {
      ...backend,
      runtimeAdapters,
    };
    const launch = vi.fn(async () => 'activated-launched');
    const bindTranscript = vi.fn(async () => 'activated-bind');
    const runtimeRegistry: ResolvedExecutablePluginRuntimeRegistry = {
      ...createRuntimeRegistry(backendWithRuntimeAdapters),
      runtimeAdapterHandlersByBackendId: new Map([
        [
          backend.id,
          new Map([
            ['terminalRuntime:bindTranscript', bindTranscript],
          ]),
        ],
      ]),
    };
    loadPluginDaemonModuleMock.mockResolvedValue({
      launch,
      discoverIdentity: vi.fn(async () => 'manifest-discover-identity'),
    });

    const result = await resolvePluginRuntimeAdapterSurfaces({
      backend: backendWithRuntimeAdapters,
      provider,
      runtimeRegistry,
    });

    const terminalRuntime = result.surfaces.terminalRuntime;
    expect(result.diagnostics).toEqual([]);
    expect(terminalRuntime).toEqual(expect.objectContaining({
      launch: expect.any(Function),
      discoverIdentity: expect.any(Function),
      bindTranscript: expect.any(Function),
    }));
    if (!terminalRuntime?.launch || !terminalRuntime.discoverIdentity || !terminalRuntime.bindTranscript) {
      throw new Error('Expected merged terminal runtime operations to be available');
    }
    await expect(terminalRuntime.launch({})).resolves.toBe('activated-launched');
    await expect(terminalRuntime.discoverIdentity({})).resolves.toBe('manifest-discover-identity');
    await expect(terminalRuntime.bindTranscript({})).resolves.toBe('activated-bind');
    expect(loadPluginDaemonModuleMock).toHaveBeenCalledWith({
      daemonEntryPath: '/tmp/acme-runtime/daemon.mjs',
      cacheKey: 'digest-1',
    });
  });

  it('returns a diagnostic when a runtime adapter export is missing', async () => {
    const backend = createBackendContribution();
    const provider = createProviderContribution();
    const runtimeAdapter: BackendRuntimeAdapterV1 = {
      runtimeAdapterApiVersion: 1,
      id: 'backend.terminalRuntime.launch',
      kind: 'terminalRuntime',
      operation: 'launch',
      handler: {
        target: 'daemon',
        exportName: 'launch',
      },
    };
    const backendWithRuntimeAdapters: ResolvedBackendContribution = {
      ...backend,
      runtimeAdapters: [runtimeAdapter],
    };
    loadPluginDaemonModuleMock.mockResolvedValue({});

    const result = await resolvePluginRuntimeAdapterSurfaces({
      backend: backendWithRuntimeAdapters,
      provider,
      runtimeRegistry: createRuntimeRegistry(backendWithRuntimeAdapters),
    });

    expect('bindings' in result).toBe(false);
    expect(result.surfaces.terminalRuntime).toBeNull();
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'engine_plugin_runtime_adapter_handler_missing',
        backendId: backend.id,
        providerId: provider.id,
        pluginId: backend.pluginId,
      }),
    ]);
  });

  it('fails closed for prompt-trust plugin runtime adapters before importing the daemon module', async () => {
    const backend: ResolvedBackendContribution = {
      ...createBackendContribution(),
      sourceSpec: {
        kind: 'archive',
        locator: 'https://example.com/acme-runtime.tar.gz',
        trustPolicy: 'prompt',
        installPolicy: 'managed_install',
      },
    } as ResolvedBackendContribution;
    const provider = createProviderContribution();
    const backendWithRuntimeAdapters: ResolvedBackendContribution = {
      ...backend,
      runtimeAdapters: [{
        runtimeAdapterApiVersion: 1,
        id: 'backend.terminalRuntime.launch',
        kind: 'terminalRuntime',
        operation: 'launch',
        handler: {
          target: 'daemon',
          exportName: 'launch',
        },
      }],
    };
    loadPluginDaemonModuleMock.mockRejectedValue(Object.assign(
      new Error('Plugin executable load requires explicit trust approval before loading daemon code'),
      { code: 'PLUGIN_DAEMON_TRUST_APPROVAL_REQUIRED' },
    ));

    const result = await resolvePluginRuntimeAdapterSurfaces({
      backend: backendWithRuntimeAdapters,
      provider,
      runtimeRegistry: createRuntimeRegistry(backendWithRuntimeAdapters),
    });

    expect(result.surfaces.terminalRuntime).toBeNull();
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'engine_plugin_daemon_module_load_failed',
        message: expect.stringMatching(/approval/i),
        backendId: backend.id,
        providerId: provider.id,
        pluginId: backend.pluginId,
      }),
    ]);
    expect(loadPluginDaemonModuleMock).toHaveBeenCalledWith({
      daemonEntryPath: '/tmp/acme-runtime/daemon.mjs',
      cacheKey: 'digest-1',
      trustPolicy: 'prompt',
    });
  });

  it('fails closed for untrusted plugin runtime adapters before importing the daemon module', async () => {
    const backend: ResolvedBackendContribution = {
      ...createBackendContribution(),
      sourceSpec: {
        kind: 'archive',
        locator: 'https://example.com/acme-runtime.tar.gz',
        trustPolicy: 'untrusted',
        installPolicy: 'managed_install',
      },
    } as ResolvedBackendContribution;
    const provider = createProviderContribution();
    const backendWithRuntimeAdapters: ResolvedBackendContribution = {
      ...backend,
      runtimeAdapters: [{
        runtimeAdapterApiVersion: 1,
        id: 'backend.terminalRuntime.launch',
        kind: 'terminalRuntime',
        operation: 'launch',
        handler: {
          target: 'daemon',
          exportName: 'launch',
        },
      }],
    };
    loadPluginDaemonModuleMock.mockRejectedValue(Object.assign(
      new Error('Refusing to load executable plugin daemon entry from an untrusted source'),
      { code: 'PLUGIN_DAEMON_TRUST_UNTRUSTED' },
    ));

    const result = await resolvePluginRuntimeAdapterSurfaces({
      backend: backendWithRuntimeAdapters,
      provider,
      runtimeRegistry: createRuntimeRegistry(backendWithRuntimeAdapters),
    });

    expect(result.surfaces.terminalRuntime).toBeNull();
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'engine_plugin_daemon_module_load_failed',
        message: expect.stringMatching(/untrusted/i),
        backendId: backend.id,
        providerId: provider.id,
        pluginId: backend.pluginId,
      }),
    ]);
    expect(loadPluginDaemonModuleMock).toHaveBeenCalledWith({
      daemonEntryPath: '/tmp/acme-runtime/daemon.mjs',
      cacheKey: 'digest-1',
      trustPolicy: 'untrusted',
    });
  });

  it('routes terminal runtime surfaces by canonical operation rather than opaque adapter id', async () => {
    const backend = createBackendContribution();
    const provider = createProviderContribution();
    const runtimeAdapter = {
      runtimeAdapterApiVersion: 1,
      id: 'launch-adapter',
      kind: 'terminalRuntime',
      operation: 'launch',
      handler: {
        target: 'daemon',
        exportName: 'launch',
      },
    } as BackendRuntimeAdapterV1;
    const backendWithRuntimeAdapters: ResolvedBackendContribution = {
      ...backend,
      runtimeAdapters: [runtimeAdapter],
    };
    const launch = vi.fn(async () => 'launched');
    loadPluginDaemonModuleMock.mockResolvedValue({
      launch,
    });

    const result = await resolvePluginRuntimeAdapterSurfaces({
      backend: backendWithRuntimeAdapters,
      provider,
      runtimeRegistry: createRuntimeRegistry(backendWithRuntimeAdapters),
    });

    expect(result.diagnostics).toEqual([]);
    await expect(result.surfaces.terminalRuntime?.launch?.({})).resolves.toBe('launched');
  });
});
