import { describe, expect, it } from 'vitest';
import { resolveMachineSpawnReadinessV1 } from './machineSpawnReadinessV1.js';

describe('spawn readiness reads the Machine role set', () => {
  it('never offers a Machine whose sessions role is off, and keeps today for a missing setting', () => {
    const base = { selectedMachineId: 'm', machineReachable: true, rpcAvailable: true, keyAvailable: true } as const;
    expect(resolveMachineSpawnReadinessV1({ ...base, machine: { id: 'm', metadata: { rolesV1: { active: ['broker'] } } } }))
      .toEqual({ status: 'roleInactive', machineId: 'm', roleId: 'sessions' });
    expect(resolveMachineSpawnReadinessV1({ ...base, machineReachable: false, machine: { id: 'm', metadata: { rolesV1: { active: [] } } } }))
      .toEqual({ status: 'roleInactive', machineId: 'm', roleId: 'sessions' });
    expect(resolveMachineSpawnReadinessV1({ ...base, machine: { id: 'm', metadata: { host: 'x' } } })).toEqual({ status: 'ready', machineId: 'm' });
    expect(resolveMachineSpawnReadinessV1({ ...base, machine: { id: 'm' } })).toEqual({ status: 'ready', machineId: 'm' });
  });
});
