import { expect, it } from 'vitest';
import { ApprovalRequestV2Schema, StoredApprovalRequestSchema } from './approvalRequestV1.js';
import { projectApprovalExecutionFailureV2, readApprovalExecutionFailure } from './approvalExecutionFailure.js';
import { projectApprovalRequestForPublicRead } from '../actions/actionApprovalPresentation.js';

it.each([
  { status: 'outcome_unknown', failure: { kind: 'native_effect_failed', reason: 'foreign_effect_conflict',
    stepId: 'owned-firewall', phase: 'apply' }, remedy: 'Inspect the owned firewall before another change.' },
  { status: 'recoveryRequired', recovery: { rules: { kind: 'absent' }, unit: { kind: 'absent' }, table: null,
    boot: { present: false, enabled: false, running: false } },
    restoration: { status: 'verified', recovery: { rules: { kind: 'absent' }, unit: { kind: 'absent' }, table: null,
      boot: { present: false, enabled: false, running: false } } },
    failure: { kind: 'native_effect_failed', reason: 'foreign_effect_conflict', stepId: 'owned-firewall', phase: 'apply' },
    remedy: 'Inspect the restored firewall and reconcile the saved posture.' },
  { failure: { kind: 'daemon_reachability_unavailable', reason: 'required_fact_unavailable',
    requiredFact: 'homeRoutedDaemonAck', errorCode: 'RPC_FORBIDDEN' }, remedy: 'Restore the Home route.' },
] as const)('retains the typed SSH closure cause through durable approval/public reads: $failure.kind', details => {
  const posture = { revision: 0, management: { providers: [], publicSsh: { kind: 'closed' } },
    defaultServiceIngress: { kind: 'none' } };
  const change = { kind: 'posture', posture };
  const request = ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
    createdBy: { surface: 'cli' }, requestedSurface: 'cli', actionId: 'machines.reachability.configure', summary: 'Close SSH',
    actionArgs: { serverId: 'home', machineId: 'machine', change, reviewedPlanDigest: 'a'.repeat(64),
      reviewedPlanBasis: { machineId: 'machine', installationId: 'installation', currentPostureRevision: null,
        currentSelections: [], change, occurrences: [], recipePlans: [] } },
    executionOriginV1: { v: 1, authority: 'present_user', surface: 'cli', caller: { kind: 'host' },
      serverId: 'home', accountId: 'account', machineId: 'machine', actionId: 'machines.reachability.configure', requestId: 'request' } });
  const failure = { ok: false as const, errorCode: 'outcome_unknown', error: 'outcome_unknown', effectAttempted: true, details };
  const execution = projectApprovalExecutionFailureV2({ request, failure, executedAtMs: 3 });
  expect(execution).toMatchObject({ ok: false, effectAttempted: true, details });
  const stored = StoredApprovalRequestSchema.parse({ ...request, status: 'outcome_unknown', updatedAtMs: 3,
    decision: { kind: 'approve', decidedAtMs: 2 }, execution });
  expect(readApprovalExecutionFailure(stored)).toMatchObject({ details });
  expect(projectApprovalRequestForPublicRead(stored)).toMatchObject({ execution: { details } });
  for (const unsafe of [{ ...details, token: 'private-fixture' },
    { ...details, failure: { ...details.failure, password: 'private-fixture' } }]) {
    expect(projectApprovalExecutionFailureV2({ request, failure: { ...failure, details: unsafe }, executedAtMs: 3 }))
      .not.toHaveProperty('details');
  }
});
