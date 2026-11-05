import { ApprovalRequestV2Schema } from '../../approvals/approvalRequestV1.js';
import type { ActionExecuteResult } from './types.js';
import { describe, expect, it } from 'vitest';

import { buildActionExecuteResultFromRecordedApprovalExecution, projectSettledApprovalExecution } from './approvalResults.js';
import { ApprovalRequestPublicReadSchema } from '../../approvals/approvalRequestPublicRead.js';

describe('recorded target Action results', () => {
  it.each([true, false])('retains credential-use evidence from a public target receipt (ok: %s)', ok => {
    const operationCredentialUses = [{ v: 1, kind: 'connected_account', label: 'Personal GitHub',
      owner: { kind: 'account', accountId: 'alice' }, service: { pluginId: 'example.service', localId: 'github' },
      why: { kind: 'purpose_binding', purpose: { consumer: { pluginId: 'example.worker', localId: 'publish' },
        purpose: 'repository-write' }, target: 'account' }, currentness: { kind: 'current_at_materialization' } }];
    const outcome = ok ? { ok: true, result: { published: true } }
      : { ok: false, errorCode: 'publish_failed', error: 'publish_failed' };
    const request = ApprovalRequestPublicReadSchema.parse({ v: 1, kind: 'plugin_target_action',
      qualifiedActionId: 'example.worker/actions/publish', input: {}, status: ok ? 'executed' : 'failed',
      createdAtMs: 1, updatedAtMs: 2, createdBy: { surface: 'cli' }, requestedSurface: 'cli',
      sourceCustody: { kind: 'development', registeredRootId: 'fixture-root' },
      policyFingerprint: 'a'.repeat(64), subjectFingerprint: 'b'.repeat(64), summary: 'Publish',
      decision: { kind: 'approve', decidedAtMs: 2 },
      execution: { ...outcome, executedAtMs: 2, effectAttempted: true, operationCredentialUses } });
    expect(buildActionExecuteResultFromRecordedApprovalExecution(request))
      .toEqual({ ...outcome, operationCredentialUses });
  });
});


describe('settled approval effect evidence', () => {
  it.each([
    { exec: { ok: true, result: { ok: false, error: 'source_unavailable', effectAttempted: false } }, status: 'failed', attempted: false },
    { exec: { ok: true, result: { ok: false, error: 'source_conflict' } }, status: 'failed', attempted: true },
    { exec: { ok: true, result: { ok: true, sourceId: 'source', revision: 2 } }, status: 'executed', attempted: true },
    { exec: { ok: false, errorCode: 'source_unavailable', error: 'source_unavailable', effectAttempted: true }, status: 'failed', attempted: true },
    { exec: { ok: false, errorCode: 'outcome_unknown', error: 'outcome_unknown' }, status: 'outcome_unknown', attempted: true },
    { actionId: 'settings.get', exec: { ok: true, result: { ok: false, error: 'opaque-setting-value' } }, status: 'executed', attempted: true },
  ] satisfies ReadonlyArray<{ actionId?: 'settings.get'; exec: ActionExecuteResult; status: string; attempted: boolean }>)
  ('retains $status with effectAttempted=$attempted', ({ exec, status, attempted, ...testCase }) => {
    const actionId = ('actionId' in testCase ? testCase.actionId : undefined) ?? 'projects.sources.delete';
    const request = ApprovalRequestV2Schema.parse({ v: 2, status: 'executing', createdAtMs: 1, updatedAtMs: 2,
      createdBy: { surface: 'system' }, requestedSurface: 'ui', actionId,
      actionArgs: actionId === 'settings.get' ? {} : { serverId: 'home', sourceId: 'source', expectedRevision: 1 }, summary: 'Review action',
      executionOriginV1: { v: 1, authority: 'present_user', surface: 'ui', caller: { kind: 'host' },
        serverId: 'home', accountId: 'owner', actionId, requestId: 'delete' },
      decision: { kind: 'approve', decidedAtMs: 2 } });
    const settled = projectSettledApprovalExecution({ request, actionId, exec, dispatchEffectAttempted: true, executedAtMs: 3 });
    expect(settled.request).toMatchObject({ status, execution: { ok: status === 'executed', effectAttempted: attempted } });
    expect(settled.exec.ok).toBe(status === 'executed');
  });
});
