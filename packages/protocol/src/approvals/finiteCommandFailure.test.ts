import { expect, it } from 'vitest';
import { ApprovalRequestV2Schema, StoredApprovalRequestSchema } from './approvalRequestV1.js';
import { projectApprovalExecutionFailureV2, readApprovalExecutionFailure } from './approvalExecutionFailure.js';
import { projectApprovalRequestForPublicRead } from '../actions/actionApprovalPresentation.js';
import { ApprovalRequestPublicReadSchema } from './approvalRequestPublicRead.js';
import { buildActionExecuteResultFromRecordedApprovalExecution } from '../actions/executor/approvalResults.js';

it.each(['command_failed', 'command_cancelled'])('retains authorized shell output across approval storage and public reads (%s)', errorCode => {
  // Same raw command-failure shape observed in QA-LIVE's exit-7 CLI approval.
  const request = ApprovalRequestV2Schema.parse({ v: 2, status: 'executing', createdAtMs: 1, updatedAtMs: 2,
    createdBy: { surface: 'cli' }, requestedSurface: 'cli', actionId: 'machines.command.run', summary: 'Run command',
    actionArgs: { command: 'cat >&2; exit 7', stdin: { actionId: 'notifications.notify_me', phase: 'before' } },
    executionOriginV1: { v: 1, authority: 'account_automation', surface: 'cli', caller: { kind: 'host' },
      serverId: 'home', accountId: 'account', machineId: 'machine', actionId: 'machines.command.run', requestId: 'request' },
    decision: { kind: 'approve', decidedAtMs: 2, authority: 'present_user' } });
  const details = { exitCode: 7, stdout: 'PRIVATE_STDOUT', stderr: 'PRIVATE_STDERR', stderrTruncated: true };
  const failure = { ok: false as const, errorCode, error: 'Command failed', details };
  const execution = projectApprovalExecutionFailureV2({ request, failure, executedAtMs: 3 });
  expect(execution).toMatchObject({ details });
  const stored = StoredApprovalRequestSchema.parse({ ...request, status: 'failed', updatedAtMs: 3, execution });
  const publicRead = ApprovalRequestPublicReadSchema.parse(projectApprovalRequestForPublicRead(stored));
  expect(publicRead.execution).toMatchObject({ details });
  expect(readApprovalExecutionFailure(publicRead)).toMatchObject(failure);
  expect(buildActionExecuteResultFromRecordedApprovalExecution(publicRead)).toMatchObject(failure);
  // Output custody admits the closed command result, never unrelated private bags.
  expect(projectApprovalExecutionFailureV2({ request, failure: { ...failure,
    details: { ...details, env: { TOKEN: 'PRIVATE_ENV' } } }, executedAtMs: 3 })).not.toHaveProperty('details');
  expect(projectApprovalExecutionFailureV2({ request, failure: { ...failure, errorCode: 'action_failed' }, executedAtMs: 3 }))
    .not.toHaveProperty('details');
  expect(projectApprovalExecutionFailureV2({ request: { ...request, actionId: 'settings.get', actionArgs: {} },
    failure, executedAtMs: 3 })).not.toHaveProperty('details');
});

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
