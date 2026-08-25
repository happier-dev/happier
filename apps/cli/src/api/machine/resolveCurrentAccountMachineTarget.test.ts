import { beforeEach, describe, expect, it, vi } from 'vitest';

const boundaries = vi.hoisted(() => ({ axiosGet: vi.fn() }));

vi.mock('axios', () => ({ default: { get: boundaries.axiosGet } }));
vi.mock('@/api/clientCompatibility/cliClientCompatibility', () => ({
  buildCurrentAccountStoredContentCompatibilityHttpHeaders: () => ({
    'X-Happier-Account-Content': 'current',
  }),
}));
vi.mock('@/api/client/serverHttpBaseUrl', () => ({
  resolveServerHttpBaseUrl: () => 'https://api.example.test',
}));

import { resolveCurrentAccountMachineTarget } from './resolveCurrentAccountMachineTarget';

function currentMachine(id: string, host?: string) {
  return {
    id,
    ...(host ? { metadata: JSON.stringify({ host }) } : {}),
    active: true,
    revokedAt: null,
    replacedByMachineId: null,
  };
}

beforeEach(() => {
  boundaries.axiosGet.mockReset();
});

describe('resolveCurrentAccountMachineTarget', () => {
  it('selects the sole current API-token bootstrap machine without metadata', async () => {
    boundaries.axiosGet.mockResolvedValue({ data: [currentMachine('machine-remote')] });

    await expect(resolveCurrentAccountMachineTarget({ token: 'token-1' })).resolves.toEqual({
      kind: 'selected',
      target: { machineId: 'machine-remote', machineLabel: 'machine-remote' },
    });
    expect(boundaries.axiosGet).toHaveBeenCalledWith(
      'https://api.example.test/v1/machines',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer token-1',
          'X-Happier-Account-Content': 'current',
        }),
      }),
    );
  });

  it('requires an explicit choice when multiple current machines exist', async () => {
    boundaries.axiosGet.mockResolvedValue({
      data: [currentMachine('machine-laptop', 'laptop'), currentMachine('machine-build', 'build-host')],
    });

    await expect(resolveCurrentAccountMachineTarget({ token: 'token-1' })).resolves.toEqual({
      kind: 'selection_required',
      candidates: [
        { machineId: 'machine-laptop', machineLabel: 'laptop' },
        { machineId: 'machine-build', machineLabel: 'build-host' },
      ],
    });
  });

  it('uses an explicit machine target without reading account inventory', async () => {
    await expect(resolveCurrentAccountMachineTarget({
      token: 'token-1',
      requestedMachineId: ' machine-explicit ',
    })).resolves.toEqual({
      kind: 'selected',
      target: { machineId: 'machine-explicit', machineLabel: 'machine-explicit' },
    });

    expect(boundaries.axiosGet).not.toHaveBeenCalled();
  });
});
