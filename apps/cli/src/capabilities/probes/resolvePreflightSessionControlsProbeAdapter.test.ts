import { describe, expect, it, vi } from 'vitest';

const { getPreflightSessionControlsProbeAdapterMock } = vi.hoisted(() => ({
  getPreflightSessionControlsProbeAdapterMock: vi.fn(),
}));

vi.mock('@/agent/catalog/registry', () => ({
  AGENTS: {
    claude: {
      getPreflightSessionControlsProbeAdapter: getPreflightSessionControlsProbeAdapterMock,
    },
    opencode: {},
  },
}));

import { resolvePreflightSessionControlsProbeAdapter } from './resolvePreflightSessionControlsProbeAdapter';

describe('resolvePreflightSessionControlsProbeAdapter', () => {
  it('resolves the catalog preflight adapter when the backend exposes one', async () => {
    const adapter = { failureCacheStrategy: 'retry' as const };
    getPreflightSessionControlsProbeAdapterMock.mockResolvedValueOnce(adapter);

    await expect(resolvePreflightSessionControlsProbeAdapter('claude')).resolves.toBe(adapter);
    expect(getPreflightSessionControlsProbeAdapterMock).toHaveBeenCalledTimes(1);
  });

  it('returns null when the backend has no preflight adapter', async () => {
    await expect(resolvePreflightSessionControlsProbeAdapter('opencode')).resolves.toBeNull();
  });
});
