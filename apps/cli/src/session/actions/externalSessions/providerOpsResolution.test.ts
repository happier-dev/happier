import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ExternalSessionExecutionSurface } from '@/session/external/providerOps';

const resolveExecutionSurfacesMock = vi.fn();

vi.mock('@/agent/runtime/bridges/session/SessionHostBridge', () => ({
  getSessionHostBridge: () => ({
    resolveExecutionSurfaces: (...args: unknown[]) => resolveExecutionSurfacesMock(...args),
  }),
}));

describe('resolveExternalSessionSurfaceOps', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves external-session action ops through SessionHostBridge', async () => {
    const externalSessionOps: ExternalSessionExecutionSurface = {};
    resolveExecutionSurfacesMock.mockResolvedValue({
      externalSession: externalSessionOps,
    });

    const { resolveExternalSessionSurfaceOps } = await import('./providerOpsResolution');
    await expect(resolveExternalSessionSurfaceOps('opencode')).resolves.toBe(externalSessionOps);
    expect(resolveExecutionSurfacesMock).toHaveBeenCalledWith('opencode');
  });

  it('fails closed when the bridge has no external-session surface', async () => {
    resolveExecutionSurfacesMock.mockResolvedValue({
      externalSession: null,
    });

    const { resolveExternalSessionSurfaceOps } = await import('./providerOpsResolution');
    await expect(resolveExternalSessionSurfaceOps('opencode')).rejects.toThrow(/missing direct-session provider ops/i);
  });
});
