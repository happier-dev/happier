import { describe, expect, it } from 'vitest';

import { buildActionExecuteResultFromRecordedApprovalExecution } from './approvalResults.js';
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
