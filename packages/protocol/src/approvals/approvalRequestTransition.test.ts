import { describe, expect, it } from 'vitest';

import { ApprovalRequestV2Schema, type ApprovalRequestV2 } from './approvalRequestV1.js';
import { decideApprovalRequestTransition, settleApprovalRequestActionArgs } from './approvalRequestTransition.js';
import { PileApplyResultV1Schema } from '../storage/storageV1.js';
import { computeExternalActionRequestEnvelopeDigestV1 } from '../actions/externalActionExecutionAuthorization.js';

const target = { kind: 'window', displayId: ':73', pid: 42, windowId: 123 } as const;

describe('admitted workspace link read-back settlement', () => {
  it('allows unknown links to settle once without granting another execution claim or changing their admitted subject', () => {
    const base = openRequest();
    const existing = ApprovalRequestV2Schema.parse({ ...base, actionId: 'workspace.sync.relationship.create',
      executionOriginV1: { ...base.executionOriginV1, actionId: 'workspace.sync.relationship.create' },
      status: 'outcome_unknown', decision: { kind: 'approve', decidedAtMs: 1 },
      execution: { executedAtMs: 2, ok: false, effectAttempted: true, errorCode: 'RPC_OUTCOME_UNKNOWN' } });
    const next = ApprovalRequestV2Schema.parse({ ...existing, status: 'failed', updatedAtMs: 3,
      execution: { executedAtMs: 2, ok: false, effectAttempted: true, errorCode: 'workspace_sync_copy_absent' } });
    expect(decideApprovalRequestTransition(existing, next)).toEqual({ ok: true, changed: true });
    expect(decideApprovalRequestTransition(existing, { ...next, status: 'executed',
      execution: { executedAtMs: 2, ok: true, effectAttempted: true, result: { relationshipId: 'link' } } })).toEqual({ ok: true, changed: true });
    expect(decideApprovalRequestTransition(existing, { ...existing, status: 'executing', execution: undefined }))
      .toMatchObject({ ok: false, errorCode: 'invalid_transition' });
    expect(decideApprovalRequestTransition(existing, { ...next, actionArgs: { changed: true } }))
      .toMatchObject({ ok: false, errorCode: 'subject_mismatch' });
    expect(decideApprovalRequestTransition(next, { ...next, status: 'outcome_unknown' }))
      .toMatchObject({ ok: false, errorCode: 'invalid_transition' });
  });
});

describe('finite original envelope settlement', () => {
  it.each(['rejected', 'canceled', 'executed', 'failed'] as const)('removes the replay envelope only on %s settlement', status => {
    const actionId = 'projects.compute.exec';
    const target = { kind: 'machine' as const, machineId: 'worker' };
    const input = { workspace: { serverId: 'home', workspaceId: 'source-ref', machineId: 'source', rootPath: '/source' },
      executable: 'echo', argv: ['private-value'], cwd: '.' };
    const envelope = { v: 1 as const, requestId: 'finite-request', target, input };
    const open = ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
      createdBy: { surface: 'cli' }, requestedSurface: 'cli', actionId, actionArgs: input, summary: 'Run command',
      executionOriginV1: { v: 1, authority: 'account_automation', surface: 'cli', caller: { kind: 'host' },
        serverId: 'home-profile', serverIdentityId: 'home', accountId: 'requester', machineId: 'worker', actionId,
        requestId: envelope.requestId, target, originalActionEnvelope: envelope,
        externalActionExecutionAuthorization: { v: 1, token: 'root', binding: { accountId: 'requester',
          authentication: { kind: 'terminal', tokenEpoch: 1 }, custodianAccountId: 'owner', serverIdentityId: 'home',
          machineId: 'worker', installationId: 'worker-installation', accountEncryptionMode: 'plain', actionId,
          requestId: envelope.requestId, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), target } } } });
    const { originalActionEnvelope: _envelope, ...settledOrigin } = open.executionOriginV1;
    expect(decideApprovalRequestTransition(open, { ...open, status: 'approved', updatedAtMs: 2,
      decision: { kind: 'approve', decidedAtMs: 2 }, executionOriginV1: settledOrigin }))
      .toMatchObject({ ok: false, errorCode: 'subject_mismatch' });
    const existing = status === 'executed' || status === 'failed' ? ApprovalRequestV2Schema.parse({ ...open,
      status: 'executing', decision: { kind: 'approve', decidedAtMs: 1 } }) : open;
    const next = ApprovalRequestV2Schema.parse({ ...existing, status, updatedAtMs: 2,
      actionArgs: settleApprovalRequestActionArgs(existing), executionOriginV1: settledOrigin,
      decision: status === 'rejected' ? { kind: 'reject', decidedAtMs: 2 }
        : status === 'canceled' ? undefined : existing.decision,
      ...(status === 'executed' ? { execution: { executedAtMs: 2, ok: true, result: {} } }
        : status === 'failed' ? { execution: { executedAtMs: 2, ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' } } : {}),
    });
    expect(decideApprovalRequestTransition(existing, next)).toEqual({ ok: true, changed: true });
    expect(decideApprovalRequestTransition(existing, { ...next, executionOriginV1: existing.executionOriginV1 }))
      .toMatchObject({ ok: false, errorCode: 'subject_mismatch' });
  });
});

function openRequest(): ApprovalRequestV2 {
  return ApprovalRequestV2Schema.parse({
    v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
    createdBy: { surface: 'agent', sessionId: 'session' }, requestedSurface: 'agent',
    actionId: 'computer.target.select',
    actionArgs: { machineId: 'machine', target, access: 'use', requestedTarget: 'Editor' },
    summary: 'Choose Editor',
    executionOriginV1: {
      v: 1, authority: 'account_automation', surface: 'agent', caller: { kind: 'host' },
      serverId: 'home', sessionId: 'session', actionId: 'computer.target.select', requestId: 'request',
    },
  });
}

describe('computer selection approval transition', () => {
  it('does not widen see-only access while approving a target choice', () => {
    const existing = openRequest();
    existing.actionArgs = { machineId: 'machine', target, access: 'see', requestedTarget: 'Editor' };
    expect(decideApprovalRequestTransition(existing, {
      ...existing, status: 'approved', updatedAtMs: 2,
      decision: { kind: 'approve', decidedAtMs: 2, authority: 'present_user',
        narrowedInput: { ...existing.actionArgs as object, access: 'use' } },
    })).toMatchObject({ ok: false, errorCode: 'subject_mismatch' });
  });
  it.each([
    { target: { ...target, windowId: 456 }, access: 'use' },
    { target, access: 'see' },
  ])('admits only the human target/access edit at open -> approved: %j', selection => {
    const existing = openRequest();
    const approved: ApprovalRequestV2 = {
      ...existing, status: 'approved', updatedAtMs: 2,
      decision: { kind: 'approve', decidedAtMs: 2, authority: 'present_user',
        narrowedInput: { ...existing.actionArgs as object, ...selection } },
    };
    expect(decideApprovalRequestTransition(existing, approved)).toEqual({ ok: true, changed: true });
    expect(decideApprovalRequestTransition(existing, {
      ...approved, decision: { ...approved.decision!, authority: undefined },
    })).toMatchObject({ ok: false, errorCode: 'subject_mismatch' });
    for (const edit of [
      { machineId: 'foreign' }, { requestedTarget: 'Forged suggestion' }, { access: 'all' },
    ]) {
      expect(decideApprovalRequestTransition(existing, {
        ...approved, decision: { ...approved.decision!,
          narrowedInput: { ...approved.decision!.narrowedInput as object, ...edit } },
      })).toMatchObject({ ok: false, errorCode: 'subject_mismatch' });
    }
    expect(decideApprovalRequestTransition(approved, {
      ...approved, status: 'executing', updatedAtMs: 3,
      decision: { ...approved.decision!, narrowedInput: {
        ...approved.decision!.narrowedInput as object, target: { ...target, windowId: 789 },
      } },
    })).toMatchObject({ ok: false, errorCode: 'subject_mismatch' });
    expect(decideApprovalRequestTransition(existing, {
      ...approved, actionArgs: { ...existing.actionArgs as object, ...selection },
    })).toMatchObject({ ok: false, errorCode: 'subject_mismatch' });
  });
});

describe('settled storage proposal retry receipts', () => {
  const first = PileApplyResultV1Schema.parse({ batchId: 'first', mode: 'trash', inTrashBytes: 0,
    freedBytes: 0, trashEntryIds: [], outcomes: [{ itemId: 'item', status: 'failed', reason: { code: 'operation_failed' } }] });
  const retry = PileApplyResultV1Schema.parse({ batchId: 'retry', mode: 'trash', inTrashBytes: 4096,
    freedBytes: 0, trashEntryIds: ['retry-entry'], outcomes: [{ itemId: 'item', status: 'moved' }] });
  function executed(): ApprovalRequestV2 {
    const base = openRequest();
    const actionId = 'machines.storage.trash.move' as const;
    return ApprovalRequestV2Schema.parse({ ...base, actionId,
      actionArgs: { machineId: 'machine', items: [{ ref: { itemId: 'item', path: '/cache/item',
        identity: { dev: '1', ino: '2', kind: 'file' }, collectedAt: 1,
        collectedBy: { accountId: 'account', kind: 'agent' } }, expect: 'checked', claimedVerdict: 'safe' }] },
      executionOriginV1: { ...base.executionOriginV1, actionId }, status: 'executed', updatedAtMs: 3,
      decision: { kind: 'approve', decidedAtMs: 2 }, execution: { executedAtMs: 3, ok: true, result: first } });
  }
  it('admits an append-only strict retry result for an initially failed item without rewriting the execution', () => {
    const existing = executed();
    const next = { ...existing, updatedAtMs: 4, storageRetryResults: [retry] };
    expect(ApprovalRequestV2Schema.safeParse(next).success).toBe(true);
    expect(decideApprovalRequestTransition(existing, next)).toEqual({ ok: true, changed: true });
    expect(decideApprovalRequestTransition(next, next)).toEqual({ ok: true, changed: false });
    for (const edit of [{ actionArgs: {} }, { execution: { ...existing.execution!, result: retry } },
      { status: 'executing' as const }, { storageRetryResults: [] }]) {
      expect(decideApprovalRequestTransition(next, { ...next, ...edit }).ok).toBe(false);
    }
  });
  it('rejects malformed, unrelated, duplicate and already-successful retry correlation', () => {
    const existing = executed();
    for (const result of [
      { ...retry, batchId: first.batchId },
      { ...retry, outcomes: [{ itemId: 'foreign', status: 'moved' }] },
      { ...retry, trashEntryIds: undefined },
      { ...retry, extraAuthority: true },
    ]) {
      const next = { ...existing, updatedAtMs: 4, storageRetryResults: [result] };
      expect(ApprovalRequestV2Schema.safeParse(next).success).toBe(false);
      expect(decideApprovalRequestTransition(existing, next as ApprovalRequestV2).ok).toBe(false);
    }
    const settled = { ...existing, updatedAtMs: 4, storageRetryResults: [retry] };
    expect(decideApprovalRequestTransition(settled, { ...settled, updatedAtMs: 5,
      storageRetryResults: [retry, { ...retry, batchId: 'another', trashEntryIds: ['another-entry'] }] }).ok).toBe(false);
    expect(ApprovalRequestV2Schema.safeParse({ ...openRequest(), storageRetryResults: [retry] }).success).toBe(false);
  });
  it('retains a failed retry before admitting a later successful retry for the same item', () => {
    const existing = executed();
    const failedRetry = PileApplyResultV1Schema.parse({ ...first, batchId: 'retry-failed' });
    const failed = ApprovalRequestV2Schema.parse({ ...existing, updatedAtMs: 4, storageRetryResults: [failedRetry] });
    const succeeded = ApprovalRequestV2Schema.parse({ ...failed, updatedAtMs: 5, storageRetryResults: [failedRetry, retry] });
    expect(decideApprovalRequestTransition(existing, failed)).toEqual({ ok: true, changed: true });
    expect(decideApprovalRequestTransition(failed, succeeded)).toEqual({ ok: true, changed: true });
    expect(decideApprovalRequestTransition(failed, { ...succeeded, storageRetryResults: [retry] }).ok).toBe(false);
  });
});
