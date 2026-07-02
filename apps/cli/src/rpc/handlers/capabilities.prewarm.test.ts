import { describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { CapabilitiesDescribeResponse } from '@happier-dev/protocol';
import type { Capability } from '@/capabilities/service';
import type { AgentCatalogEntry } from '@/backends/types';
import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';

function createEmptyResolvedContributionRegistry(): ResolvedContributionRegistry {
  return {
    providers: [],
    backends: [],
    actions: [],
    resources: [],
    uiDescriptors: [],
    activationTargets: [],
    hookRegistrations: [],
    surfaceHandlersByBackendId: new Map(),
    catalogEntriesById: {},
    providerDefinitionsById: new Map(),
    backendDefinitionsById: new Map(),
    pluginDiagnosticsByPluginId: {},
  };
}

function createCodexCatalogEntry(loaderSpy: () => Promise<Capability>): AgentCatalogEntry {
  return {
    id: 'codex',
    cliSubcommand: 'codex',
    vendorResumeSupport: 'supported',
    getCliCapabilityOverride: loaderSpy,
  };
}

function mockProviderCliResolution(): void {
  vi.doMock('@/packagedRuntime/managedTools/providerCliResolution', () => ({
    readBackendCliSourcePreference: () => 'system-first',
    readProviderCliOverride: () => null,
    resolveProviderCliCommand: () => null,
    resolveProviderCliManagedCommandPath: () => '/tmp/happier-managed-provider-cli',
  }));
}

function mockPrimeResolvedContributionRegistry(
  primeResolvedContributionRegistry: () => Promise<ResolvedContributionRegistry>,
): void {
  vi.doMock('@/plugins/projection/registry/createResolvedContributionRegistry', () => ({
    primeResolvedContributionRegistry,
  }));
}

describe('registerCapabilitiesHandlers prewarm', () => {
  it('waits for merged registry priming before loading capability overrides', async () => {
    vi.resetModules();

    let releasePrime!: (value: ResolvedContributionRegistry) => void;
    const primeResolvedContributionRegistrySpy = vi.fn(
      () => new Promise<ResolvedContributionRegistry>((resolve) => {
        releasePrime = resolve;
      }),
    );
    const loaderSpy = vi.fn(async (): Promise<Capability> => ({
      descriptor: {
        id: 'cli.codex' as const,
        kind: 'cli' as const,
        title: 'Codex CLI',
        methods: {},
      },
      detect: async () => ({ available: true }),
    }));

    mockProviderCliResolution();

    mockPrimeResolvedContributionRegistry(primeResolvedContributionRegistrySpy);

    vi.doMock('@/backends/catalog', () => {
      return {
        AGENTS: {
          codex: createCodexCatalogEntry(loaderSpy),
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
    expect(primeResolvedContributionRegistrySpy).toHaveBeenCalledTimes(1);
    expect(loaderSpy).toHaveBeenCalledTimes(0);

    releasePrime(createEmptyResolvedContributionRegistry());
    await Promise.resolve();
    await Promise.resolve();
    expect(loaderSpy).toHaveBeenCalledTimes(1);
  });

  it('warms capability service during handler registration', async () => {
    vi.resetModules();

    let allowLoader = true;
    const primeResolvedContributionRegistrySpy = vi.fn(async () => createEmptyResolvedContributionRegistry());
    const loaderSpy = vi.fn(async (): Promise<Capability> => {
      if (!allowLoader) throw new Error('late-loader-failure');
      return {
        descriptor: {
          id: 'cli.codex' as const,
          kind: 'cli' as const,
          title: 'Codex CLI',
          methods: {},
        },
        detect: async () => ({ available: true }),
      };
    });

    mockProviderCliResolution();

    mockPrimeResolvedContributionRegistry(primeResolvedContributionRegistrySpy);

    vi.doMock('@/backends/catalog', () => {
      return {
        AGENTS: {
          codex: createCodexCatalogEntry(loaderSpy),
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
      expect(loaderSpy).toHaveBeenCalledTimes(1);
    });
    expect(primeResolvedContributionRegistrySpy).toHaveBeenCalledTimes(1);

    allowLoader = false;
    const result = await call<CapabilitiesDescribeResponse, Record<string, never>>(RPC_METHODS.CAPABILITIES_DESCRIBE, {});

    expect(result.capabilities.some((entry: { id: string }) => entry.id === 'cli.codex')).toBe(true);
    expect(loaderSpy).toHaveBeenCalledTimes(1);
  });

  it('clears a failed prewarm promise so later calls can recover', async () => {
    vi.resetModules();

    let allowLoader = false;
    const primeResolvedContributionRegistrySpy = vi.fn(async () => createEmptyResolvedContributionRegistry());
    const loaderSpy = vi.fn(async (): Promise<Capability> => {
      if (!allowLoader) throw new Error('late-loader-failure');
      return {
        descriptor: {
          id: 'cli.codex' as const,
          kind: 'cli' as const,
          title: 'Codex CLI',
          methods: {},
        },
        detect: async () => ({ available: true }),
      };
    });

    mockProviderCliResolution();

    mockPrimeResolvedContributionRegistry(primeResolvedContributionRegistrySpy);

    vi.doMock('@/backends/catalog', () => {
      return {
        AGENTS: {
          codex: createCodexCatalogEntry(loaderSpy),
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

    // Prewarm failures are swallowed; force a first request to observe the failure shape.
    const first = await call<Record<string, unknown>, Record<string, never>>(RPC_METHODS.CAPABILITIES_DESCRIBE, {});
    expect(first).toHaveProperty('error');

    allowLoader = true;
    const result = await call<CapabilitiesDescribeResponse, Record<string, never>>(RPC_METHODS.CAPABILITIES_DESCRIBE, {});

    expect(Array.isArray(result.capabilities)).toBe(true);
    expect(result.capabilities.some((entry: { id: string }) => entry.id === 'cli.codex')).toBe(true);
    expect(loaderSpy).toHaveBeenCalledTimes(2);
    expect(primeResolvedContributionRegistrySpy).toHaveBeenCalledTimes(2);
  });
});
