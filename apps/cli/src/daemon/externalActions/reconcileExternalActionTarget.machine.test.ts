import { expect, it } from 'vitest';
import { resolveExternalActionMachineTarget } from './reconcileExternalActionTarget';

const input = {
  actionId: 'sessions.external.candidates.list' as const,
  rawInput: { machineId: 'addressed-machine', agentId: 'claude', source: { kind: 'claudeConfig', configDir: '/repo' } },
  fallbackMachineId: 'unrelated-local-machine',
};

it('selects the parsed Machine rather than the ambient local Machine and refuses a conflicting envelope', () => {
  expect(resolveExternalActionMachineTarget(input)).toEqual({ kind: 'ready', machineId: 'addressed-machine' });
  expect(resolveExternalActionMachineTarget({ ...input, target: { kind: 'machine', machineId: 'other' } }))
    .toMatchObject({ kind: 'rejected', execution: { errorCode: 'target_not_local' } });
  expect(resolveExternalActionMachineTarget({ ...input, ownerMachineId: 'other' }))
    .toMatchObject({ kind: 'rejected', execution: { errorCode: 'target_not_local' } });
});

it('uses authenticated linked Session ownership for operation placement and refuses a different explicit Machine', () => {
  const operation = { actionId: 'sessions.external.operation.status.get' as const,
    rawInput: { sessionId: 'session-1', operationId: 'operation-1', revision: 1 },
    ownerMachineId: 'owning-machine', fallbackMachineId: 'unrelated-local-machine' };
  expect(resolveExternalActionMachineTarget(operation)).toEqual({ kind: 'ready', machineId: 'owning-machine' });
  expect(resolveExternalActionMachineTarget({ ...operation, target: { kind: 'machine', machineId: 'other' } }))
    .toMatchObject({ kind: 'rejected', execution: { errorCode: 'target_not_local' } });
});
