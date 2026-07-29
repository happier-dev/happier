import { describe, expect, it } from 'vitest';

import { resolveExplicitSessionSpawnMachineTarget } from './sessionSpawnMachineTarget.js';

describe('resolveExplicitSessionSpawnMachineTarget', () => {
  it('keeps machineId authoritative and accepts a canonically equivalent host assertion', () => {
    expect(resolveExplicitSessionSpawnMachineTarget({
      machineId: 'machine-target',
      host: 'TARGET-MAC.local',
      machines: [
        { machineId: 'machine-fallback', host: 'fallback-mac' },
        { machineId: 'machine-target', host: 'target-mac' },
      ],
    })).toEqual({
      kind: 'resolved',
      machineId: 'machine-target',
    });
  });

  it.each([
    {
      name: 'the exact machine is unknown',
      input: {
        machineId: 'machine-missing',
        machines: [{ machineId: 'machine-fallback', host: 'fallback-mac' }],
      },
    },
    {
      name: 'the host assertion identifies another machine',
      input: {
        machineId: 'machine-target',
        host: 'fallback-mac',
        machines: [
          { machineId: 'machine-fallback', host: 'fallback-mac' },
          { machineId: 'machine-target', host: 'target-mac' },
        ],
      },
    },
  ])('fails closed with invalid_parameters when $name', ({ input }) => {
    expect(resolveExplicitSessionSpawnMachineTarget(input)).toEqual({
      kind: 'invalid',
      errorCode: 'invalid_parameters',
    });
  });

  it('leaves host-only and implicit selection to the surface adapter', () => {
    expect(resolveExplicitSessionSpawnMachineTarget({
      host: 'target-mac',
      machines: [{ machineId: 'machine-target', host: 'target-mac' }],
    })).toEqual({ kind: 'not_explicit' });
  });
});
