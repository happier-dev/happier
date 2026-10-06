import { describe, expect, it, vi } from 'vitest';
import { buildSessionPermissionRespondRpcParamsV1 } from '@happier-dev/protocol';
import { ActionsSettingsV1Schema, createActionExecutor, isApprovalRequiredByActionsSettings, type ActionExecutorDeps } from '@happier-dev/protocol/actions';

import { AgentStateRequestStore, AgentStateResponseTargetDispatcher, type PermissionResponseClaim } from './agentStateRequestStore';
import { createSessionActionConfirmationAdapter } from '@/session/actions/approvals/sessionActionConfirmation';
import { CodexLikePermissionHandler } from './CodexLikePermissionHandler';
import { ServerBoundPermissionRpcHandlerManager } from './testkit/serverBoundPermissionRpcHandlerManager';

class FakeSession {
  sessionId = 'session-test';
  rpcHandlerManager = new ServerBoundPermissionRpcHandlerManager(this.sessionId);
  agentState: any = { requests: {}, completedRequests: {} };
  metadata: any = null;
  permissionResponseClaimWriteCount = 0;
  private readonly responseTargetDispatcher = new AgentStateResponseTargetDispatcher();

  getAgentStateResponseTargetDispatcher() {
    return this.responseTargetDispatcher;
  }

  private requestStore: AgentStateRequestStore | null = null;

  bindAgentStateRequestStore(store: AgentStateRequestStore) {
    this.requestStore = store;
  }

  getAgentStateRequestStore() {
    return this.requestStore;
  }

  getAgentStateSnapshot() {
    return this.agentState;
  }

  updateAgentState(updater: any) {
    const nextState = updater(this.agentState);
    if (Object.values(nextState.requests ?? {}).some((request: any) => (
      request
      && typeof request === 'object'
      && Object.hasOwn(request, 'permissionResponseClaimV1')
    ))) {
      this.permissionResponseClaimWriteCount += 1;
    }
    this.agentState = nextState;
    return this.agentState;
  }

  getMetadataSnapshot() {
    return this.metadata;
  }
}

describe('BasePermissionHandler permission-response routing (gap 28/29)', () => {
  it.each([
    { name: 'unknown request', requestId: 'unknown', turnId: 'turn-current', decision: 'allow', errorCode: 'permission_request_not_found' },
    { name: 'stale turn', requestId: 'pending', turnId: 'turn-old', decision: 'allow', errorCode: 'permission_request_not_found' },
    { name: 'non-offered Session grant', requestId: 'pending', turnId: 'turn-current', decision: 'approved_for_session', errorCode: 'permission_response_invalid' },
  ] as const)('refuses an agent Action answer for $name without settling the current request', async ({ requestId, turnId, decision, errorCode }) => {
    const session = new FakeSession();
    session.agentState.requests.pending = {
      tool: 'Happier Action', kind: 'permission', source: 'happier_action',
      arguments: { actionId: 'session.message.send', sessionId: session.sessionId },
      turnId: 'turn-current', createdAt: 1,
    };
    new CodexLikePermissionHandler({ session: session as never, logPrefix: '[Test]' });
    const rpc = session.rpcHandlerManager.handlers.get('session.permission.respond')!;
    const settings = ActionsSettingsV1Schema.parse({ v: 1,
      approvalWaivedSurfaces: { 'session.permission.respond': ['agent'] } });
    // Only the Session RPC transport is replaced; admission, policy, codecs,
    // request currentness and offered-answer validation are the real owners.
    const deps = {
      isActionApprovalRequired: (actionId, context) => isApprovalRequiredByActionsSettings(actionId, settings, context),
      sessionPermissionRespond: async ({ requestId: id, turnId: turn, decision: answer }) => rpc(
        buildSessionPermissionRespondRpcParamsV1({ id: id ?? '', turnId: turn ?? undefined, decision: answer }),
      ),
    } satisfies Pick<ActionExecutorDeps, 'isActionApprovalRequired' | 'sessionPermissionRespond'>;
    const executor = createActionExecutor(deps as ActionExecutorDeps);
    const result = await executor.execute('session.permission.respond', { sessionId: session.sessionId, requestId, turnId, decision }, {
      surface: 'agent', authority: 'account_automation', actionCaller: { kind: 'host' }, defaultSessionId: session.sessionId,
    });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: false, errorCode });
    expect(session.agentState.requests.pending).toMatchObject({ turnId: 'turn-current' });
    expect(session.agentState.completedRequests.pending).toBeUndefined();
  });
  it('rejects unknown permission RPC fields before settling the pending request', async () => {
    const session = new FakeSession();
    const handler = new CodexLikePermissionHandler({ session: session as never, logPrefix: '[Test]' });
    handler.setPermissionMode('safe-yolo');
    const pending = handler.handleToolCall('contradictory-request', 'Write', { path: '/tmp/x', content: 'hi' });
    const rpc = session.rpcHandlerManager.handlers.get('session.permission.respond')!;
    const result = await rpc({ id: 'contradictory-request', approved: true, decision: 'approved', actor: 'forged' });
    expect(result).toMatchObject({ ok: false, errorCode: 'permission_response_invalid' });
    expect(session.agentState.requests['contradictory-request']).toBeDefined();
    const canceled = expect(pending).rejects.toThrow('Session reset');
    await handler.reset();
    await canceled;
  });
  it('keeps predecessor scalar question answers on the legacy permission route', async () => {
    const session = new FakeSession();
    const handler = new CodexLikePermissionHandler({ session: session as never, logPrefix: '[Test]' });
    const pending = handler.handleToolCall('legacy-question', 'AskUserQuestion', {
      questions: [{ question: 'Choose?', options: [{ label: 'Yes', description: 'Continue' }], multiSelect: false }],
    });
    const rpc = session.rpcHandlerManager.handlers.get('permission')!;
    await expect(rpc({ id: 'legacy-question', approved: true, answers: { 'Choose?': 'Yes' } })).resolves.toBeUndefined();
    await expect(pending).resolves.toMatchObject({ decision: 'approved', answers: { 'Choose?': ['Yes'] } });
  });
  it.each(['approve', 'reset'] as const)('preserves live Action confirmation delivery after handler replacement: %s', async (completion) => {
    const session = new FakeSession();
    const initialHandler = new CodexLikePermissionHandler({ session: session as never, logPrefix: '[Initial]' });
    const initialStore = session.getAgentStateRequestStore()!;
    const adapter = createSessionActionConfirmationAdapter({
      sessionId: session.sessionId, store: initialStore,
      sessionSignal: new AbortController().signal,
      getAuthenticatedAccountId: async () => 'account-owner',
    });
    await initialHandler.reset();
    let resolvedDecision: string | undefined;
    const pending = adapter.confirm({
      actionId: 'session.activity.get', input: { sessionId: session.sessionId },
      preview: { sessionId: session.sessionId }, sessionId: session.sessionId,
      context: {
        surface: 'agent', authority: 'account_automation', defaultSessionId: session.sessionId,
        sessionInputSource: { sourceSessionId: session.sessionId, sourceTurnId: 'turn-action', via: 'action' },
      },
    }, { turnId: 'turn-action', lifetimeSignal: new AbortController().signal, isCurrent: () => true })
      .then((result) => { resolvedDecision = result?.decision; });
    await vi.waitFor(() => expect(initialStore.listOutstandingRequests()).toHaveLength(1));
    const requestId = initialStore.listOutstandingRequests()[0]!.requestId;
    const currentHandler = new CodexLikePermissionHandler({ session: session as never, logPrefix: '[Current]' });
    const rpc = session.rpcHandlerManager.handlers.get('session.permission.respond')!;
    if (completion === 'approve') {
      await rpc({ id: requestId, turnId: 'turn-action', approved: true, decision: 'approved' });
    } else {
      await currentHandler.reset();
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    const decisionAfterResponse = resolvedDecision;
    await adapter.dispose();
    await pending;
    expect(decisionAfterResponse).toBe(completion === 'approve' ? 'approve' : 'canceled');
    expect(session.agentState.completedRequests[requestId]).toMatchObject(completion === 'approve'
      ? { status: 'approved', decision: 'approved' }
      : { status: 'canceled', decision: 'abort' });
  });

  it.each([
    { decision: 'approved_for_session' },
    { decision: 'approved', allowedTools: ['Bash'] },
    { decision: 'approved', allowTools: ['Bash'] },
  ])('rejects native permission grants on a Happier Action confirmation: %j', async (grant) => {
    const session = new FakeSession();
    session.agentState.requests['action-confirmation'] = {
      tool: 'Bash',
      kind: 'permission',
      arguments: { command: 'echo hi' },
      source: 'happier_action',
      createdAt: 1,
    };
    new CodexLikePermissionHandler({ session: session as never, logPrefix: '[Test]' });
    const rpc = session.rpcHandlerManager.handlers.get('session.permission.respond');
    const result = await rpc!({ id: 'action-confirmation', approved: true, ...grant });
    expect(result).toEqual(expect.objectContaining({ ok: false }));
    expect(session.agentState.requests['action-confirmation']).toBeDefined();
    expect(session.agentState.completedRequests['action-confirmation']).toBeUndefined();
  });

  it('accepts one authenticated request-scoped Action decision with exact turn custody', async () => {
    const session = new FakeSession();
    session.agentState.requests['action-confirmation'] = {
      tool: 'Happier Action',
      kind: 'permission',
      arguments: { actionId: 'session.message.send', sessionId: session.sessionId },
      source: 'happier_action',
      turnId: 'turn-action',
      createdAt: 1,
    };
    new CodexLikePermissionHandler({ session: session as never, logPrefix: '[Test]' });
    const rpc = session.rpcHandlerManager.handlers.get('session.permission.respond');
    await expect(rpc!({
      id: 'action-confirmation', turnId: 'turn-action', approved: true, decision: 'approved',
    })).resolves.toBeUndefined();
    expect(session.agentState.requests['action-confirmation']).toBeUndefined();
    expect(session.agentState.completedRequests['action-confirmation']).toEqual(expect.objectContaining({
      status: 'approved',
      decision: 'approved',
      turnId: 'turn-action',
      permissionDecisionActorV1: expect.objectContaining({ accountId: 'account-owner' }),
    }));
  });

  it('returns a typed permission_request_not_found for an unknown explicit id over the RPC route', async () => {
    const session = new FakeSession();
    const handler = new CodexLikePermissionHandler({ session: session as any, logPrefix: '[Test]' });
    handler.setPermissionMode('safe-yolo');

    const rpc = session.rpcHandlerManager.handlers.get('permission');
    expect(rpc).toBeDefined();

    const result = await rpc!({ id: 'never-seen-request', approved: true, decision: 'approved' });
    expect(result).toEqual({
      ok: false,
      errorCode: 'permission_request_not_found',
      requestId: 'never-seen-request',
    });
  });

  it('returns void (success) over the RPC route when the explicit id resolves a pending request', async () => {
    const session = new FakeSession();
    const handler = new CodexLikePermissionHandler({ session: session as any, logPrefix: '[Test]' });
    handler.setPermissionMode('safe-yolo');

    const promise = handler.handleToolCall('tool-1', 'Write', { path: '/tmp/x', content: 'hi' });

    const rpc = session.rpcHandlerManager.handlers.get('permission');
    const result = await rpc!({ id: 'tool-1', approved: true, decision: 'approved' });
    expect(result).toBeUndefined();
    expect((await promise).decision).toBe('approved');
  });

  it('durably claims an authenticated present-user answer before settling the request', async () => {
    const session = new FakeSession();
    const handler = new CodexLikePermissionHandler({ session: session as any, logPrefix: '[Test]' });
    handler.setPermissionMode('safe-yolo');

    const promise = handler.handleToolCall('preactivation-request', 'Write', { path: '/tmp/x', content: 'hi' });
    const rpc = session.rpcHandlerManager.handlers.get('session.permission.respond');

    await expect(rpc!({ id: 'preactivation-request', approved: true, decision: 'approved' })).resolves.toBeUndefined();
    await expect(promise).resolves.toEqual(expect.objectContaining({ decision: 'approved' }));
    expect(session.permissionResponseClaimWriteCount).toBe(1);
  });

  it('does not let a delayed answer from turn A settle a reused request id in turn B', async () => {
    const session = new FakeSession();
    const handler = new CodexLikePermissionHandler({ session: session as any, logPrefix: '[Test]' });
    handler.setPermissionMode('safe-yolo');
    const rpc = session.rpcHandlerManager.handlers.get('session.permission.respond');
    const causalContext = (turnId: string) => ({
      turnId,
      causalPermissionAuthority: {
        kind: 'admittedSessionInputV1' as const,
        admittedPermissionCeiling: 'default' as const,
      },
    });

    const turnA = handler.handleToolCall(
      'reused-request',
      'Write',
      { path: '/tmp/a', content: 'a' },
      causalContext('turn-a'),
    );
    await expect(rpc!({
      id: 'reused-request',
      turnId: 'turn-a',
      approved: false,
      decision: 'denied',
    })).resolves.toBeUndefined();
    await expect(turnA).resolves.toEqual(expect.objectContaining({ decision: 'denied' }));
    await expect(rpc!({
      id: 'reused-request',
      turnId: 'turn-a',
      approved: false,
      decision: 'denied',
    })).resolves.toBeUndefined();

    const turnB = handler.handleToolCall(
      'reused-request',
      'Write',
      { path: '/tmp/b', content: 'b' },
      causalContext('turn-b'),
    );
    await expect(rpc!({
      id: 'reused-request',
      turnId: 'turn-a',
      approved: true,
      decision: 'approved',
    })).resolves.toEqual({
      ok: false,
      errorCode: 'permission_request_not_found',
      requestId: 'reused-request',
    });
    expect(session.agentState.requests['reused-request']).toEqual(expect.objectContaining({ turnId: 'turn-b' }));

    await expect(rpc!({
      id: 'reused-request',
      turnId: 'turn-b',
      approved: true,
      decision: 'approved',
    })).resolves.toBeUndefined();
    await expect(turnB).resolves.toEqual(expect.objectContaining({ decision: 'approved' }));
  });

  it('keeps a claimed present-user answer nonauthorizing after handler reset', async () => {
    const session = new FakeSession();
    const original = new CodexLikePermissionHandler({ session: session as any, logPrefix: '[Original]' });
    original.setPermissionMode('safe-yolo');

    const originalWaiter = original.handleToolCall(
      'generation-transition-request',
      'Write',
      { path: '/tmp/x', content: 'hi' },
    );
    const originalOutcome = originalWaiter.then(
      () => ({ status: 'resolved' as const }),
      (error: unknown) => ({ status: 'rejected' as const, error }),
    );
    await Promise.resolve();
    const claimedPresentUserAnswer = {
      version: 1,
      origin: 'presentUser',
      actor: {
        kind: 'accountUser',
        accountId: 'account-owner',
        relationship: 'owner',
      },
      decision: 'approved',
      scope: 'request',
    } satisfies PermissionResponseClaim;
    session.agentState.requests['generation-transition-request'].permissionResponseClaimV1 = claimedPresentUserAnswer;

    // Reset is a lifecycle cancellation boundary. Its Agent-state terminal
    // cancellation, not the in-flight answer claim, survives replacement.
    await original.reset();
    const replacement = new CodexLikePermissionHandler({ session: session as any, logPrefix: '[Replacement]' });
    replacement.setPermissionMode('safe-yolo');
    const rpc = session.rpcHandlerManager.handlers.get('session.permission.respond');
    expect(rpc).toBeDefined();

    await expect(rpc!({
      id: 'generation-transition-request',
      approved: false,
      decision: 'denied',
    })).resolves.toEqual({
      ok: false,
      errorCode: 'permission_request_not_found',
      requestId: 'generation-transition-request',
    });
    expect(session.agentState.requests['generation-transition-request']).toBeUndefined();
    expect(session.agentState.completedRequests['generation-transition-request']).toEqual(expect.objectContaining({
      status: 'canceled',
      decision: 'abort',
      reason: 'Session reset',
    }));

    await expect(rpc!({
      id: 'generation-transition-request',
      approved: true,
      decision: 'approved',
    })).resolves.toEqual({
      ok: false,
      errorCode: 'permission_request_not_found',
      requestId: 'generation-transition-request',
    });
    expect(session.agentState.completedRequests['generation-transition-request']).toEqual(expect.objectContaining({
      status: 'canceled',
      decision: 'abort',
    }));

    const settledOriginal = await originalOutcome;
    expect(settledOriginal.status).toBe('rejected');
    expect(settledOriginal.status === 'rejected' ? settledOriginal.error : null).toEqual(
      expect.objectContaining({ message: 'Session reset' }),
    );
    await original.reset();
    await replacement.reset();
  });

});
