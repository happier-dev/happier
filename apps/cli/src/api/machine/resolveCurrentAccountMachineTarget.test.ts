import { beforeEach, describe, expect, it, vi } from 'vitest';

const boundaries = vi.hoisted(() => ({ axiosGet: vi.fn() }));

vi.mock('axios', () => ({ default: { get: boundaries.axiosGet } }));
vi.mock('@/api/clientCompatibility/cliClientCompatibility', () => ({
  buildCurrentAccountStoredContentCompatibilityHttpHeaders: () => ({
    'X-Happier-Account-Content': 'current',
  }),
}));
vi.mock('@/api/client/serverHttpBaseUrl', () => ({
  normalizeServerHttpBaseUrl: (serverUrl: string) => serverUrl.replace(/\/+$/, ''),
  resolveServerHttpBaseUrl: () => 'https://api.example.test',
}));

import { listCurrentAccountMachines, resolveCurrentAccountMachineTarget } from './resolveCurrentAccountMachineTarget';

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
  it('preserves accessible Machine readiness and never auto-selects a pending shared target', async () => {
    const access = { custodian: { accountId: 'alice', displayName: 'Alice' }, role: 'use', resourceMode: 'e2ee', accessState: 'key_pending' };
    boundaries.axiosGet.mockResolvedValue({ data: [{ ...currentMachine('shared'), access }] });
    expect(await listCurrentAccountMachines({ token: 'token' })).toEqual([
      { id: 'shared', label: 'shared', kind: 'persistent', active: true, revokedAt: null, replacedByMachineId: null, access },
    ]);
    expect(await resolveCurrentAccountMachineTarget({ token: 'token' })).toMatchObject({ kind: 'unavailable', code: 'no_current_machine' });
    boundaries.axiosGet.mockResolvedValue({ data: [{ ...currentMachine('shared'), access: { ...access, accessState: 'ready' } }] });
    expect(await resolveCurrentAccountMachineTarget({ token: 'token' })).toMatchObject({ kind: 'selected', target: { machineId: 'shared' } });
  });

  it('projects the complete signed Account inventory without hiding revoked machines', async () => {
    boundaries.axiosGet.mockResolvedValue({ data: [
      currentMachine('machine-current', 'desk'),
      { ...currentMachine('machine-old', 'old-desk'), active: false, revokedAt: 7, replacedByMachineId: 'machine-current' },
    ] });
    await expect(listCurrentAccountMachines({ token: 'token-1' })).resolves.toEqual([
      { id: 'machine-current', label: 'desk', kind: 'persistent', active: true, revokedAt: null, replacedByMachineId: null },
      { id: 'machine-old', label: 'old-desk', kind: 'persistent', active: false, revokedAt: 7, replacedByMachineId: 'machine-current' },
    ]);
  });

  it('never selects a Temporary computer as the automatic current-daemon target', async () => {
    boundaries.axiosGet.mockResolvedValue({ data: [
      currentMachine('machine-desk', 'desk'),
      { ...currentMachine('runner-1'), kind: 'ephemeral_session_runner' },
    ] });

    // Two rows are current, but only the persistent one is an automatic target.
    await expect(resolveCurrentAccountMachineTarget({ token: 'token-1' })).resolves.toEqual({
      kind: 'selected',
      target: { machineId: 'machine-desk', machineLabel: 'desk' },
    });
  });

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

  it('reads a fixed Action executor inventory from its qualified Home endpoint', async () => {
    boundaries.axiosGet.mockResolvedValue({ data: [currentMachine('machine-fixed')] });

    await expect(resolveCurrentAccountMachineTarget({
      token: 'token-fixed',
      serverHttpBaseUrl: 'https://fixed-home.example.test',
    })).resolves.toMatchObject({
      kind: 'selected',
      target: { machineId: 'machine-fixed' },
    });
    expect(boundaries.axiosGet).toHaveBeenCalledWith(
      'https://fixed-home.example.test/v1/machines',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer token-fixed' }),
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

  it('parses inventory rows through the Protocol external Action bootstrap schema, not a local grammar', async () => {
    // A Protocol-invalid id must fail the inventory closed instead of being
    // silently trimmed into a different machine identity.
    boundaries.axiosGet.mockResolvedValue({ data: [{ ...currentMachine('machine-1'), id: ' machine-1 ' }] });
    await expect(listCurrentAccountMachines({ token: 'token-1' }))
      .rejects.toMatchObject({ code: 'machine_inventory_unavailable' });

    // Absolute revocation timestamps are integer wall-clock milliseconds.
    boundaries.axiosGet.mockResolvedValue({ data: [{ ...currentMachine('machine-1'), revokedAt: 1.5 }] });
    await expect(listCurrentAccountMachines({ token: 'token-1' }))
      .rejects.toMatchObject({ code: 'machine_inventory_unavailable' });
  });
});
