import { describe, expect, it, vi } from 'vitest';

import { CodexLikePermissionHandler } from './CodexLikePermissionHandler';
import { SessionPermissionRpcRouter } from './sessionPermissionRpcRouter';
import { createRunScopedExecutionPermissionHandler } from '@/agent/executionRuns/runtime/runScopedExecutionPermissionHandler';
import { createExecutionRunPermissionHandler } from '@/agent/executionRuns/policy/executionRunPermissionDecision';
import { PUBLIC_RPC_HANDLER_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';

class FakeRpcHandlerManager {
  handlers = new Map<string, (payload: any) => any>();
  registerHandler(_name: string, handler: any) {
    this.handlers.set(_name, handler);
  }
}

class FakeSession {
  sessionId = 'session-test';
  rpcHandlerManager = new FakeRpcHandlerManager();
  agentState: any = { requests: {}, completedRequests: {} };
  metadata: any = null;
  private permissionRpcRouter: SessionPermissionRpcRouter | null = null;

  getOrCreatePermissionRpcRouter() {
    if (!this.permissionRpcRouter) {
      this.permissionRpcRouter = new SessionPermissionRpcRouter(this.rpcHandlerManager);
    }
    return this.permissionRpcRouter;
  }

  getAgentStateSnapshot() {
    return this.agentState;
  }

  async updateAgentStateRequestSettlement(updater: Parameters<FakeSession['updateAgentState']>[0]): Promise<void> {

    await this.updateAgentState(updater);

  }


  updateAgentState(updater: any) {
    this.agentState = updater(this.agentState);
    return this.agentState;
  }

  getMetadataSnapshot() {
    return this.metadata;
  }

  setMetadataSnapshot(next: any) {
    this.metadata = next;
  }
}

async function settledState<T>(promise: Promise<T>): Promise<'pending' | 'fulfilled' | 'rejected'> {
  await Promise.resolve();
  await Promise.resolve();

  return Promise.race([
    promise.then(
      () => 'fulfilled' as const,
      () => 'rejected' as const,
    ),
    new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 0)),
  ]);
}

describe('CodexLikePermissionHandler', () => {
  it('retires saved foreground prompts after reconstruction without canceling an execution run', async () => {
    const session = new FakeSession();
    const previous = new CodexLikePermissionHandler({ session: session as any, logPrefix: '[Previous]' });
    const abandoned = previous.handleToolCall('saved-foreground', 'Write', { path: '/tmp/foreground' });
    void abandoned.catch(() => undefined);
    const executionOwner = new CodexLikePermissionHandler({ session: session as any, logPrefix: '[ExecutionRun]' });
    const run = createRunScopedExecutionPermissionHandler({ runId: 'run-kept', handler: executionOwner });
    const execution = run.handler.handleToolCall('call_1', 'Write', { path: '/tmp/background' });
    const executionId = Object.keys(session.agentState.requests).find((id) => id !== 'saved-foreground')!;
    const resumed = new CodexLikePermissionHandler({ session: session as any, logPrefix: '[Resumed]' });

    await resumed.abortPendingRequestsAndFlush();

    expect(session.agentState.requests['saved-foreground']).toBeUndefined();
    expect(session.agentState.completedRequests['saved-foreground']).toMatchObject({ status: 'canceled', decision: 'abort' });
    expect(session.agentState.requests[executionId]).toBeDefined();
    expect(await settledState(execution)).toBe('pending');
    run.dispose('Test cleanup');
    await expect(execution).resolves.toMatchObject({ decision: 'abort' });
  });

  it('keeps saved foreground prompts when a reconstructed execution-run owner resets', async () => {
    const session = new FakeSession();
    const foreground = new CodexLikePermissionHandler({ session: session as any, logPrefix: '[Foreground]' });
    const foregroundDecision = foreground.handleToolCall('foreground-kept', 'Write', { path: '/tmp/foreground' });
    const previous = new CodexLikePermissionHandler({ session: session as any, logPrefix: '[Previous execution]' });
    const run = createRunScopedExecutionPermissionHandler({ runId: 'run-retired', handler: previous });
    const abandoned = run.handler.handleToolCall('call_1', 'Write', { path: '/tmp/background' });
    void abandoned.catch(() => undefined);
    const executionId = Object.keys(session.agentState.requests).find((id) => id !== 'foreground-kept')!;
    const resumed = new CodexLikePermissionHandler({
      session: session as any, logPrefix: '[ExecutionRun]', requestScope: 'execution_run',
    });

    await resumed.abortPendingRequestsAndFlush();

    expect(session.agentState.requests[executionId]).toBeUndefined();
    expect(session.agentState.completedRequests[executionId]).toMatchObject({ status: 'canceled', decision: 'abort' });
    expect(session.agentState.requests['foreground-kept']).toBeDefined();
    expect(await settledState(foregroundDecision)).toBe('pending');
    await session.rpcHandlerManager.handlers.get('permission')!({ id: 'foreground-kept', approved: false, decision: 'denied' });
    await expect(foregroundDecision).resolves.toMatchObject({ decision: 'denied' });
  });

  it('does not adopt an independent execution-run prompt through foreground cancellation or legacy RPC', async () => {
    const session = new FakeSession();
    const owner = new CodexLikePermissionHandler({ session: session as any, logPrefix: '[ExecutionRun]' });
    const run = createRunScopedExecutionPermissionHandler({ runId: 'run-routed', handler: owner });
    const execution = run.handler.handleToolCall('call_1', 'Write', { path: '/tmp/background' });
    const executionId = Object.keys(session.agentState.requests)[0]!;
    // Exercise the direct-handler boundary as well as the shared router path.
    Object.assign(session, { getOrCreatePermissionRpcRouter: undefined });
    const foreground = new CodexLikePermissionHandler({ session: session as any, logPrefix: '[Foreground]' });

    expect(foreground.cancelPendingRequest(executionId, 'Foreground stopped')).toBe(false);
    await session.rpcHandlerManager.handlers.get('permission')!({ id: executionId, approved: true });

    expect(session.agentState.requests[executionId]).toBeDefined();
    expect(await settledState(execution)).toBe('pending');
    run.dispose('Test cleanup');
    await expect(execution).resolves.toMatchObject({ decision: 'abort' });
  });

  it('hard-denies write-like tools in read-only mode', async () => {
    const session = new FakeSession();
    const handler = new CodexLikePermissionHandler({ session: session as any, logPrefix: '[Test]' });
    handler.setPermissionMode('read-only');

    const result = await handler.handleToolCall('tool-1', 'Write', { path: '/tmp/x', content: 'hi' });
    expect(result.decision).toBe('denied');

    expect(session.agentState.requests).toEqual({});
    expect(session.agentState.completedRequests['tool-1']).toEqual(
      expect.objectContaining({
        tool: 'Write',
        status: 'denied',
        decision: 'denied',
      }),
    );
  });

  it('hard-denies write-like tools in plan mode', async () => {
    const session = new FakeSession();
    const handler = new CodexLikePermissionHandler({ session: session as any, logPrefix: '[Test]' });
    handler.setPermissionMode('plan');

    const promise = handler.handleToolCall('tool-1', 'Write', { path: '/tmp/x', content: 'hi' });

    const hasPrompted = Boolean(session.agentState.requests['tool-1']);
    if (hasPrompted) {
      // Resolve the pending request so the test doesn't hang on failure.
      const rpc = session.rpcHandlerManager.handlers.get('permission');
      await rpc!({ id: 'tool-1', approved: false, decision: 'denied' });
    }

    const result = await promise;
    expect(hasPrompted).toBe(false);
    expect(result.decision).toBe('denied');
  });

  it('does not auto-approve AskUserQuestion in plan mode', async () => {
    const session = new FakeSession();
    const handler = new CodexLikePermissionHandler({ session: session as any, logPrefix: '[Test]' });
    handler.setPermissionMode('plan');

    const promise = handler.handleToolCall('tool-ask', 'AskUserQuestion', {
      questions: [
        {
          header: 'Export Shape',
          question: 'Which session export behavior should the plan target?',
          options: [{ label: 'Single JSON', description: 'Portable JSON export' }],
          multiSelect: false,
        },
      ],
    });

    expect(session.agentState.requests['tool-ask']).toEqual(
      expect.objectContaining({
        tool: 'AskUserQuestion',
        kind: 'user_action',
      }),
    );

    const rpc = session.rpcHandlerManager.handlers.get('permission');
    expect(rpc).toBeDefined();
    await rpc!({
      id: 'tool-ask',
      approved: true,
      answers: {
        'Which session export behavior should the plan target?': 'Single JSON',
      },
    });

    await expect(promise).resolves.toEqual({
      decision: 'approved',
      answers: {
        'Which session export behavior should the plan target?': ['Single JSON'],
      },
    });
  });

  it('accepts a structured question answer after a completed turn resets the handler', async () => {
    const session = new FakeSession();
    const handler = new CodexLikePermissionHandler({ session: session as any, logPrefix: '[Test]' });
    const previous = handler.handleToolCall('previous-turn-question', 'AskUserQuestion', {
      questions: [{ question: 'Previous?', options: [{ label: 'Yes' }] }],
    });
    handler.reset();
    await expect(previous).rejects.toThrow('Session reset');

    const pending = handler.handleToolCall('next-turn-question', 'AskUserQuestion', {
      questions: [{ question: 'Continue?', options: [{ label: 'Yes' }] }],
    });
    const rpc = session.rpcHandlerManager.handlers.get('session.structuredQuestion.respond.v1');
    expect(rpc).toBeDefined();

    try {
      await expect(rpc!({
        id: 'previous-turn-question',
        structuredAnswersV1: { 'Previous?': ['Yes'] },
      })).rejects.toMatchObject({
        rpcErrorCode: PUBLIC_RPC_HANDLER_ERROR_CODES.STRUCTURED_QUESTION_RECEIVER_NOT_OWNER,
      });
      await rpc!({ id: 'next-turn-question', structuredAnswersV1: { 'Continue?': ['Yes'] } });
      await expect(pending).resolves.toEqual({
        decision: 'approved',
        answers: { 'Continue?': ['Yes'] },
      });
      expect(session.agentState.requests['next-turn-question']).toBeUndefined();
    } finally {
      handler.reset();
      await pending.catch(() => undefined);
    }
  });

  it('keeps a structured question answerable until its completed state is acknowledged', async () => {
    const session = new FakeSession();
    const originalUpdate = session.updateAgentState.bind(session);
    let rejectCompletion = true;
    let rejectCompletionWrite: ((error: Error) => void) | null = null;
    vi.spyOn(session, 'updateAgentState').mockImplementation((updater) => {
      const next = updater(session.agentState);
      if (rejectCompletion && next.completedRequests?.['question-ack']) {
        return new Promise<void>((_resolve, reject) => { rejectCompletionWrite = reject; });
      }
      return originalUpdate(updater);
    });
    const handler = new CodexLikePermissionHandler({ session: session as any, logPrefix: '[Test]' });
    const pending = handler.handleToolCall('question-ack', 'AskUserQuestion', {
      questions: [{ question: 'Proceed?', options: [{ label: 'Yes' }] }],
    });
    const rpc = session.rpcHandlerManager.handlers.get('session.structuredQuestion.respond.v1');
    expect(rpc).toBeDefined();

    const firstAnswer = rpc!({
      id: 'question-ack',
      structuredAnswersV1: { 'Proceed?': ['Yes'] },
    });
    expect(await settledState(firstAnswer)).toBe('pending');
    expect(await settledState(pending)).toBe('pending');
    expect(rejectCompletionWrite).not.toBeNull();
    rejectCompletionWrite!(new Error('session socket disconnected'));
    await expect(firstAnswer).rejects.toBeDefined();
    expect(await settledState(pending)).toBe('pending');
    expect(session.agentState.requests['question-ack']).toBeDefined();

    rejectCompletion = false;
    await rpc!({ id: 'question-ack', structuredAnswersV1: { 'Proceed?': ['Yes'] } });
    await expect(pending).resolves.toEqual({ decision: 'approved', answers: { 'Proceed?': ['Yes'] } });
    expect(session.agentState.requests['question-ack']).toBeUndefined();
    expect(session.agentState.completedRequests['question-ack']?.structuredAnswersV1).toEqual({ 'Proceed?': ['Yes'] });
  });

  it('prompts for write-like tools in safe-yolo mode', async () => {
    const session = new FakeSession();
    const handler = new CodexLikePermissionHandler({ session: session as any, logPrefix: '[Test]' });
    handler.setPermissionMode('safe-yolo');

    const promise = handler.handleToolCall('tool-1', 'Write', { path: '/tmp/x', content: 'hi' });

    expect(session.agentState.requests['tool-1']).toEqual(
      expect.objectContaining({
        tool: 'Write',
      }),
    );

    const rpc = session.rpcHandlerManager.handlers.get('permission');
    expect(rpc).toBeDefined();
    await rpc!({ id: 'tool-1', approved: true, decision: 'approved' });

    const result = await promise;
    expect(result.decision).toBe('approved');
  });

  it('resolves every duplicate same-id waiter from one permission response', async () => {
    const session = new FakeSession();
    const handler = new CodexLikePermissionHandler({ session: session as any, logPrefix: '[Test]' });
    const input = { command: 'echo hello' };

    const first = handler.handleToolCall('tool-duplicate', 'bash', input);
    const second = handler.handleToolCall('tool-duplicate', 'bash', input);

    expect(Object.keys(session.agentState.requests)).toEqual(['tool-duplicate']);

    const rpc = session.rpcHandlerManager.handlers.get('permission');
    expect(rpc).toBeDefined();
    await rpc!({ id: 'tool-duplicate', approved: true, decision: 'approved' });

    await expect(second).resolves.toEqual({ decision: 'approved' });
    expect(await settledState(first)).toBe('fulfilled');
    await expect(first).resolves.toEqual({ decision: 'approved' });
    expect(session.agentState.requests['tool-duplicate']).toBeUndefined();
    expect(session.agentState.completedRequests['tool-duplicate']).toEqual(
      expect.objectContaining({
        tool: 'bash',
        status: 'approved',
        decision: 'approved',
      }),
    );
  });

  it('routes one session permission RPC to the handler that owns the exact request id', async () => {
    const session = new FakeSession();
    const firstHandler = new CodexLikePermissionHandler({ session: session as any, logPrefix: '[First]' });
    const secondHandler = new CodexLikePermissionHandler({ session: session as any, logPrefix: '[Second]' });

    const pending = secondHandler.handleToolCall('tool-second', 'Write', { path: '/tmp/x', content: 'hi' });
    const rpc = session.rpcHandlerManager.handlers.get('permission');
    expect(rpc).toBeDefined();
    await expect(rpc!({ id: 'tool-second', approved: true, decision: 'approved' })).resolves.toEqual({ ok: true });

    await expect(pending).resolves.toEqual({ decision: 'approved' });
    firstHandler.reset();
    secondHandler.reset();
  });

  it('isolates identical provider permission ids by execution run and disposes only one run', async () => {
    const session = new FakeSession();
    const owner = new CodexLikePermissionHandler({ session: session as any, logPrefix: '[ExecutionRun]' });
    const runA = createRunScopedExecutionPermissionHandler({ runId: 'run-a', handler: owner });
    const runB = createRunScopedExecutionPermissionHandler({ runId: 'run-b', handler: owner });

    const approvalA = runA.handler.handleToolCall('call_1', 'Write', { path: '/tmp/a' });
    const approvalB = runB.handler.handleToolCall('call_1', 'Write', { path: '/tmp/b' });
    const requestIds = Object.keys(session.agentState.requests);
    expect(requestIds).toHaveLength(2);
    const requestAId = requestIds.find((id) => session.agentState.requests[id]?.arguments?.path === '/tmp/a');
    const requestBId = requestIds.find((id) => session.agentState.requests[id]?.arguments?.path === '/tmp/b');
    expect(requestAId).toBeDefined();
    expect(requestBId).toBeDefined();
    expect(requestAId).not.toBe(requestBId);

    const rpc = session.rpcHandlerManager.handlers.get('permission');
    await rpc!({ id: requestAId, approved: true, decision: 'approved' });
    await expect(approvalA).resolves.toEqual({ decision: 'approved' });
    expect(await settledState(approvalB)).toBe('pending');

    const stopA = runA.handler.handleToolCall('call_2', 'Write', { path: '/tmp/a2' });
    const stopB = runB.handler.handleToolCall('call_2', 'Write', { path: '/tmp/b2' });
    runA.dispose('Execution run stopped');
    await expect(stopA).resolves.toEqual({ decision: 'abort' });
    expect(await settledState(stopB)).toBe('pending');
    expect(await settledState(approvalB)).toBe('pending');

    runB.dispose('Test cleanup');
    await expect(stopB).resolves.toEqual({ decision: 'abort' });
    await expect(approvalB).resolves.toEqual({ decision: 'abort' });
    owner.reset();
  });

  it('does not replay a retired execution-run occurrence approval into its replacement', async () => {
    const session = new FakeSession();
    const owner = new CodexLikePermissionHandler({ session: session as any, logPrefix: '[ExecutionRun]' });
    const retired = createRunScopedExecutionPermissionHandler({ runId: 'run-resumed', handler: owner });

    const retiredApproval = retired.handler.handleToolCall('call_reused', 'Write', { path: '/tmp/same' });
    const retiredRequestId = Object.keys(session.agentState.requests)[0];
    const rpc = session.rpcHandlerManager.handlers.get('permission');
    expect(retiredRequestId).toBeDefined();
    expect(rpc).toBeDefined();
    await rpc!({ id: retiredRequestId, approved: true, decision: 'approved' });
    await expect(retiredApproval).resolves.toEqual({ decision: 'approved' });
    retired.dispose('Execution run occurrence retired');

    const replacement = createRunScopedExecutionPermissionHandler({ runId: 'run-resumed', handler: owner });
    const replacementApproval = replacement.handler.handleToolCall('call_reused', 'Write', { path: '/tmp/same' });
    const replacementRequestId = Object.keys(session.agentState.requests)[0];

    expect(replacementRequestId).toBeDefined();
    expect(replacementRequestId).not.toBe(retiredRequestId);
    expect(await settledState(replacementApproval)).toBe('pending');

    await rpc!({ id: retiredRequestId, approved: true, decision: 'approved' });
    expect(await settledState(replacementApproval)).toBe('pending');

    await rpc!({ id: replacementRequestId, approved: true, decision: 'approved' });
    await expect(replacementApproval).resolves.toEqual({ decision: 'approved' });

    replacement.dispose('Test cleanup');
    owner.reset();
  });

  it('uses each admitted execution-run policy instead of the parent session mode', async () => {
    const session = new FakeSession();
    const owner = new CodexLikePermissionHandler({ session: session as any, logPrefix: '[ExecutionRun]' });
    owner.setPermissionMode('yolo');

    const createDefaultRun = (runId: string) => {
      const scope = createRunScopedExecutionPermissionHandler({ runId, handler: owner });
      return {
        scope,
        handler: createExecutionRunPermissionHandler({
          backendId: 'codex',
          permissionMode: 'default',
          interactiveHandler: scope.handler,
        }),
      };
    };
    const runA = createDefaultRun('run-policy-a');
    const runB = createDefaultRun('run-policy-b');

    const approvalA = runA.handler.handleToolCall('call_1', 'Write', { path: '/tmp/a' });
    const approvalB = runB.handler.handleToolCall('call_1', 'Write', { path: '/tmp/b' });

    expect(await settledState(approvalA)).toBe('pending');
    expect(await settledState(approvalB)).toBe('pending');
    expect(Object.keys(session.agentState.requests)).toHaveLength(2);

    const rpc = session.rpcHandlerManager.handlers.get('permission');
    const requestIds = Object.keys(session.agentState.requests);
    await rpc!({ id: requestIds[0], approved: true, decision: 'approved' });
    await rpc!({ id: requestIds[1], approved: false, decision: 'denied' });
    await expect(approvalA).resolves.toEqual({ decision: 'approved' });
    await expect(approvalB).resolves.toEqual({ decision: 'denied' });

    runA.scope.dispose('Test cleanup');
    runB.scope.dispose('Test cleanup');
    owner.reset();
  });

  it('keeps an admitted default execution run interactive under a read-only parent session', async () => {
    const session = new FakeSession();
    const owner = new CodexLikePermissionHandler({ session: session as any, logPrefix: '[ExecutionRun]' });
    owner.setPermissionMode('read-only');
    const scope = createRunScopedExecutionPermissionHandler({ runId: 'run-default', handler: owner });
    const handler = createExecutionRunPermissionHandler({
      backendId: 'codex',
      permissionMode: 'default',
      interactiveHandler: scope.handler,
    });

    const approval = handler.handleToolCall('call_1', 'Write', { path: '/tmp/default' });

    expect(await settledState(approval)).toBe('pending');
    const requestId = Object.keys(session.agentState.requests)[0];
    const rpc = session.rpcHandlerManager.handlers.get('permission');
    await rpc!({ id: requestId, approved: true, decision: 'approved' });
    await expect(approval).resolves.toEqual({ decision: 'approved' });

    scope.dispose('Test cleanup');
    owner.reset();
  });

  it('resolves every duplicate same-id waiter when permission mode clears the prompt', async () => {
    const session = new FakeSession();
    const handler = new CodexLikePermissionHandler({ session: session as any, logPrefix: '[Test]' });
    const input = { command: 'echo hello' };

    const first = handler.handleToolCall('tool-mode-clear', 'bash', input);
    const second = handler.handleToolCall('tool-mode-clear', 'bash', input);

    expect(Object.keys(session.agentState.requests)).toEqual(['tool-mode-clear']);

    handler.setPermissionMode('read-only', 10);

    await expect(second).resolves.toEqual({ decision: 'denied' });
    expect(await settledState(first)).toBe('fulfilled');
    await expect(first).resolves.toEqual({ decision: 'denied' });
    expect(session.agentState.requests['tool-mode-clear']).toBeUndefined();
    expect(session.agentState.completedRequests['tool-mode-clear']).toEqual(
      expect.objectContaining({
        tool: 'bash',
        status: 'denied',
        decision: 'denied',
      }),
    );
  });

  it('auto-approves write-like tools in yolo mode', async () => {
    const session = new FakeSession();
    const handler = new CodexLikePermissionHandler({ session: session as any, logPrefix: '[Test]' });
    handler.setPermissionMode('yolo');

    const result = await handler.handleToolCall('tool-1', 'Write', { path: '/tmp/x', content: 'hi' });
    expect(result.decision).toBe('approved_for_session');
  });

  it('refuses claimed request IDs before yolo or legacy-allowlist auto decisions', async () => {
    const session = new FakeSession();
    const input = { path: '/tmp/x', content: 'hi' };
    const opaqueClaim = { malformed: { future: true } };
    session.agentState.requests['claimed-yolo'] = {
      tool: 'Write',
      arguments: input,
      createdAt: 1,
      permissionResponseClaimV1: opaqueClaim,
    };
    session.agentState.requests['claimed-allowlist'] = {
      tool: 'Write',
      arguments: input,
      createdAt: 2,
      permissionResponseClaimV1: opaqueClaim,
    };
    session.agentState.completedRequests.seed = {
      tool: 'Write',
      arguments: input,
      createdAt: 0,
      completedAt: 0,
      status: 'approved',
      decision: 'approved_for_session',
      allowedTools: ['Write'],
    };
    const handler = new CodexLikePermissionHandler({ session: session as any, logPrefix: '[Test]' });

    handler.setPermissionMode('yolo');
    await expect(handler.handleToolCall('claimed-yolo', 'Write', input)).rejects.toThrow(/reserved/i);
    handler.setPermissionMode('default');
    await expect(handler.handleToolCall('claimed-allowlist', 'Write', input)).rejects.toThrow(/reserved/i);

    for (const requestId of ['claimed-yolo', 'claimed-allowlist']) {
      const retained = session.agentState.requests[requestId] as Record<string, unknown>;
      expect(Object.prototype.hasOwnProperty.call(retained, 'permissionResponseClaimV1')).toBe(true);
      expect(retained.permissionResponseClaimV1).toBe(opaqueClaim);
      expect(session.agentState.completedRequests[requestId]).toBeUndefined();
    }
  });

  it('auto-approves write-like tools in bypassPermissions mode', async () => {
    const session = new FakeSession();
    const handler = new CodexLikePermissionHandler({ session: session as any, logPrefix: '[Test]' });
    handler.setPermissionMode('bypassPermissions');

    const result = await handler.handleToolCall('tool-1', 'Write', { path: '/tmp/x', content: 'hi' });
    expect(result.decision).toBe('approved_for_session');
  });

  it('auto-approves session_title_set in default mode without prompting', async () => {
    const session = new FakeSession();
    const handler = new CodexLikePermissionHandler({ session: session as any, logPrefix: '[Test]' });

    const result = await handler.handleToolCall('tool-1', 'mcp__happier__session_title_set', { title: 'Renamed' });

    expect(result.decision).toBe('approved');
    expect(session.agentState.requests['tool-1']).toBeUndefined();
    expect(session.agentState.completedRequests['tool-1']).toEqual(
      expect.objectContaining({
        tool: 'mcp__happier__session_title_set',
        status: 'approved',
        decision: 'approved',
      }),
    );
  });

  it('auto-approves safe first-party Action transport calls in default mode', async () => {
    const session = new FakeSession();
    const handler = new CodexLikePermissionHandler({ session: session as any, logPrefix: '[Test]' });

    await expect(handler.handleToolCall(
      'observe-direct',
      'mcp__happier__execution_run_wait',
      { runId: 'run-1' },
    )).resolves.toEqual({ decision: 'approved' });
    await expect(handler.handleToolCall(
      'observe-dynamic',
      'mcp__happier__action_execute',
      { actionId: 'execution.run.get', input: { runId: 'run-1' } },
    )).resolves.toEqual({ decision: 'approved' });
    await expect(handler.handleToolCall(
      'write-dynamic',
      'mcp__happier__action_execute',
      { actionId: 'execution.run.start', input: {} },
    )).resolves.toEqual({ decision: 'approved' });

    const unknown = handler.handleToolCall(
      'unknown-dynamic',
      'mcp__happier__action_execute',
      { actionId: 'not.a.known.action', input: {} },
    );
    expect(session.agentState.requests['unknown-dynamic']).toBeDefined();
    await session.rpcHandlerManager.handlers.get('permission')?.({
      id: 'unknown-dynamic',
      approved: false,
      decision: 'denied',
    });
    await expect(unknown).resolves.toEqual({ decision: 'denied' });
  });

  it('does not use the tool call id or a tool-name substring as authority', async () => {
    const session = new FakeSession();
    const handler = new CodexLikePermissionHandler({ session: session as any, logPrefix: '[Test]' });
    handler.setPermissionMode('read-only');

    await expect(
      handler.handleToolCall('call_think_9f2', 'bash', { command: 'touch /tmp/happier-pwn' }),
    ).resolves.toEqual({ decision: 'denied' });
    await expect(
      handler.handleToolCall('ordinary-id', 'rethinking_write', {}),
    ).resolves.toEqual({ decision: 'denied' });
  });

  it('auto-approves first-party Happier MCP tools when Happier action approval is required', async () => {
    const session = new FakeSession();
    const handler = new CodexLikePermissionHandler({
      session: session as any,
      logPrefix: '[Test]',
      getAccountSettings: () => ({
        actionsSettingsV1: {
          v: 1,
          actions: {
            'session.list': {
              disabledSurfaces: [],
              approvalRequiredSurfaces: ['session_agent'],
            },
          },
        },
      } as any),
    });

    await expect(handler.handleToolCall('tool-happier-approval', 'mcp__happier__session_list', {})).resolves.toEqual({
      decision: 'approved',
    });
    expect(session.agentState.requests['tool-happier-approval']).toBeUndefined();

    const pending = handler.handleToolCall('tool-custom-mcp', 'mcp__custom__session_list', {});
    expect(session.agentState.requests['tool-custom-mcp']).toEqual(
      expect.objectContaining({ tool: 'mcp__custom__session_list' }),
    );
    await session.rpcHandlerManager.handlers.get('permission')?.({
      id: 'tool-custom-mcp',
      approved: true,
      decision: 'approved',
    });
    await expect(pending).resolves.toEqual({ decision: 'approved' });
  });

  it('denies session_title_set when coding prompt title updates are disabled', async () => {
    const session = new FakeSession();
    const handler = new CodexLikePermissionHandler({
      session: session as any,
      logPrefix: '[Test]',
      getAccountSettings: () => ({
        codingPromptBehaviorV1: {
          v: 1,
          sessionTitleUpdates: 'disabled',
          responseOptions: 'agent',
        },
      } as any),
    });

    const result = await handler.handleToolCall('tool-1', 'mcp__happier__session_title_set', { title: 'Renamed' });

    expect(result.decision).toBe('denied');
    expect(session.agentState.requests['tool-1']).toBeUndefined();
    expect(session.agentState.completedRequests['tool-1']).toEqual(
      expect.objectContaining({
        tool: 'mcp__happier__session_title_set',
        status: 'denied',
        decision: 'denied',
      }),
    );
  });

  it('denies Happier shell-bridge title calls when coding prompt title updates are disabled', async () => {
    const session = new FakeSession();
    const handler = new CodexLikePermissionHandler({
      session: session as any,
      logPrefix: '[Test]',
      getAccountSettings: () => ({
        codingPromptBehaviorV1: {
          v: 1,
          sessionTitleUpdates: 'disabled',
          responseOptions: 'agent',
        },
      } as any),
    });

    const result = await handler.handleToolCall('tool-1', 'Bash', {
      command:
        `happier tools call --session-id cmmfivqgm002d8o1ug15b02o1 --directory /tmp/workspace ` +
        `--source happier --tool change_title --args-json '{"title":"Blocked"}' --json`,
    });

    expect(result.decision).toBe('denied');
    expect(session.agentState.requests['tool-1']).toBeUndefined();
    expect(session.agentState.completedRequests['tool-1']).toEqual(
      expect.objectContaining({
        tool: 'Bash',
        status: 'denied',
        decision: 'denied',
      }),
    );
  });

  it('treats setPermissionMode without updatedAt as provisional when newer metadata exists', async () => {
    const session = new FakeSession();
    session.setMetadataSnapshot({ permissionMode: 'yolo', permissionModeUpdatedAt: 10 });
    const handler = new CodexLikePermissionHandler({ session: session as any, logPrefix: '[Test]' });

    handler.setPermissionMode('read-only');
    const result = await handler.handleToolCall('tool-1', 'Write', { path: '/tmp/x', content: 'hi' });

    expect(result.decision).toBe('approved_for_session');
  });

  it('does not let older metadata override an explicit newer setPermissionMode', async () => {
    const session = new FakeSession();
    session.setMetadataSnapshot({ permissionMode: 'yolo', permissionModeUpdatedAt: 10 });
    const handler = new CodexLikePermissionHandler({ session: session as any, logPrefix: '[Test]' });

    handler.setPermissionMode('read-only', 20);
    const result = await handler.handleToolCall('tool-1', 'Write', { path: '/tmp/x', content: 'hi' });

    expect(result.decision).toBe('denied');
  });

  it('keeps read-only deny strict even after approved_for_session history', async () => {
    const session = new FakeSession();
    const handler = new CodexLikePermissionHandler({ session: session as any, logPrefix: '[Test]' });

    handler.setPermissionMode('safe-yolo');
    const firstCall = handler.handleToolCall('tool-1', 'Write', { path: '/tmp/x', content: 'hi' });
    const rpc = session.rpcHandlerManager.handlers.get('permission');
    await rpc!({ id: 'tool-1', approved: true, decision: 'approved_for_session' });
    await expect(firstCall).resolves.toEqual({ decision: 'approved_for_session' });

    handler.setPermissionMode('read-only', 100);
    const result = await handler.handleToolCall('tool-2', 'Write', { path: '/tmp/x', content: 'hi' });
    expect(result.decision).toBe('denied');
  });

  it('resolves pending permission requests when permission mode changes to read-only', async () => {
    const session = new FakeSession();
    const handler = new CodexLikePermissionHandler({ session: session as any, logPrefix: '[Test]' });

    const promise = handler.handleToolCall('tool-1', 'bash', { command: 'echo hi' });
    expect(session.agentState.requests['tool-1']).toBeTruthy();

    handler.setPermissionMode('read-only', 10);

    const result = await promise;
    expect(result.decision).toBe('denied');
    expect(session.agentState.requests).toEqual({});
    expect(session.agentState.completedRequests['tool-1']).toEqual(
      expect.objectContaining({
        tool: 'bash',
        status: 'denied',
        decision: 'denied',
      }),
    );
  });

  it('keeps the provider pending and permits retry when request settlement fails', async () => {
    const session = new FakeSession();
    let failing = true;
    session.updateAgentState = async () => {
      if (failing) throw new Error('updateAgentState failed');
    };
    const handler = new CodexLikePermissionHandler({ session: session as any, logPrefix: '[Test]' });

    const onUnhandled = vi.fn();
      process.on('unhandledRejection', onUnhandled);
    try {
      const promise = handler.handleToolCall('tool-1', 'bash', { command: 'echo hi' });

      handler.setPermissionMode('read-only', 10);

      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(await settledState(promise)).toBe('pending');
      failing = false;
      session.updateAgentState = (updater) => {
        session.agentState = updater(session.agentState);
        return session.agentState;
      };
      const respond = session.rpcHandlerManager.handlers.get('permission')!;
      await respond({ id: 'tool-1', approved: false, decision: 'denied' });
      await expect(promise).resolves.toEqual({ decision: 'denied' });

      // Give Node a chance to surface an unhandled rejection if one was created.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(onUnhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('auto-approves a locally generated Happier tools shell-bridge command in default mode', async () => {
    const session = new FakeSession();
    const handler = new CodexLikePermissionHandler({ session: session as any, logPrefix: '[Test]' });
    const { buildHappierToolsShellBridgeCommand } = await import(
      '@/agent/tools/happierTools/runtime/buildHappierToolsShellBridgeCommand'
    );

    const result = await handler.handleToolCall('tool-1', 'Bash', {
      command: buildHappierToolsShellBridgeCommand([
        'call',
        '--session-id',
        'cmmfivqgm002d8o1ug15b02o1',
        '--directory',
        '/tmp/workspace',
        '--source',
        'happier',
        '--tool',
        'change_title',
        '--args-json',
        '{"title":"Kimi Fresh QA Title"}',
        '--json',
      ]),
    });

    expect(result.decision).toBe('approved');
    expect(session.agentState.requests['tool-1']).toBeUndefined();
    expect(session.agentState.completedRequests['tool-1']).toEqual(
      expect.objectContaining({
        tool: 'Bash',
        status: 'approved',
        decision: 'approved',
      }),
    );
  });

  it('auto-approves a locally generated Happier tools shell-bridge command even in read-only mode', async () => {
    const session = new FakeSession();
    const handler = new CodexLikePermissionHandler({ session: session as any, logPrefix: '[Test]' });
    handler.setPermissionMode('read-only');
    const { buildHappierToolsShellBridgeCommand } = await import(
      '@/agent/tools/happierTools/runtime/buildHappierToolsShellBridgeCommand'
    );

    const result = await handler.handleToolCall('tool-1', 'bash', {
      command: buildHappierToolsShellBridgeCommand([
        'list',
        '--session-id',
        'cmmfivqgm002d8o1ug15b02o1',
        '--directory',
        '/tmp/workspace',
        '--json',
      ]),
    });

    expect(result.decision).toBe('approved');
    expect(session.agentState.requests['tool-1']).toBeUndefined();
    expect(session.agentState.completedRequests['tool-1']).toEqual(
      expect.objectContaining({
        tool: 'bash',
        status: 'approved',
        decision: 'approved',
      }),
    );
  });

  it('does not auto-approve an attacker-selected bridge launcher or compound command', async () => {
    const session = new FakeSession();
    const handler = new CodexLikePermissionHandler({ session: session as any, logPrefix: '[Test]' });
    handler.setPermissionMode('read-only');

    await expect(
      handler.handleToolCall('tool-untrusted-launcher', 'bash', {
        command: `node ./happier-helper.js tools call --source happier --tool save_memory --args-json '{}' --json`,
      }),
    ).resolves.toEqual({ decision: 'denied' });
    await expect(
      handler.handleToolCall('tool-compound', 'bash', {
        command: `happier tools list --json; touch /tmp/happier-pwn`,
      }),
    ).resolves.toEqual({ decision: 'denied' });
  });

  it('prompts for Happier shell-bridge calls with non-vetted custom sources in default mode', async () => {
    const session = new FakeSession();
    const handler = new CodexLikePermissionHandler({ session: session as any, logPrefix: '[Test]' });

    const promise = handler.handleToolCall('tool-1', 'bash', {
      command:
        `happier tools call --session-id cmmfivqgm002d8o1ug15b02o1 --directory /tmp/workspace ` +
        `--source qa_marker_stdio_20260306 --tool get_marker --args-json '{}' --json`,
    });

    expect(session.agentState.requests['tool-1']).toEqual(
      expect.objectContaining({
        tool: 'bash',
      }),
    );

    const rpc = session.rpcHandlerManager.handlers.get('permission');
    expect(rpc).toBeDefined();
    await rpc!({ id: 'tool-1', approved: true, decision: 'approved' });

    await expect(promise).resolves.toEqual({ decision: 'approved' });
  });

  it('prompts for non-vetted internal Happier shell-bridge tools in default mode', async () => {
    const session = new FakeSession();
    const handler = new CodexLikePermissionHandler({ session: session as any, logPrefix: '[Test]' });

    const promise = handler.handleToolCall('tool-1', 'bash', {
      command:
        `happier tools call --session-id cmmfivqgm002d8o1ug15b02o1 --directory /tmp/workspace ` +
        `--source happier --tool action_execute --args-json '{"actionId":"dangerous.action"}' --json`,
    });

    expect(session.agentState.requests['tool-1']).toEqual(
      expect.objectContaining({
        tool: 'bash',
      }),
    );

    const rpc = session.rpcHandlerManager.handlers.get('permission');
    expect(rpc).toBeDefined();
    await rpc!({ id: 'tool-1', approved: false, decision: 'denied' });

    await expect(promise).resolves.toEqual({ decision: 'denied' });
  });
});
