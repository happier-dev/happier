import { describe, expect, it, vi } from 'vitest';

import { createCatalogDefinedAcpEntry } from './createCatalogDefinedAcpEntry';

describe('createCatalogDefinedAcpEntry', () => {
  it('forwards the typed runtime-adapter and host-bridge hooks that built-in ACP entries may need', async () => {
    const providerAttachOps = {
      evaluateEligibility: vi.fn(),
      runAttach: vi.fn(),
    };
    const sessionHandoffProviderOps = {
      exportBundle: vi.fn(),
      importBundle: vi.fn(),
    };
    const normalizeSessionControlPermissionMode = vi.fn((permissionMode: string) => `${permissionMode}:normalized`);
    const preflightSessionControlsProbeAdapter = {
      probeModelsRaw: vi.fn(),
    };

    const entry = createCatalogDefinedAcpEntry('customAcp', {
      getProviderAttachOps: async () => providerAttachOps,
      getSessionHandoffProviderOps: async () => sessionHandoffProviderOps,
      normalizeSessionControlPermissionMode,
      getPreflightSessionControlsProbeAdapter: async () => preflightSessionControlsProbeAdapter,
    });

    await expect(entry.getProviderAttachOps?.()).resolves.toBe(providerAttachOps);
    await expect(entry.getSessionHandoffProviderOps?.()).resolves.toBe(sessionHandoffProviderOps);
    expect(entry.normalizeSessionControlPermissionMode?.('safe-yolo')).toBe('safe-yolo:normalized');
    await expect(entry.getPreflightSessionControlsProbeAdapter?.()).resolves.toBe(preflightSessionControlsProbeAdapter);
  });
});
