import { afterEach, describe, expect, it, vi } from 'vitest';

const { resolveExecutionSurfaces, resolveBackendExecutionSurfaces } = vi.hoisted(() => ({
  resolveExecutionSurfaces: vi.fn(),
  resolveBackendExecutionSurfaces: vi.fn(),
}));

vi.mock('@/agent/runtime/bridges/session/SessionHostBridge', () => ({
  getSessionHostBridge: () => ({
    resolveExecutionSurfaces,
  }),
}));

vi.mock('@/agent/runtime/registry/engineRegistry', () => ({
  resolveBackendExecutionSurfaces,
}));

import { requireTerminalRuntimeLaunch } from './requireTerminalRuntimeLaunch';

afterEach(() => {
  vi.restoreAllMocks();
  resolveExecutionSurfaces.mockReset();
  resolveBackendExecutionSurfaces.mockReset();
});

describe('terminal runtime launch requirement helper', () => {
  it('resolves launch through SessionHostBridge execution surfaces', async () => {
    const launch = vi.fn(async () => 'launched');
    resolveBackendExecutionSurfaces.mockRejectedValue(new Error('bypassed SessionHostBridge'));
    resolveExecutionSurfaces.mockResolvedValue({
      terminalRuntime: {
        launch,
      },
      externalSession: null,
      attach: null,
      handoff: null,
      fork: null,
      checkpoint: null,
    });
    const resolvedLaunch = await requireTerminalRuntimeLaunch('acme.runtime.backend');
    await expect(resolvedLaunch({})).resolves.toBe('launched');

    expect(resolveExecutionSurfaces).toHaveBeenCalledWith('acme.runtime.backend');
    expect(resolveBackendExecutionSurfaces).not.toHaveBeenCalled();
    expect(launch).toHaveBeenCalledWith({});
  });
});
