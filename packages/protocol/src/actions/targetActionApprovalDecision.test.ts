import { describe, expect, it } from 'vitest';
import { TargetActionApprovalRequestV1Schema } from '../approvals/targetActionApprovalRequestV1';
import { buildTargetActionApprovalDecisionResult, createTargetActionApprovalDecision } from './targetActionApprovalDecision';
import { getActionSpec } from './actionSpecs';
import { admitTargetActionApprovalTransition } from '../approvals/targetActionApprovalRequestTransition';
import { projectApprovalRequestForPublicRead } from './actionApprovalPresentation';

function accountApproval() {
  return TargetActionApprovalRequestV1Schema.parse({ v: 1, kind: 'plugin_target_action', status: 'open',
    createdAtMs: 1, updatedAtMs: 1, createdBy: { surface: 'agent' }, requestedSurface: 'agent',
    qualifiedActionId: 'acme.account/actions/write', input: { key: 'sample' }, secretInputPaths: [],
    approvalInputCustody: 'live_only', sourceCustody: { kind: 'development', registeredRootId: 'account-root' },
    policyFingerprint: 'a'.repeat(64), subjectFingerprint: 'b'.repeat(64), summary: 'Write Account data' });
}

describe('target Action approval decision custody', () => {
  it('retains the target executor receipt through decision settlement', async () => {
    const { approvalInputCustody: _liveOnly, ...replayable } = accountApproval();
    let stored = TargetActionApprovalRequestV1Schema.parse({ ...replayable,
      replayPlacement: { serverId: 'home', machineId: 'machine' } });
    const decide = createTargetActionApprovalDecision({
      read: async () => stored,
      update: async ({ request }) => {
        const admission = admitTargetActionApprovalTransition(stored, request);
        if (!admission.ok) return admission;
        stored = TargetActionApprovalRequestV1Schema.parse(JSON.parse(JSON.stringify(request)));
        return { ok: true };
      },
      // The external target executor reports its effect through the helper's
      // actual receipt writer; approval orchestration and transitions stay real.
      executeApproved: async ({ request, persist, nextTimestamp }) => {
        expect(request.status).toBe('approved');
        const executing = TargetActionApprovalRequestV1Schema.parse({ ...request, status: 'executing' });
        const claimFailure = await persist(executing);
        if (claimFailure) return claimFailure;
        const executed = TargetActionApprovalRequestV1Schema.parse({ ...executing, status: 'executed',
          execution: { executedAtMs: nextTimestamp(executing), ok: true, result: { written: true } } });
        return await persist(executed) ?? buildTargetActionApprovalDecisionResult(executed);
      },
    });
    expect(await decide({ artifactId: 'voice-receipt', decision: 'approve', context: {
      surface: 'voice', authority: 'present_user', runtimeAccountId: 'reviewer', actionCaller: { kind: 'host' },
    } })).toMatchObject({ ok: true, result: { status: 'executed', execution: { ok: true } } });
    expect(stored).toMatchObject({ status: 'executed', decision: { kind: 'approve', decidedVia: 'voice' },
      execution: { ok: true, result: { written: true } } });
  });

  it.each([
    { decision: 'approve', surface: 'voice' }, { decision: 'reject', surface: 'voice' },
    { decision: 'approve', surface: 'ui' }, { decision: 'reject', surface: 'ui' },
  ] as const)('retains actual attribution through contributed $surface $decision settlement and public reads', async ({ decision, surface }) => {
    let stored = JSON.stringify(accountApproval());
    const decide = createTargetActionApprovalDecision({
      read: async () => TargetActionApprovalRequestV1Schema.parse(JSON.parse(stored)),
      update: async ({ request }) => { stored = JSON.stringify(TargetActionApprovalRequestV1Schema.parse(request)); return { ok: true }; },
    });
    expect(await decide({ artifactId: 'voice-target', decision, context: {
      surface, authority: 'present_user', runtimeAccountId: 'reviewer', actionCaller: { kind: 'host' },
    } })).toMatchObject({ ok: true });
    const request = TargetActionApprovalRequestV1Schema.parse(JSON.parse(stored));
    expect(request).toMatchObject({ createdBy: { surface: 'agent' }, decision: {
      kind: decision, decidingAccountId: 'reviewer', ...(surface === 'voice' ? { decidedVia: 'voice' } : {}),
    } });
    if (surface === 'ui') expect(request.decision).not.toHaveProperty('decidedVia');
    const observed = projectApprovalRequestForPublicRead(request);
    expect(getActionSpec('approval.request.get').outputSchema.parse({ artifactId: 'voice-target', request: observed,
      queryPlan: { kind: 'approval_artifact_id_lookup', backingStore: 'ArtifactStore', boundedBy: 'approval artifact id', hydratedTranscripts: false } }))
      .toMatchObject({ request: { decision: { kind: decision, ...(surface === 'voice' ? { decidedVia: 'voice' } : {}) } } });
    expect(JSON.stringify(observed)).not.toContain('reviewer');
  });

  it('never labels a non-host Session caller as the delegated Voice agent', async () => {
    let stored = accountApproval();
    const decide = createTargetActionApprovalDecision({ read: async () => stored,
      update: async ({ request }) => { stored = TargetActionApprovalRequestV1Schema.parse(request); return { ok: true }; } });
    await decide({ artifactId: 'session-caller', decision: 'reject', context: {
      surface: 'voice', authority: 'present_user', runtimeAccountId: 'reviewer',
      actionCaller: { kind: 'session', sessionId: 'bot', starterDepth: 0, turnDepth: 0 },
    } });
    expect(stored.decision).not.toHaveProperty('decidedVia');
  });

  it.each(['approve', 'reject'] as const)('preserves revoked Voice decision authority refused by the %s write boundary', async decision => {
    const stored = accountApproval();
    const decide = createTargetActionApprovalDecision({ read: async () => stored,
      update: async () => { throw Object.assign(new Error('present_user_required'), { code: 'present_user_required' }); } });
    expect(await decide({ artifactId: 'revoked-voice', decision, context: {
      surface: 'voice', authority: 'present_user', runtimeAccountId: 'reviewer', actionCaller: { kind: 'host' },
    } })).toMatchObject({ ok: false, errorCode: 'present_user_required' });
    expect(stored.status).toBe('open');
  });

  it.each(['approve', 'reject', 'cancel'] as const)('refuses subjectless requester-only contributed %s before consent', async decision => {
    let stored = accountApproval();
    const decide = createTargetActionApprovalDecision({ read: async () => stored,
      update: async ({ request }) => { stored = request; return { ok: true }; } });
    expect(await decide({ artifactId: 'owner-only', decision, context: {
      surface: 'rpc', authority: 'present_user', runtimeAccountId: 'alice', requesterApprovalDecision: {
        sessionId: 's1', actor: { kind: 'accountUser', accountId: 'bob', relationship: 'sharedApprover' },
        isCurrent: async () => true,
      },
    } })).toMatchObject({ ok: false, errorCode: 'approval_requester_unavailable' });
    expect(stored.status).toBe('open');
  });

  it.each(['open', 'approved'] as const)('refuses retained unknown contributed %s before execution', async status => {
    let stored = TargetActionApprovalRequestV1Schema.parse({ ...accountApproval(), status,
      ...(status === 'approved' ? { decision: { kind: 'approve', decidedAtMs: 2 } } : {}),
      executionOriginV1: { v: 1, actionId: 'action.invoke', requestId: 'retained', authority: 'account_automation',
        surface: 'agent', caller: { kind: 'host' }, serverId: 'home', accountId: 'alice', machineId: 'machine',
        actionRequestAttributionV1: { requestRef: 'unknown', requester: null,
          persona: { serverId: 'home', sessionId: 's1' }, origin: null } } });
    const decide = createTargetActionApprovalDecision({ read: async () => stored,
      update: async ({ request }) => { stored = request; return { ok: true }; } });
    expect(await decide({ artifactId: 'unknown', decision: 'approve', context: {
      surface: 'ui', authority: 'present_user', runtimeAccountId: 'alice',
    } })).toMatchObject({ ok: false, errorCode: 'approval_requester_unavailable' });
    expect(stored.status).toBe(status);
  });

  it.each([false, true])('settles an unclaimed approved target Action without racing execution (claim wins: %s)', async claimWins => {
    let stored = TargetActionApprovalRequestV1Schema.parse({ ...accountApproval(), status: 'approved',
      decision: { kind: 'approve', decidedAtMs: 2 } });
    const decide = createTargetActionApprovalDecision({ read: async () => stored, hasLiveInvocation: () => false,
      update: async ({ request }) => {
        if (claimWins) stored = TargetActionApprovalRequestV1Schema.parse({ ...stored, status: 'executing' });
        const transition = admitTargetActionApprovalTransition(stored, request);
        if (!transition.ok) return transition;
        stored = TargetActionApprovalRequestV1Schema.parse(request);
        return { ok: true };
      } });
    const canceled = await decide({ artifactId: 'unclaimed', decision: 'cancel' });
    if (claimWins) {
      expect(canceled).toMatchObject({ ok: false, errorCode: 'invalid_transition' });
      expect(stored.status).toBe('executing');
      expect(stored.execution).toBeUndefined();
    } else {
      expect(canceled).toMatchObject({ ok: true, result: { status: 'failed',
        execution: { ok: false, effectAttempted: false, errorCode: 'approval_canceled' } } });
      expect(stored.decision).toEqual({ kind: 'approve', decidedAtMs: 2 });
      expect(getActionSpec('approval.request.decide').outputSchema?.safeParse(canceled?.ok ? canceled.result : null).success).toBe(true);
      expect(await decide({ artifactId: 'unclaimed', decision: 'cancel' })).toEqual(canceled);
      expect(await decide({ artifactId: 'unclaimed', decision: 'approve' })).toEqual(canceled);
    }
  });

  it('records an Account decision when the original live invocation belongs to another process', async () => {
    let stored = accountApproval();
    const decide = createTargetActionApprovalDecision({ read: async () => stored,
      update: async ({ request }) => { stored = request; return { ok: true }; } });
    expect(await decide({ artifactId: 'other-process', decision: 'approve' }))
      .toMatchObject({ ok: true, result: { status: 'approved' } });
    expect(stored).toMatchObject({ status: 'approved', decision: { kind: 'approve' } });
    expect(stored).not.toHaveProperty('execution');
  });

  it('reconciles a live execution claim observed before the decision write response', async () => {
    let stored = accountApproval();
    const decide = createTargetActionApprovalDecision({ read: async () => stored,
      update: async ({ request }) => {
        stored = request.status === 'approved' ? TargetActionApprovalRequestV1Schema.parse({ ...request, status: 'executing' }) : request;
        return { ok: true };
      } });
    const decided = await decide({ artifactId: 'already-claimed', decision: 'approve' });
    expect(decided).toMatchObject({ ok: true, result: { status: 'executing' } });
    if (!decided?.ok) throw new Error('Missing approval decision');
    expect(getActionSpec('approval.request.decide').outputSchema?.safeParse(decided.result).success).toBe(true);
    expect(stored.status).toBe('executing');
  });
});
