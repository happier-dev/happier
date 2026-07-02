import { describe, expect, it, vi } from 'vitest';

import type {
  CliEngineAdapter,
  CliRuntimeCore,
} from '@/agent/runtime/registry/engineRegistryTypes';

const { loadBuiltInRuntimeOwnersMock } = vi.hoisted(() => ({
  loadBuiltInRuntimeOwnersMock: vi.fn(),
}));

vi.mock('./runtimeOwners', () => ({
  loadBuiltInRuntimeOwners: loadBuiltInRuntimeOwnersMock,
}));

import { createBuiltInEntry } from './entry';

function readBoundRuntimeCore(value: CliEngineAdapter | null | undefined): CliRuntimeCore | null | undefined {
  return value?.runtimeCore;
}

describe('createBuiltInEntry', () => {
  it('resolves host runtimeCore through the built-in runtime owner', async () => {
    const createRuntime = vi.fn(() => ({ kind: 'kiro-backend' }));
    const createHostSessionRuntimePlan = vi.fn(async (sessionParams: unknown) => ({
      kind: 'hostSessionRuntimePlan' as const,
      providerId: 'kiro',
      opts: sessionParams as never,
      config: {
        createSessionRuntime: vi.fn(),
      } as never,
    }));
    loadBuiltInRuntimeOwnersMock.mockResolvedValue({
      createRuntime,
      createHostSessionRuntimePlan,
    });

    const entry = createBuiltInEntry('kiro');
    const bindingFactory = await entry.getRuntimeCore?.();
    expect(bindingFactory).toBeTypeOf('function');

    const runtimeCore = readBoundRuntimeCore(await bindingFactory?.({
      backend: {
        id: 'kiro',
        providerId: 'kiro',
        provenance: 'first_party',
        source: { kind: 'bundled' },
        definition: { kindVersion: 1, id: 'kiro', providerId: 'kiro' },
      },
      provider: {
        id: 'kiro',
        provenance: 'first_party',
        source: { kind: 'bundled' },
        definition: { kindVersion: 1, id: 'kiro', ownedBackendIds: ['kiro'] },
      },
      executionSurfaces: {
        terminalRuntime: null,
        externalSession: null,
        attach: null,
        handoff: null,
        fork: null,
        checkpoint: null,
      },
    }));

    const sessionParams = {
      credentials: { token: 'token' },
      marker: 'kiro',
    };
    await expect(runtimeCore?.createSessionRuntime(sessionParams)).resolves.toEqual(expect.objectContaining({
      kind: 'hostSessionRuntimePlan',
      providerId: 'kiro',
      opts: sessionParams,
    }));
    expect(loadBuiltInRuntimeOwnersMock).toHaveBeenCalledWith('kiro');
    expect(createHostSessionRuntimePlan).toHaveBeenCalledWith(sessionParams);
  });

  it('forwards the typed runtime-adapter and host-bridge hooks that built-in ACP entries may need', async () => {
    const providerAttachOps = {
      evaluateAvailability: vi.fn(),
      attach: vi.fn(),
    };
    const sessionHandoffProviderOps = {
      exportBundle: vi.fn(),
      importBundle: vi.fn(),
    };
    const normalizeSessionControlPermissionMode = vi.fn((permissionMode: string) => `${permissionMode}:normalized`);
    const preflightSessionControlsProbeAdapter = {
      probeModelsRaw: vi.fn(),
    };

    const entry = createBuiltInEntry('kiro', {
      getProviderAttachOps: async () => providerAttachOps,
      getHandoffSurface: async () => sessionHandoffProviderOps,
      normalizeSessionControlPermissionMode,
      getPreflightSessionControlsProbeAdapter: async () => preflightSessionControlsProbeAdapter,
    });

    await expect(entry.getProviderAttachOps?.()).resolves.toBe(providerAttachOps);
    await expect(entry.getHandoffSurface?.()).resolves.toBe(sessionHandoffProviderOps);
    expect(entry.normalizeSessionControlPermissionMode?.('safe-yolo')).toBe('safe-yolo:normalized');
    await expect(entry.getPreflightSessionControlsProbeAdapter?.()).resolves.toBe(preflightSessionControlsProbeAdapter);
  });

  it('rejects compatibility-only customAcp from the generic built-in ACP entry helper', () => {
    expect(() => createBuiltInEntry('customAcp')).toThrow(
      "Agent 'customAcp' is not registered as a built-in generic ACP agent",
    );
  });

});
