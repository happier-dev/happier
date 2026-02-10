import { describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { CapabilitiesDescribeResponse } from '@happier-dev/protocol';

describe('registerCapabilitiesHandlers prewarm', () => {
  it('warms capability service during handler registration', async () => {
    vi.resetModules();

    let allowLoader = true;
    const loaderSpy = vi.fn(async () => {
      if (!allowLoader) throw new Error('late-loader-failure');
      return {
        descriptor: {
          id: 'cli.codex',
          kind: 'cli',
          title: 'Codex CLI',
          methods: {},
        },
        detect: async () => ({ available: true }),
      };
    });

    vi.doMock('@/backends/catalog', () => ({
      AGENTS: {
        codex: {
          id: 'codex',
          getCliCapabilityOverride: loaderSpy,
        },
      },
    }));

    const { registerCapabilitiesHandlers } = await import('./capabilities');
    const { createEncryptedRpcTestClient } = await import('./encryptedRpc.testkit');

    const { call } = createEncryptedRpcTestClient({
      scopePrefix: 'machine-test',
      encryptionKey: new Uint8Array(32).fill(7),
      logger: () => undefined,
      registerHandlers: (manager) => registerCapabilitiesHandlers(manager),
    });

    expect(loaderSpy).toHaveBeenCalledTimes(1);

    allowLoader = false;
    const result = await call<CapabilitiesDescribeResponse, Record<string, never>>(RPC_METHODS.CAPABILITIES_DESCRIBE, {});

    expect(result.capabilities.some((entry: { id: string }) => entry.id === 'cli.codex')).toBe(true);
    expect(loaderSpy).toHaveBeenCalledTimes(1);
  });

  it('clears a failed prewarm promise so later calls can recover', async () => {
    vi.resetModules();

    let allowLoader = false;
    const loaderSpy = vi.fn(async () => {
      if (!allowLoader) throw new Error('late-loader-failure');
      return {
        descriptor: {
          id: 'cli.codex',
          kind: 'cli',
          title: 'Codex CLI',
          methods: {},
        },
        detect: async () => ({ available: true }),
      };
    });

    vi.doMock('@/backends/catalog', () => ({
      AGENTS: {
        codex: {
          id: 'codex',
          getCliCapabilityOverride: loaderSpy,
        },
      },
    }));

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
  });
});
