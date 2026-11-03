import { describe, expect, it } from 'vitest';

import { classifyManagedMachineAllocationV1 } from './managedMachineV1.js';

describe('managed allocation presentation', () => {
  it('distinguishes uncertain creation from an already-correlated running acquire or retry', () => {
    const machine = { allocation: 'may-exist' } as const;
    expect(classifyManagedMachineAllocationV1(machine)).toBe('may-exist');
    for (const actionId of ['machines.managed.acquire', 'machines.managed.bootstrap.retry']) {
      expect(classifyManagedMachineAllocationV1(machine, { actionId, state: 'running' })).toBe('creating');
      for (const state of ['accepted', 'failed', 'succeeded', 'cancelled'] as const) {
        expect(classifyManagedMachineAllocationV1(machine, { actionId, state })).toBe('may-exist');
      }
    }
    expect(classifyManagedMachineAllocationV1(machine, { actionId: 'machines.managed.inspect', state: 'running' })).toBe('may-exist');
  });

  it('keeps unsubmitted, bound and confirmed-absent allocation facts independent of operation progress', () => {
    for (const allocation of ['unsubmitted', 'bound', 'confirmed-absent'] as const) {
      expect(classifyManagedMachineAllocationV1({ allocation }, { actionId: 'machines.managed.acquire', state: 'running' })).toBe(allocation);
    }
  });
});
