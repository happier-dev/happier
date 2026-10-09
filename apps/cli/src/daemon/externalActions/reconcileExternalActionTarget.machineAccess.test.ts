import { describe, expect, it } from 'vitest';
import { reconcileExternalActionTarget, resolveExternalActionMachineTarget } from './reconcileExternalActionTarget';

describe('Machine key preparation resource and execution placement', () => {
  it('keeps the qualified resource distinct from the exact answering key holder', () => {
    const input = { serverId: 'home', machineId: 'alice-resource' };
    const target = { kind: 'machine', machineId: 'bob-holder' } as const;
    expect(resolveExternalActionMachineTarget({ actionId: 'machines.access.prepareKeys', rawInput: input,
      target, fallbackMachineId: 'bob-holder' })).toEqual({ kind: 'ready', machineId: 'bob-holder' });
    expect(reconcileExternalActionTarget({ actionId: 'machines.access.prepareKeys', rawInput: input,
      target, currentMachineId: 'bob-holder' })).toMatchObject({ kind: 'ready', target });
    // Resource-only input is not a request to execute on Alice's machine.
    expect(resolveExternalActionMachineTarget({ actionId: 'machines.access.prepareKeys', rawInput: input }))
      .toMatchObject({ kind: 'rejected', execution: { errorCode: 'target_required' } });
  });

  it('retains ordinary Machine operation locality rather than waiving every machineId', () => {
    expect(reconcileExternalActionTarget({ actionId: 'machines.terminal.list',
      rawInput: { serverId: 'home', machineId: 'alice-resource' },
      target: { kind: 'machine', machineId: 'bob-holder' }, currentMachineId: 'bob-holder' }))
      .toMatchObject({ kind: 'rejected', execution: { errorCode: 'target_not_local' } });
  });
});
