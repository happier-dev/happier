import { afterEach, describe, expect, it, vi } from 'vitest';
import tweetnacl from 'tweetnacl';

import { admitApprovalRequesterDecisionV1, ApprovalRequestV2Schema, type ApprovalRequest, type ApprovalRequestV2 } from '../approvals/approvalRequestV1.js';

import { createBlockingApprovalCoordinator } from './blockingApprovalCoordinator.js';
import { TargetActionApprovalRequestV1Schema } from '../approvals/targetActionApprovalRequestV1.js';
import { ExecutionRunHostActionApprovalRequestV1Schema } from '../approvals/executionRunHostActionApprovalRequestV1.js';
import { buildApprovalRequesterConfirmationV1 } from '../approvals/approvalRequestV1.js';
import { buildApprovalExecutionOriginV1 } from './executor/approvalOrigins.js';
import { ExternalActionExecutionAuthorizationV1Schema } from './externalActionApi.js';
import { computeExternalActionRequestEnvelopeDigestV1, signExternalActionApprovalInputV1 } from './externalActionExecutionAuthorization.js';
import type { ActionExecutorContext } from './executor/types.js';

function approvalRequest(overrides: Partial<ApprovalRequestV2> = {}): ApprovalRequestV2 {
  return ApprovalRequestV2Schema.parse({
    v: 2,
    status: 'open',
    createdAtMs: 1,
    updatedAtMs: 1,
    createdBy: { surface: 'system' },
    requestedSurface: 'ui',
    actionId: 'teams.invitations.create',
    actionArgs: {
      v: 1,
      teamId: 'team-1',
      role: 'member',
      historyAccess: 'from_membership',
      recipientEmail: null,
      requestKey: 'request-1',
    },
    summary: 'Create invitation',
    preview: { actionId: 'teams.invitations.create' },
    executionOriginV1: {
      v: 1,
      authority: 'present_user',
      surface: 'ui',
      caller: { kind: 'host' },
      accountId: 'alice',
      serverId: 'server-1',
      sessionId: 'bot-session',
      actionId: 'teams.invitations.create',
      requestId: 'request-bob',
      actionRequestAttributionV1: { requestRef: 'request-bob', requester: { serverId: 'server-1', accountId: 'bob' },
        persona: { serverId: 'server-1', sessionId: 'bot-session' }, origin: null },
    },
    ...overrides,
  });
}

describe('createBlockingApprovalCoordinator', () => {
  it('refuses a live decision for a substituted confidential CLI subject without losing its original waiter', async () => {
    const coordinator = createBlockingApprovalCoordinator();
    const request = approvalRequest({ actionId: 'secrets.create', requestedSurface: 'cli',
      actionArgs: { name: 'Original credential', kind: 'apiKey' }, approval: { flow: 'blocking', result: 'required' },
      executionOriginV1: { v: 1, authority: 'account_automation', surface: 'cli', caller: { kind: 'host' },
        accountId: 'alice', serverId: 'server-1', serverIdentityId: 'stable-home',
        actionId: 'secrets.create', requestId: 'private-request' } });
    const pending = coordinator.waitForDecision({ artifactId: 'private-request', request });
    const approved = { ...request, status: 'approved' as const, updatedAtMs: 2,
      decision: { kind: 'approve' as const, decidedAtMs: 2, authority: 'present_user' as const } };
    await expect(coordinator.resolveBlockingDecision({ artifactId: 'private-request', decision: 'approve',
      decisionAuthority: 'present_user', request: { ...approved, actionArgs: { name: 'Substituted credential', kind: 'apiKey' } } }))
      .rejects.toMatchObject({ code: 'approval_request_conflict' });
    expect(coordinator.getLiveWaiterCount('private-request')).toBe(1);
    await expect(coordinator.resolveBlockingDecision({ artifactId: 'private-request', decision: 'approve',
      decisionAuthority: 'present_user', request: approved })).resolves.toEqual({ resolved: true });
    await expect(pending).resolves.toEqual({ decision: 'approve', request: approved, decisionAuthority: 'present_user' });
    coordinator.dispose();
  });
  afterEach(() => vi.useRealTimers());
  it.each(['target', 'execution-run-host'] as const)('requires authenticated live consent for %s despite approved durable reads and notifications', async family => {
    const coordinator = createBlockingApprovalCoordinator();
    const request = family === 'target' ? TargetActionApprovalRequestV1Schema.parse({
      v: 1, kind: 'plugin_target_action', status: 'open', createdAtMs: 1, updatedAtMs: 1,
      createdBy: { surface: 'cli' }, requestedSurface: 'cli', qualifiedActionId: 'acme.alpha/actions/run',
      input: {}, sourceCustody: { kind: 'development', registeredRootId: 'root' },
      approvalInputCustody: 'live_only', policyFingerprint: 'b'.repeat(64), subjectFingerprint: 'a'.repeat(64), summary: 'Run',
    }) : ExecutionRunHostActionApprovalRequestV1Schema.parse({
      v: 1, kind: 'execution_run_host_action', status: 'open', createdAtMs: 1, updatedAtMs: 1,
      createdBy: { surface: 'agent', sessionId: 'session' }, requestedSurface: 'agent', actionId: 'reviews.comments.create',
      sessionId: 'session', runId: 'run', callId: 'call', profileId: 'acme.review/review', pluginId: 'acme.review',
      agentId: 'claude', projectId: 'project', workspaceId: 'workspace', serverId: 'home', proposalCount: 1,
      proposalPreview: [], subjectFingerprint: 'a'.repeat(64), summary: 'Create review comment',
    });
    const approved = { ...request, status: 'approved' as const, updatedAtMs: 2,
      decision: { kind: 'approve' as const, decidedAtMs: 2, authority: 'present_user' as const } };
    let effects = 0;
    const read = vi.fn(async () => approved);
    const pending = coordinator.waitForDecision({ artifactId: 'forged-family', request, readRequest: read })
      .then(result => { if (result.decision === 'approve') effects++; return result; });
    try {
      await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
      coordinator.notifyApprovalUpdated({ artifactId: 'forged-family', request: approved });
      await Promise.resolve();
      expect(coordinator.getLiveWaiterCount('forged-family')).toBe(1);
      expect(effects).toBe(0);
      await expect(coordinator.resolveBlockingDecision({ artifactId: 'forged-family',
        request: { ...approved, summary: 'Substituted subject' }, decision: 'approve', decisionAuthority: 'present_user' }))
        .rejects.toMatchObject({ code: 'approval_request_conflict' });
      expect(coordinator.getLiveWaiterCount('forged-family')).toBe(1);
      expect(await coordinator.resolveBlockingDecision({ artifactId: 'forged-family', request: approved,
        decision: 'approve', decisionAuthority: 'present_user' })).toEqual({ resolved: true });
      await expect(pending).resolves.toMatchObject({ decision: 'approve', decisionAuthority: 'present_user' });
      expect(await coordinator.resolveBlockingDecision({ artifactId: 'forged-family', request: approved,
        decision: 'approve', decisionAuthority: 'present_user' })).toEqual({ resolved: false });
      expect(effects).toBe(1);
    } finally { coordinator.dispose(); await pending.catch(() => undefined); }
  });
  it('refuses a live decision for a substituted confidential CLI subject without losing its original waiter', async () => {
    const coordinator = createBlockingApprovalCoordinator();
    const request = approvalRequest({ actionId: 'secrets.create', requestedSurface: 'cli',
      actionArgs: { name: 'Original credential', kind: 'apiKey' }, approval: { flow: 'blocking', result: 'required' },
      executionOriginV1: { v: 1, authority: 'account_automation', surface: 'cli', caller: { kind: 'host' },
        accountId: 'alice', serverId: 'server-1', serverIdentityId: 'stable-home',
        actionId: 'secrets.create', requestId: 'private-request' } });
    const pending = coordinator.waitForDecision({ artifactId: 'private-request', request });
    const approved = { ...request, status: 'approved' as const, updatedAtMs: 2,
      decision: { kind: 'approve' as const, decidedAtMs: 2, authority: 'present_user' as const } };
    await expect(coordinator.resolveBlockingDecision({ artifactId: 'private-request', decision: 'approve',
      decisionAuthority: 'present_user', request: { ...approved, actionArgs: { name: 'Substituted credential', kind: 'apiKey' } } }))
      .rejects.toMatchObject({ code: 'approval_request_conflict' });
    expect(coordinator.getLiveWaiterCount('private-request')).toBe(1);
    await expect(coordinator.resolveBlockingDecision({ artifactId: 'private-request', decision: 'approve',
      decisionAuthority: 'present_user', request: approved })).resolves.toEqual({ resolved: true });
    await expect(pending).resolves.toEqual({ decision: 'approve', request: approved, decisionAuthority: 'present_user' });
    coordinator.dispose();
  });
  it.each(['builtin', 'target'] as const)('keeps $0 requester confirmation waiting for the host decision proof after a failed durable read', async family => {
    const coordinator = createBlockingApprovalCoordinator();
    const base = approvalRequest();
    const targetInput = { title: 'Release' };
    const actionId = family === 'builtin' ? base.actionId : 'action.invoke';
    const input = family === 'builtin' ? base.actionArgs : { action: { pluginId: 'acme.target', localId: 'run' }, input: targetInput };
    const target = { kind: 'session' as const, sessionId: 'bot-session' };
    // Home authorization is the transport boundary; build the signed subject
    // with the real producers rather than an unsigned, invalid stored shape.
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-admitted-origin', binding: {
      accountId: 'alice', custodianAccountId: 'alice', authentication: { kind: 'account', tokenEpoch: 1 },
      serverIdentityId: 'stable-home', machineId: 'machine-1', installationId: 'installation-1', actionId,
      requestId: 'request-bob', target,
      requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1({ v: 1, requestId: 'request-bob', target, input }),
    } });
    const keys = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(19));
    const context: ActionExecutorContext = { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
      runtimeAccountId: 'alice', serverId: 'server-1', serverIdentityId: 'stable-home', defaultSessionId: 'bot-session',
      actionRequestId: 'request-bob', actionRequestAttributionV1: base.executionOriginV1.actionRequestAttributionV1,
      externalActionTarget: target, externalActionExecutionAuthorization: authorization,
      signExternalActionApprovalInput: args => signExternalActionApprovalInputV1({ actionId: args.actionId, input: args.input,
        target: args.target, authorizationToken: args.authorization.token, requesterConfirmation: args.requesterConfirmation,
        privateKey: keys.secretKey }),
    };
    const requesterConfirmation = buildApprovalRequesterConfirmationV1({ context, actionId, input });
    if (!requesterConfirmation) throw new Error('Expected requester confirmation');
    const executionOriginV1 = buildApprovalExecutionOriginV1({ context, actionId, input, targetSessionId: 'bot-session', requesterConfirmation });
    if (!executionOriginV1) throw new Error('Expected signed requester origin');
    const request = family === 'builtin' ? approvalRequest({ executionOriginV1, requesterConfirmation }) : TargetActionApprovalRequestV1Schema.parse({
      v: 1, kind: 'plugin_target_action', status: 'open', createdAtMs: 1, updatedAtMs: 1,
      createdBy: { surface: 'agent' }, requestedSurface: 'agent', qualifiedActionId: 'acme.target/actions/run',
      input: targetInput, secretInputPaths: [], sourceCustody: { kind: 'development', registeredRootId: 'target-root' },
      policyFingerprint: 'a'.repeat(64), subjectFingerprint: 'b'.repeat(64), summary: 'Release',
      executionOriginV1,
      requesterConfirmation,
    });
    const readRequest = vi.fn(async () => {
      throw Object.assign(new Error('artifact_read_unavailable'), { code: 'artifact_read_unavailable' });
    });
    const dispose = vi.fn();
    const pending = coordinator.waitForDecision({ artifactId: 'requester-live', request,
      readRequest, subscribeChanges: () => ({ dispose }) });
    const observed = pending.then(
      value => ({ kind: 'resolved' as const, value }),
      error => ({ kind: 'rejected' as const, error }),
    );
    await vi.waitFor(() => expect(readRequest).toHaveBeenCalledTimes(1));
    expect(coordinator.getLiveWaiterCount('requester-live')).toBe(1);
    const approved = { ...request, status: 'approved' as const, updatedAtMs: 2,
      decision: { kind: 'approve' as const, decidedAtMs: 2, authority: 'present_user' as const, decidingAccountId: 'bob' } };
    coordinator.notifyApprovalUpdated({ artifactId: 'requester-live', request: approved });
    expect(coordinator.getLiveWaiterCount('requester-live')).toBe(1);
    const requesterLifetime = new AbortController();
    const requesterApprovalDecision = { sessionId: 'bot-session',
      actor: { kind: 'accountUser', accountId: 'bob', relationship: 'sharedApprover' },
      isCurrent: async () => !requesterLifetime.signal.aborted } as const;
    await expect(coordinator.resolveBlockingDecision({ artifactId: 'requester-live', request: approved,
      decision: 'approve', decisionAuthority: 'present_user', requesterApprovalDecision })).resolves.toEqual({ resolved: true });
    await expect(observed).resolves.toMatchObject({ kind: 'resolved', value: {
      decision: 'approve', requesterApprovalDecision,
    } });
    const delivered = await observed;
    if (delivered.kind !== 'resolved' || delivered.value.decision !== 'approve') throw new Error('Expected the live decision');
    const consumingRequest = { ...request, actionId, actionArgs: input };
    const decisionContext = { ...context, requesterApprovalDecision: delivered.value.requesterApprovalDecision };
    expect(await admitApprovalRequesterDecisionV1({ request: consumingRequest, context: decisionContext })).toMatchObject({ ok: true });
    requesterLifetime.abort();
    expect((await admitApprovalRequesterDecisionV1({ request: consumingRequest, context: decisionContext })).ok).toBe(false);
    expect(dispose).toHaveBeenCalledTimes(1);

    const denied = coordinator.waitForDecision({ artifactId: 'requester-denied', request,
      readRequest, subscribeChanges: () => ({ dispose }) });
    await vi.waitFor(() => expect(readRequest).toHaveBeenCalledTimes(2));
    expect(coordinator.getLiveWaiterCount('requester-denied')).toBe(1);
    const rejected = { ...request, status: 'rejected' as const, updatedAtMs: 3,
      decision: { kind: 'reject' as const, decidedAtMs: 3 } };
    coordinator.notifyApprovalUpdated({ artifactId: 'requester-denied', request: rejected });
    await expect(denied).resolves.toEqual({ decision: 'reject', request: rejected });
    expect(coordinator.getLiveWaiterCount('requester-denied')).toBe(0);

    const terminalDispose = vi.fn();
    const terminalRead = vi.fn(async () => {
      throw Object.assign(new Error('artifact_read_invalid'), { code: 'artifact_read_invalid' });
    });
    const terminal = coordinator.waitForDecision({ artifactId: 'requester-terminal', request,
      readRequest: terminalRead, subscribeChanges: () => ({ dispose: terminalDispose }) });
    await expect(terminal).rejects.toMatchObject({ code: 'artifact_read_invalid' });
    expect(terminalRead).toHaveBeenCalledTimes(1);
    expect(terminalDispose).toHaveBeenCalledTimes(1);
    expect(coordinator.getLiveWaiterCount('requester-terminal')).toBe(0);
  });
  it('returns an approval decision only to the exact live waiter', async () => {
    const coordinator = createBlockingApprovalCoordinator();
    const pending = coordinator.waitForDecision({
      artifactId: 'approval-1',
      request: approvalRequest(),
    });
    const approved = approvalRequest({
      status: 'approved',
      updatedAtMs: 2,
      decision: { kind: 'approve', decidedAtMs: 2 },
    });

    await expect(coordinator.resolveBlockingDecision({
      artifactId: 'approval-1',
      request: approved,
      decision: 'approve',
    })).resolves.toEqual({ resolved: true });
    await expect(pending).resolves.toEqual({ decision: 'approve', request: approved });
    expect(coordinator.getLiveWaiterCount('approval-1')).toBe(0);
  });

  it('keeps an ordinary blocking waiter for direct approval after one unavailable durable read', async () => {
    const coordinator = createBlockingApprovalCoordinator();
    const request = approvalRequest();
    const readRequest = vi.fn(async () => {
      throw Object.assign(new Error('artifact_read_unavailable'), { code: 'artifact_read_unavailable' });
    });
    const dispose = vi.fn();
    const pending = coordinator.waitForDecision({
      artifactId: 'ordinary-read-unavailable',
      request,
      readRequest,
      subscribeChanges: () => ({ dispose }),
    });
    const observed = pending.then(
      value => ({ kind: 'resolved' as const, value }),
      error => ({ kind: 'rejected' as const, error }),
    );

    await vi.waitFor(() => expect(readRequest).toHaveBeenCalledTimes(1));
    expect(coordinator.getLiveWaiterCount('ordinary-read-unavailable')).toBe(1);
    const approved = approvalRequest({
      status: 'approved',
      updatedAtMs: 2,
      decision: { kind: 'approve', decidedAtMs: 2 },
    });
    await expect(coordinator.resolveBlockingDecision({
      artifactId: 'ordinary-read-unavailable',
      request: approved,
      decision: 'approve',
      decisionAuthority: 'present_user',
    })).resolves.toEqual({ resolved: true });
    await expect(observed).resolves.toEqual({
      kind: 'resolved',
      value: { decision: 'approve', request: approved, decisionAuthority: 'present_user' },
    });
    expect(readRequest).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(coordinator.getLiveWaiterCount('ordinary-read-unavailable')).toBe(0);
  });

  it('reads durable changes without polling and waits for the built-in execution result', async () => {
    vi.useFakeTimers();
    const coordinator = createBlockingApprovalCoordinator();
    const approved = approvalRequest({
      status: 'approved',
      updatedAtMs: 2,
      decision: { kind: 'approve', decidedAtMs: 2 },
    });
    let request = approvalRequest();
    let onChange = () => {};
    const dispose = vi.fn();
    const readRequest = vi.fn(async () => request);
    const pending = coordinator.waitForDecision({
      artifactId: 'approval-2',
      request: approvalRequest(),
      readRequest,
      subscribeChanges: (change) => {
        onChange = change;
        return { dispose };
      },
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(readRequest).toHaveBeenCalledTimes(1);
    request = approved;
    onChange();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(readRequest).toHaveBeenCalledTimes(2);
    expect(coordinator.getLiveWaiterCount('approval-2')).toBe(1);
    request = approvalRequest({
      ...approved,
      status: 'executed',
      execution: { executedAtMs: 3, ok: true, result: { ok: true } },
    });
    onChange();
    await expect(pending).resolves.toEqual({ decision: 'approve', request });
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('subscribes before reading and coalesces changes received during a durable read', async () => {
    const coordinator = createBlockingApprovalCoordinator();
    let resolveRead: (request: ApprovalRequest) => void = () => {};
    let onChange = () => {};
    let subscribed = false;
    const rejected = approvalRequest({ status: 'rejected', decision: { kind: 'reject', decidedAtMs: 2 } });
    const readRequest = vi.fn(() => {
      expect(subscribed).toBe(true);
      return new Promise<ApprovalRequest>((resolve) => { resolveRead = resolve; });
    });
    const dispose = vi.fn();
    const pending = coordinator.waitForDecision({
      artifactId: 'approval-race',
      request: approvalRequest(),
      readRequest,
      subscribeChanges: (change) => {
        subscribed = true;
        onChange = change;
        return { dispose };
      },
    });
    onChange();
    onChange();
    onChange();
    resolveRead(approvalRequest());
    await Promise.resolve();
    expect(readRequest).toHaveBeenCalledTimes(2);
    resolveRead(rejected);
    await expect(pending).resolves.toEqual({ decision: 'reject', request: rejected });
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('retires the feed on abort and ignores a late durable answer and subsequent changes', async () => {
    const coordinator = createBlockingApprovalCoordinator();
    const controller = new AbortController();
    let resolveRead: (request: ApprovalRequest) => void = () => {};
    let onChange = () => {};
    const dispose = vi.fn();
    const readRequest = vi.fn(() => new Promise<ApprovalRequest>((resolve) => { resolveRead = resolve; }));
    const pending = coordinator.waitForDecision({
      artifactId: 'approval-abort',
      request: approvalRequest(),
      signal: controller.signal,
      readRequest,
      subscribeChanges: (change) => { onChange = change; return { dispose }; },
    });
    const rejected = expect(pending).rejects.toThrow('origin_unmounted');
    controller.abort('origin_unmounted');
    await rejected;
    resolveRead(approvalRequest({ status: 'rejected', decision: { kind: 'reject', decidedAtMs: 2 } }));
    onChange();
    await Promise.resolve();
    expect(readRequest).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(coordinator.getLiveWaiterCount('approval-abort')).toBe(0);
  });

  it('surfaces feed errors and releases the live wait', async () => {
    const coordinator = createBlockingApprovalCoordinator();
    let onError: (error: unknown) => void = () => {};
    const dispose = vi.fn();
    const pending = coordinator.waitForDecision({
      artifactId: 'approval-feed-error',
      request: approvalRequest(),
      readRequest: async () => approvalRequest(),
      subscribeChanges: (_change, error) => { onError = error; return { dispose }; },
    });
    onError(new Error('account_feed_unavailable'));
    await expect(pending).rejects.toThrow('account_feed_unavailable');
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(coordinator.getLiveWaiterCount('approval-feed-error')).toBe(0);
  });

  it('ignores abort after a decision while its feed is being released', async () => {
    const coordinator = createBlockingApprovalCoordinator();
    const controller = new AbortController();
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => { release = resolve; });
    const pending = coordinator.waitForDecision({
      artifactId: 'approval-settled-abort',
      request: approvalRequest(),
      signal: controller.signal,
      subscribeChanges: () => ({ dispose: () => released }),
    });
    const rejected = approvalRequest({ status: 'rejected', decision: { kind: 'reject', decidedAtMs: 2 } });
    coordinator.notifyApprovalUpdated({ artifactId: 'approval-settled-abort', request: rejected });
    controller.abort('late_abort');
    expect(coordinator.getDetachedWaiterCount('approval-settled-abort')).toBe(0);
    release();
    await expect(pending).resolves.toEqual({ decision: 'reject', request: rejected });
  });

  it('surfaces a failed durable read instead of keeping an unobservable live wait', async () => {
    const coordinator = createBlockingApprovalCoordinator();
    const dispose = vi.fn();
    const pending = coordinator.waitForDecision({
      artifactId: 'approval-read-error',
      request: approvalRequest(),
      readRequest: async () => { throw new Error('artifact_read_unavailable'); },
      subscribeChanges: () => ({ dispose }),
    });
    await expect(pending).rejects.toThrow('artifact_read_unavailable');
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(coordinator.getLiveWaiterCount('approval-read-error')).toBe(0);
  });

  it('releases a synchronously failed subscription before the wait rejects', async () => {
    const coordinator = createBlockingApprovalCoordinator();
    const dispose = vi.fn(async () => {});
    const readRequest = vi.fn(async () => approvalRequest());
    const pending = coordinator.waitForDecision({
      artifactId: 'approval-subscribe-error',
      request: approvalRequest(),
      readRequest,
      subscribeChanges: (_onChange, onError) => {
        onError(new Error('subscription_start_failed'));
        return { dispose };
      },
    });
    await expect(pending).rejects.toThrow('subscription_start_failed');
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(readRequest).not.toHaveBeenCalled();
  });

  it('does not retain an aborted origin as a later result recipient', async () => {
    const coordinator = createBlockingApprovalCoordinator();
    const abortController = new AbortController();
    const pending = coordinator.waitForDecision({
      artifactId: 'approval-3',
      request: approvalRequest(),
      signal: abortController.signal,
    });

    abortController.abort('origin_unmounted');
    await expect(pending).rejects.toThrow('origin_unmounted');
    await expect(coordinator.resolveBlockingDecision({
      artifactId: 'approval-3',
      request: approvalRequest({
        status: 'approved',
        updatedAtMs: 2,
        decision: { kind: 'approve', decidedAtMs: 2 },
      }),
      decision: 'approve',
    })).resolves.toEqual({ resolved: false });
    expect(coordinator.getDetachedWaiterCount('approval-3')).toBe(1);
  });
});
