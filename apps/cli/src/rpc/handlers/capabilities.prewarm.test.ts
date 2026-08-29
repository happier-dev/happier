import { describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { CapabilitiesDescribeResponse } from '@happier-dev/protocol';
import type { AgentCatalogEntry } from '@/agent/catalog/types';
import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';

function createEmptyResolvedContributionRegistry(): ResolvedContributionRegistry {
  return {
    agents: [],
    actions: [],
    resources: [],
    activationTargets: [],
    catalogEntriesById: {},
    agentDefinitionsById: new Map(),
    pluginDiagnosticsByPluginId: {},
  };
}

function createCodexCatalogEntry(): AgentCatalogEntry {
  return {
    id: 'codex',
    cliSubcommand: 'codex',
    vendorResumeSupport: 'supported',
  };
}

function mockPreflightAdapterResolution(resolverSpy: () => Promise<null>): void {
  vi.doMock('@/capabilities/probes/resolvePreflightSessionControlsProbeAdapter', () => ({
    resolvePreflightSessionControlsProbeAdapter: resolverSpy,
  }));
}

function mockProviderCliResolution(): void {
  vi.doMock('@/packagedRuntime/managedTools/agentCliResolution', () => ({
    readBackendCliSourcePreference: () => 'system-first',
    readAgentCliOverride: () => null,
    resolveAgentCliCommand: () => null,
    resolveAgentCliManagedCommandPath: () => '/tmp/happier-managed-provider-cli',
  }));
}

function mockResolveMergedContributionRegistry(
  resolveMergedContributionRegistry: () => Promise<ResolvedContributionRegistry>,
): void {
  vi.doMock('@/plugins/projection/registry/createResolvedContributionRegistry', () => ({
    resolveMergedContributionRegistry,
    getResolvedContributionRegistry: () => {
      throw new Error('built-in registry is unavailable in this harness');
    },
  }));
}

describe('registerCapabilitiesHandlers prewarm', () => {
  it('waits for the merged registry resolution before resolving generic capability support', async () => {
    vi.resetModules();

    let releaseSnapshot!: (value: ResolvedContributionRegistry) => void;
    const resolveMergedContributionRegistrySpy = vi.fn(
      () => new Promise<ResolvedContributionRegistry>((resolve) => {
        releaseSnapshot = resolve;
      }),
    );
    const resolverSpy = vi.fn(async () => null);

    mockProviderCliResolution();

    mockResolveMergedContributionRegistry(resolveMergedContributionRegistrySpy);
    mockPreflightAdapterResolution(resolverSpy);

    vi.doMock('@/agent/catalog/registry', () => {
      return {
        AGENTS: {
          codex: createCodexCatalogEntry(),
        },
      };
    });

    const { registerCapabilitiesHandlers } = await import('./capabilities');
    const { createEncryptedRpcTestClient } = await import('./encryptedRpc.testkit');

    createEncryptedRpcTestClient({
      scopePrefix: 'machine-test',
      encryptionKey: new Uint8Array(32).fill(7),
      logger: () => undefined,
      registerHandlers: (manager) => registerCapabilitiesHandlers(manager),
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(resolveMergedContributionRegistrySpy).toHaveBeenCalledTimes(1);
    expect(resolverSpy).toHaveBeenCalledTimes(0);

    releaseSnapshot(createEmptyResolvedContributionRegistry());
    await Promise.resolve();
    await Promise.resolve();
    expect(resolverSpy).toHaveBeenCalledTimes(1);
  });

  it('warms capability service during handler registration', async () => {
    vi.resetModules();

    const resolveMergedContributionRegistrySpy = vi.fn(async () => createEmptyResolvedContributionRegistry());
    const resolverSpy = vi.fn(async () => null);

    mockProviderCliResolution();

    mockResolveMergedContributionRegistry(resolveMergedContributionRegistrySpy);
    mockPreflightAdapterResolution(resolverSpy);

    vi.doMock('@/agent/catalog/registry', () => {
      return {
        AGENTS: {
          codex: createCodexCatalogEntry(),
        },
      };
    });

    const { registerCapabilitiesHandlers } = await import('./capabilities');
    const { createEncryptedRpcTestClient } = await import('./encryptedRpc.testkit');

    const { call } = createEncryptedRpcTestClient({
      scopePrefix: 'machine-test',
      encryptionKey: new Uint8Array(32).fill(7),
      logger: () => undefined,
      registerHandlers: (manager) => registerCapabilitiesHandlers(manager),
    });

    await vi.waitFor(() => {
      expect(resolverSpy).toHaveBeenCalledTimes(1);
    });
    expect(resolveMergedContributionRegistrySpy).toHaveBeenCalledTimes(1);

    const result = await call<CapabilitiesDescribeResponse, Record<string, never>>(RPC_METHODS.CAPABILITIES_DESCRIBE, {});

    expect(result.capabilities.some((entry: { id: string }) => entry.id === 'cli.codex')).toBe(true);
    expect(resolverSpy).toHaveBeenCalledTimes(1);
  });

  it('rebuilds the warmed service after the plugin reload generation changes', async () => {
    vi.resetModules();

    let pluginReloadGeneration = 0;
    const resolveMergedContributionRegistrySpy = vi.fn(async () => createEmptyResolvedContributionRegistry());
    const resolverSpy = vi.fn(async () => null);

    mockProviderCliResolution();
    mockResolveMergedContributionRegistry(resolveMergedContributionRegistrySpy);
    mockPreflightAdapterResolution(resolverSpy);

    vi.doMock('@/plugins/runtime/reload/singleton', () => ({
      pluginReloadController: {
        getState: () => ({
          generation: pluginReloadGeneration,
          activeRegistry: null,
          lastResult: null,
        }),
        reload: vi.fn(),
        acquireRuntimeRegistry: vi.fn(),
      },
    }));

    vi.doMock('@/agent/catalog/registry', () => {
      return {
        AGENTS: {
          codex: createCodexCatalogEntry(),
        },
      };
    });

    const { registerCapabilitiesHandlers } = await import('./capabilities');
    const { createEncryptedRpcTestClient } = await import('./encryptedRpc.testkit');

    const { call } = createEncryptedRpcTestClient({
      scopePrefix: 'machine-test',
      encryptionKey: new Uint8Array(32).fill(7),
      logger: () => undefined,
      registerHandlers: (manager) => registerCapabilitiesHandlers(manager),
    });

    await vi.waitFor(() => {
      expect(resolverSpy).toHaveBeenCalledTimes(1);
    });

    const beforeReload = await call<CapabilitiesDescribeResponse, Record<string, never>>(
      RPC_METHODS.CAPABILITIES_DESCRIBE,
      {},
    );
    expect(beforeReload.capabilities.find((entry: { id: string }) => entry.id === 'cli.codex')?.title)
      .toBe('Codex CLI');

    pluginReloadGeneration = 1;

    const afterReload = await call<CapabilitiesDescribeResponse, Record<string, never>>(
      RPC_METHODS.CAPABILITIES_DESCRIBE,
      {},
    );
    expect(afterReload.capabilities.find((entry: { id: string }) => entry.id === 'cli.codex')?.title)
      .toBe('Codex CLI');
    expect(resolverSpy).toHaveBeenCalledTimes(2);
    expect(resolveMergedContributionRegistrySpy).toHaveBeenCalledTimes(2);
  });
});
