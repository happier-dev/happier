import { describe, expect, it } from 'vitest';
import { TargetActionApprovalRequestV1Schema } from '../approvals/targetActionApprovalRequestV1';
import { buildTargetActionApprovalDecisionResult, createTargetActionApprovalDecision } from './targetActionApprovalDecision';
import { getActionSpec } from './actionSpecs';
import { admitTargetActionApprovalTransition } from '../approvals/targetActionApprovalRequestTransition';
import { projectApprovalRequestForPublicRead } from './actionApprovalPresentation';
import { API_TOKEN_FULL_GRANT_V1, ApiTokenGrantV1Schema } from '../auth/apiTokenGrant';
import { getSharedBlockingApprovalCoordinator } from './blockingApprovalCoordinator';

function accountApproval() {
  return TargetActionApprovalRequestV1Schema.parse({ v: 1, kind: 'plugin_target_action', status: 'open',
    createdAtMs: 1, updatedAtMs: 1, createdBy: { surface: 'agent' }, requestedSurface: 'agent',
    qualifiedActionId: 'acme.account/actions/write', input: { key: 'sample' }, secretInputPaths: [],
    approvalInputCustody: 'live_only', sourceCustody: { kind: 'development', registeredRootId: 'account-root' },
    policyFingerprint: 'a'.repeat(64), subjectFingerprint: 'b'.repeat(64), summary: 'Write Account data' });
}

describe('target Action approval decision custody', () => {
  it('executes captured daemon placement independently of the requesting surface', async () => {
    const { approvalInputCustody: _liveOnly, ...replayable } = accountApproval();
    let stored = TargetActionApprovalRequestV1Schema.parse({ ...replayable, requestedSurface: 'ui',
      replayPlacement: { serverId: 'home', machineId: 'machine', defaultSessionId: 'session' } });
    let effects = 0;
    const decide = createTargetActionApprovalDecision({
      read: async () => stored,
      update: async ({ request }) => {
        const transition = admitTargetActionApprovalTransition(stored, request);
        if (transition.ok) stored = TargetActionApprovalRequestV1Schema.parse(request);
        return transition;
      },
      // The target execution host is a boundary; the decision and claim
      // transitions remain real beneath its effect/receipt response.
      executeApproved: async ({ request, persist, nextTimestamp }) => {
        const executing = TargetActionApprovalRequestV1Schema.parse({ ...request, status: 'executing' });
        const claimFailure = await persist(executing);
        if (claimFailure) return claimFailure;
        effects += 1;
        const executed = TargetActionApprovalRequestV1Schema.parse({ ...executing, status: 'executed',
          execution: { executedAtMs: nextTimestamp(executing), ok: true, result: { written: true } } });
        return await persist(executed) ?? buildTargetActionApprovalDecisionResult(executed);
      },
    });
    const args = { artifactId: 'captured-placement', decision: 'approve' as const,
      context: { surface: 'ui' as const, authority: 'present_user' as const, runtimeAccountId: 'alice' },
      callerGrant: ApiTokenGrantV1Schema.parse({ ...API_TOKEN_FULL_GRANT_V1, approve: true,
        targets: { sessions: ['session'], machines: [] } }) };
    expect(await decide({ ...args, callerGrant: { ...args.callerGrant,
      targets: { sessions: ['other-session'], machines: [] } } }))
      .toMatchObject({ ok: false, errorCode: 'credential_scope_denied' });
    expect(stored.status).toBe('open');
    expect(effects).toBe(0);
    expect(await decide(args)).toMatchObject({ ok: true, result: { status: 'executed' } });
    expect(stored).toMatchObject({ status: 'executed', decision: { kind: 'approve', decidingAccountId: 'alice' } });
    expect(await decide(args)).toMatchObject({ ok: true, result: { status: 'executed' } });
    expect(effects).toBe(1);
  });

  it.each(['approve', 'reject', 'cancel'] as const)('refuses %s on an unknown outcome without changing or re-executing it', async decision => {
    const stored = TargetActionApprovalRequestV1Schema.parse({ ...accountApproval(), status: 'outcome_unknown',
      decision: { kind: 'approve', decidedAtMs: 2 }, execution: { executedAtMs: 3, ok: false,
        effectAttempted: true, errorCode: 'approval_execution_outcome_unknown', error: 'approval_execution_outcome_unknown' } });
    const decide = createTargetActionApprovalDecision({ read: async () => stored,
      update: async () => { throw new Error('A settled approval must not be written'); },
      executeApproved: async () => { throw new Error('An unknown effect must never execute again'); } });
    expect(await decide({ artifactId: 'unknown-effect', decision }))
      .toMatchObject({ ok: false, errorCode: 'approval_execution_outcome_unknown' });
    expect(stored.status).toBe('outcome_unknown');
  });

  it('requires a separate open approval and fresh person decision for another request', async () => {
    const previous = TargetActionApprovalRequestV1Schema.parse({ ...accountApproval(), status: 'outcome_unknown',
      decision: { kind: 'approve', decidedAtMs: 2 }, execution: { executedAtMs: 3, ok: false,
        effectAttempted: true, errorCode: 'approval_execution_outcome_unknown', error: 'approval_execution_outcome_unknown' } });
    const records = new Map([['previous', previous], ['new-request', accountApproval()]]);
    const decide = createTargetActionApprovalDecision({ read: async id => records.get(id) ?? null,
      update: async ({ artifactId, request }) => {
        const existing = records.get(artifactId);
        if (!existing) throw new Error('Missing request');
        const admission = admitTargetActionApprovalTransition(existing, request);
        if (admission.ok) records.set(artifactId, TargetActionApprovalRequestV1Schema.parse(request));
        return admission;
      } });
    expect(records.get('new-request')?.decision).toBeUndefined();
    expect(await decide({ artifactId: 'previous', decision: 'approve' }))
      .toMatchObject({ ok: false, errorCode: 'approval_execution_outcome_unknown' });
    const live = getSharedBlockingApprovalCoordinator().waitForDecision({ artifactId: 'new-request', request: records.get('new-request')! });
    expect(await decide({ artifactId: 'new-request', decision: 'approve', context: {
      authority: 'present_user', surface: 'ui', runtimeAccountId: 'alice',
    } })).toMatchObject({ ok: true, result: { status: 'approved' } });
    await live;
    expect(records.get('new-request')?.decision).toMatchObject({ kind: 'approve', authority: 'present_user', decidingAccountId: 'alice' });
    expect(records.get('previous')).toEqual(previous);
  });

  it.each(['open', 'approved'] as const)('settles lost live input custody from %s with a terminal refusal', async status => {
    let stored = TargetActionApprovalRequestV1Schema.parse({ ...accountApproval(), status,
      ...(status === 'approved' ? { decision: { kind: 'approve', decidedAtMs: 2 } } : {}) });
    let effects = 0;
    const decide = createTargetActionApprovalDecision({ read: async () => stored, hasLiveInvocation: () => false,
      update: async ({ request }) => {
        const admission = admitTargetActionApprovalTransition(stored, request);
        if (!admission.ok) return admission;
        stored = TargetActionApprovalRequestV1Schema.parse(request);
        return { ok: true };
      },
      executeApproved: async () => { effects += 1; throw new Error('Lost inputs cannot execute'); },
    });
    const result = await decide({ artifactId: 'lost-inputs', decision: 'approve' });
    expect(result).toMatchObject({ ok: false, errorCode: 'approval_stale', details: { reason: 'live_invocation_unavailable' } });
    expect(stored).toMatchObject({ status: 'failed', execution: { ok: false, effectAttempted: false,
      errorCode: 'approval_stale', details: { reason: 'live_invocation_unavailable' } } });
    expect(await decide({ artifactId: 'lost-inputs', decision: 'approve' })).toEqual(result);
    expect(effects).toBe(0);
  });

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
    const live = decision === 'approve' ? getSharedBlockingApprovalCoordinator().waitForDecision({
      artifactId: 'voice-target', request: accountApproval() }) : null;
    expect(await decide({ artifactId: 'voice-target', decision, context: {
      surface, authority: 'present_user', runtimeAccountId: 'reviewer', actionCaller: { kind: 'host' },
    } })).toMatchObject({ ok: true });
    await live;
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

  it('settles a named no-effect refusal when the original live invocation is unreachable in another process', async () => {
    let stored = accountApproval();
    const decide = createTargetActionApprovalDecision({ read: async () => stored,
      update: async ({ request }) => { stored = request; return { ok: true }; } });
    expect(await decide({ artifactId: 'other-process', decision: 'approve' }))
      .toMatchObject({ ok: false, errorCode: 'approval_stale' });
    expect(stored).toMatchObject({ status: 'failed', decision: { kind: 'approve' }, execution: {
      ok: false, effectAttempted: false, errorCode: 'approval_stale', details: { reason: 'live_invocation_unavailable' } } });
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
