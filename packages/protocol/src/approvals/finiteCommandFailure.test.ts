import { expect, it } from 'vitest';
import { ApprovalRequestV2Schema, StoredApprovalRequestSchema } from './approvalRequestV1.js';
import { projectApprovalExecutionFailureV2, readApprovalExecutionFailure } from './approvalExecutionFailure.js';

it('retains closed finite command diagnostics across approval storage and rejects private payloads', () => {
  const request = ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
    createdBy: { surface: 'cli' }, requestedSurface: 'cli', actionId: 'machines.setup.apply', summary: 'Apply setup',
    actionArgs: { homeId: 'home', machineId: 'machine', targets: [{ homeId: 'home', machineId: 'machine',
      desiredRevision: 0, recipePlans: [], sources: [{ kind: 'direct', setup: {} }] }] },
    executionOriginV1: { v: 1, authority: 'present_user', surface: 'cli', caller: { kind: 'host' },
      serverId: 'home', accountId: 'account', machineId: 'machine', actionId: 'machines.setup.apply', requestId: 'request' } });
  const details = { kind: 'finiteCommand', phase: 'setup', step: 1, exitCode: 23, signal: 0 };
  const failure = { ok: false as const, errorCode: 'machine_setup_setup_failed', error: 'machine_setup_setup_failed', details };
  const execution = projectApprovalExecutionFailureV2({ request, failure, executedAtMs: 3 });
  expect(execution).toMatchObject({ details });
  const stored = StoredApprovalRequestSchema.parse({ ...request, status: 'failed', updatedAtMs: 3,
    decision: { kind: 'approve', decidedAtMs: 2 }, execution });
  expect(readApprovalExecutionFailure(stored)).toMatchObject({ details });
  for (const extra of [{ body: 'PRIVATE_COMMAND' }, { env: { TOKEN: 'PRIVATE_ENV' } }, { stdout: 'PRIVATE_OUTPUT' }]) {
    expect(projectApprovalExecutionFailureV2({ request, failure: { ...failure, details: { ...details, ...extra } }, executedAtMs: 3 }))
      .not.toHaveProperty('details');
  }
});
