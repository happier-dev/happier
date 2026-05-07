import { describe, it, expect, vi } from 'vitest';
import { BasePermissionHandler, type PermissionResult } from './BasePermissionHandler';

class FakeRpcHandlerManager {
  handlers = new Map<string, (payload: any) => any>();
  registerHandler(_name: string, handler: any) {
    this.handlers.set(_name, handler);
  }
}

class FakeSession {
  rpcHandlerManager = new FakeRpcHandlerManager();
  agentState: any = { requests: {}, completedRequests: {} };

  getAgentStateSnapshot() {
    return this.agentState;
  }

  updateAgentState(updater: any) {
    this.agentState = updater(this.agentState);
    return this.agentState;
  }
}

class TestPermissionHandler extends BasePermissionHandler {
  protected getLogPrefix(): string {
    return '[Test]';
  }

  request(toolCallId: string, toolName: string, input: unknown): Promise<PermissionResult> {
    return this.requestPermissionDecision(toolCallId, toolName, input);
  }

  requestLegacyWithoutAgentState(toolCallId: string, toolName: string, input: unknown): Promise<PermissionResult> {
    return new Promise<PermissionResult>((resolve, reject) => {
      this.pendingRequests.set(toolCallId, { resolve, reject, toolName, input });
    });
  }

  isAllowed(toolName: string, input: unknown): boolean {
    return this.isAllowedForSession(toolName, input);
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

describe('BasePermissionHandler allowlist', () => {
  it('records the request kind for interactive tool prompts vs permissions', async () => {
    const session = new FakeSession();
    const handler = new TestPermissionHandler(session as any);

    const askPromise = handler.request('perm-ask', 'AskUserQuestion', { questions: [] });
    expect(session.agentState.requests['perm-ask']).toEqual(
      expect.objectContaining({ tool: 'AskUserQuestion', kind: 'user_action' }),
    );

    const bashPromise = handler.request('perm-bash', 'Bash', { command: ['bash', '-lc', 'echo hello'] });
    expect(session.agentState.requests['perm-bash']).toEqual(
      expect.objectContaining({ tool: 'Bash', kind: 'permission' }),
    );

    handler.reset();
    await expect(askPromise).rejects.toThrow('Session reset');
    await expect(bashPromise).rejects.toThrow('Session reset');
  });

  it('finalizes agentState requests even when the pending request map is missing the entry (lifecycle mismatch)', async () => {
    const session = new FakeSession();
    // Simulate a permission prompt that exists in UI state, but the handler has lost the pending promise
    // (e.g. reconnect/race/reset). If we ignore the response, the UI can stay stuck forever.
    session.agentState.requests['perm-1'] = {
      tool: 'bash',
      arguments: { command: ['bash', '-lc', 'echo hello'] },
      createdAt: Date.now(),
    };

    const handler = new TestPermissionHandler(session as any);

    const rpc = session.rpcHandlerManager.handlers.get('permission');
    expect(rpc).toBeDefined();

    await rpc!({ id: 'perm-1', approved: false, decision: 'denied' });

    expect(session.agentState.requests['perm-1']).toBeUndefined();
    expect(session.agentState.completedRequests['perm-1']).toEqual(
      expect.objectContaining({
        tool: 'bash',
        status: 'denied',
        decision: 'denied',
        completedAt: expect.any(Number),
      })
    );
  });

  it('derives per-session allow tools for approved_for_session even when finalizing a stale response (no pending promise)', async () => {
    const session = new FakeSession();
    const input = { command: ['bash', '-lc', 'echo hello'] };
    session.agentState.requests['perm-1'] = {
      tool: 'bash',
      arguments: input,
      createdAt: Date.now(),
    };

    const handler = new TestPermissionHandler(session as any);
    const rpc = session.rpcHandlerManager.handlers.get('permission');
    expect(rpc).toBeDefined();

    await rpc!({ id: 'perm-1', approved: true, decision: 'approved_for_session' });

    expect(handler.isAllowed('bash', input)).toBe(true);
    expect(session.agentState.requests['perm-1']).toBeUndefined();
    expect(session.agentState.completedRequests['perm-1']).toEqual(
      expect.objectContaining({
        decision: 'approved_for_session',
        status: 'approved',
        allowedTools: ['bash(echo hello)'],
      }),
    );
  });

  it('ignores legacy pending responses that are not correlated with agentState', async () => {
    const session = new FakeSession();
    const input = { command: ['bash', '-lc', 'echo hello'] };
    const handler = new TestPermissionHandler(session as any);
    const pending = handler.requestLegacyWithoutAgentState('legacy-missing-state', 'bash', input);

    const rpc = session.rpcHandlerManager.handlers.get('permission');
    expect(rpc).toBeDefined();

    await rpc!({ id: 'legacy-missing-state', approved: true, decision: 'approved_for_session' });

    expect(handler.isAllowed('bash', input)).toBe(false);
    expect(session.agentState.completedRequests['legacy-missing-state']).toBeUndefined();
    expect(await settledState(pending)).toBe('pending');
    handler.reset();
    await expect(pending).rejects.toThrow('Session reset');
  });

  it('remembers approved_for_session tool identifiers and clears them on reset', async () => {
    const session = new FakeSession();
    const handler = new TestPermissionHandler(session as any);

    const input = { command: ['bash', '-lc', 'echo hello'] };
    const promise = handler.request('perm-1', 'bash', input);

    const rpc = session.rpcHandlerManager.handlers.get('permission');
    expect(rpc).toBeDefined();
    await rpc!({ id: 'perm-1', approved: true, decision: 'approved_for_session' });

    const result = await promise;
    expect(result.decision).toBe('approved_for_session');
    expect(handler.isAllowed('bash', input)).toBe(true);

    handler.reset();
    expect(handler.isAllowed('bash', input)).toBe(false);
  });

  it('resolves every duplicate same-id waiter from one permission response', async () => {
    const session = new FakeSession();
    const handler = new TestPermissionHandler(session as any);
    const input = { command: ['bash', '-lc', 'echo hello'] };

    const first = handler.request('perm-duplicate', 'bash', input);
    const second = handler.request('perm-duplicate', 'bash', input);

    expect(Object.keys(session.agentState.requests)).toEqual(['perm-duplicate']);

    const rpc = session.rpcHandlerManager.handlers.get('permission');
    expect(rpc).toBeDefined();
    await rpc!({ id: 'perm-duplicate', approved: true, decision: 'approved' });

    await expect(second).resolves.toEqual({ decision: 'approved' });
    expect(await settledState(first)).toBe('fulfilled');
    await expect(first).resolves.toEqual({ decision: 'approved' });
    expect(session.agentState.requests['perm-duplicate']).toBeUndefined();
    expect(session.agentState.completedRequests['perm-duplicate']).toEqual(
      expect.objectContaining({
        tool: 'bash',
        status: 'approved',
        decision: 'approved',
      }),
    );
  });

  it('applies updatedPermissions addRules to the allowlist (for Claude-style permission updates)', async () => {
    const session = new FakeSession();
    const handler = new TestPermissionHandler(session as any);

    const input = { command: ['bash', '-lc', 'find . -maxdepth 2 -type f | head -n 5'] };
    const promise = handler.request('perm-1', 'Bash', input);

    const rpc = session.rpcHandlerManager.handlers.get('permission');
    expect(rpc).toBeDefined();
    await rpc!({
      id: 'perm-1',
      approved: true,
      updatedPermissions: [
        {
          type: 'addRules',
          behavior: 'allow',
          destination: 'session',
          rules: [{ toolName: 'Bash', ruleContent: 'find:*' }],
        },
      ],
    });

    await promise;

    expect(handler.isAllowed('Bash', { command: ['bash', '-lc', 'find . -maxdepth 1 -type f'] })).toBe(true);

    const completed = session.agentState.completedRequests['perm-1'];
    expect(completed).toBeTruthy();
    expect(completed.updatedPermissions).toBeTruthy();

    // A fresh handler instance should seed the allowlist from completedRequests.
    const handler2 = new TestPermissionHandler(session as any);
    expect(handler2.isAllowed('Bash', { command: ['bash', '-lc', 'find . -maxdepth 1 -type f'] })).toBe(true);
  });

  it('auto-approves other pending permission prompts once an allowlist update makes them allowed', async () => {
    const session = new FakeSession();
    const handler = new TestPermissionHandler(session as any);

    const input1 = { command: ['bash', '-lc', 'find . -maxdepth 2 -type f | head -n 5'] };
    const input2 = { command: ['bash', '-lc', 'find . -maxdepth 1 -type f | head -n 5'] };
    const p1 = handler.request('perm-1', 'Bash', input1);
    const p2 = handler.request('perm-2', 'Bash', input2);

    const rpc = session.rpcHandlerManager.handlers.get('permission');
    expect(rpc).toBeDefined();

    await rpc!({
      id: 'perm-1',
      approved: true,
      updatedPermissions: [
        {
          type: 'addRules',
          behavior: 'allow',
          destination: 'session',
          rules: [{ toolName: 'Bash', ruleContent: 'find:*' }],
        },
      ],
    });

    await expect(p1).resolves.toEqual(expect.objectContaining({ decision: 'approved' }));

    const raced = await Promise.race([
      p2.then(() => 'resolved' as const),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 20)),
    ]);
    expect(raced).toBe('resolved');

    expect(session.agentState.requests['perm-2']).toBeUndefined();
    expect(session.agentState.completedRequests['perm-2']).toEqual(
      expect.objectContaining({
        tool: 'Bash',
        status: 'approved',
      }),
    );
  });

  it('ignores stale permission responses that do not match any agentState request (no allowlist updates, no auto-approvals)', async () => {
    const session = new FakeSession();
    const handler = new TestPermissionHandler(session as any);

    const pendingInput = { command: ['bash', '-lc', 'find . -maxdepth 1 -type f | head -n 5'] };
    const pendingPromise = handler.request('perm-2', 'Bash', pendingInput);

    const rpc = session.rpcHandlerManager.handlers.get('permission');
    expect(rpc).toBeDefined();

    // Response id does not exist in pendingRequests AND does not exist in agentState.requests.
    // We must fail closed: don't update allowlists and don't auto-approve unrelated prompts.
    await rpc!({
      id: 'perm-stale',
      approved: true,
      updatedPermissions: [
        {
          type: 'addRules',
          behavior: 'allow',
          destination: 'session',
          rules: [{ toolName: 'Bash', ruleContent: 'find:*' }],
        },
      ],
    });

    expect(handler.isAllowed('Bash', pendingInput)).toBe(false);
    expect(session.agentState.completedRequests['perm-stale']).toBeUndefined();

    const raced = await Promise.race([
      pendingPromise.then(() => 'resolved' as const),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 20)),
    ]);
    expect(raced).toBe('timeout');
    expect(session.agentState.requests['perm-2']).toBeTruthy();
  });

  it('returns structured answers for AskUserQuestion responses', async () => {
    const session = new FakeSession();
    const handler = new TestPermissionHandler(session as any);

    const input = { questions: [{ question: 'q1', choices: ['a', 'b'] }] };
    const promise = handler.request('perm-ask', 'AskUserQuestion', input);

    const rpc = session.rpcHandlerManager.handlers.get('permission');
    expect(rpc).toBeDefined();
    await rpc!({ id: 'perm-ask', approved: true, answers: { q1: 'a' } });

    const result = await promise;
    expect(result.decision).toBe('approved');
    expect((result as any).answers).toEqual({ q1: 'a' });
  });

  it('invokes onAbortRequested when user responds with abort', async () => {
    const session = new FakeSession();
    let aborted = false;
    const handler = new TestPermissionHandler(session as any, {
      onAbortRequested: () => {
        aborted = true;
      },
    });

    const promise = handler.request('perm-1', 'read', { filepath: '/tmp/x' });

    const rpc = session.rpcHandlerManager.handlers.get('permission');
    expect(rpc).toBeDefined();
    await rpc!({ id: 'perm-1', approved: false, decision: 'abort' });

    const result = await promise;
    expect(result.decision).toBe('abort');
    expect(aborted).toBe(true);
    expect(session.agentState.completedRequests['perm-1']).toEqual(
      expect.objectContaining({
        status: 'denied',
        decision: 'abort',
      })
    );
  });

  it('can suppress onAbortRequested callback for abort decisions', async () => {
    const session = new FakeSession();
    let aborted = false;
    const handler = new TestPermissionHandler(session as any, {
      onAbortRequested: () => {
        aborted = true;
      },
      triggerAbortCallbackOnAbortDecision: false,
    });

    const promise = handler.request('perm-1', 'read', { filepath: '/tmp/x' });

    const rpc = session.rpcHandlerManager.handlers.get('permission');
    expect(rpc).toBeDefined();
    await rpc!({ id: 'perm-1', approved: false, decision: 'abort' });

    const result = await promise;
    expect(result.decision).toBe('abort');
    expect(aborted).toBe(false);
  });

  it('does not auto-approve other pending requests when user responds with abort', async () => {
    const session = new FakeSession();
    const handler = new TestPermissionHandler(session as any);

    // Seed a session-wide allow rule so a later pending request would be eligible for auto-approval.
    const seed = handler.request('perm-seed', 'Bash', { command: ['bash', '-lc', 'find . -maxdepth 1 -type f | head -n 5'] });
    const rpc = session.rpcHandlerManager.handlers.get('permission');
    expect(rpc).toBeDefined();
    await rpc!({
      id: 'perm-seed',
      approved: true,
      updatedPermissions: [
        {
          type: 'addRules',
          behavior: 'allow',
          destination: 'session',
          rules: [{ toolName: 'Bash', ruleContent: 'find:*' }],
        },
      ],
    });
    await seed;

    const input1 = { command: ['bash', '-lc', 'find . -maxdepth 1 -type f | head -n 5'] };
    const input2 = { command: ['bash', '-lc', 'find . -maxdepth 1 -type f | head -n 5'] };

    const p1 = handler.request('perm-1', 'Bash', input1);
    const p2 = handler.request('perm-2', 'Bash', input2);

    await rpc!({ id: 'perm-1', approved: false, decision: 'abort' });
    await expect(p1).resolves.toEqual(expect.objectContaining({ decision: 'abort' }));

    const raced = await Promise.race([
      p2.then(() => 'resolved' as const),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 20)),
    ]);
    expect(raced).toBe('timeout');
    expect(session.agentState.requests['perm-2']).toBeDefined();
  });

  it('clears the allowlist when the session reference is updated', async () => {
    const session1 = new FakeSession();
    const handler = new TestPermissionHandler(session1 as any);

    const input = { command: ['bash', '-lc', 'echo hello'] };
    const promise = handler.request('perm-1', 'bash', input);

    const rpc1 = session1.rpcHandlerManager.handlers.get('permission');
    expect(rpc1).toBeDefined();
    await rpc1!({ id: 'perm-1', approved: true, decision: 'approved_for_session' });

    await promise;
    expect(handler.isAllowed('bash', input)).toBe(true);

    const session2 = new FakeSession();
    // Simulate a new session reference without persisted allowlist entries.
    session2.agentState = { requests: {}, completedRequests: {} };
    handler.updateSession(session2 as any);

    expect(handler.isAllowed('bash', input)).toBe(false);
  });

  it('does not emit unhandledRejection when updateAgentState rejects', async () => {
    const session = new FakeSession();
    session.updateAgentState = async () => {
      throw new Error('updateAgentState failed');
    };
    const handler = new TestPermissionHandler(session as any);

    const onUnhandled = vi.fn();
    process.on('unhandledRejection', onUnhandled);
    try {
      const promise = handler.request('perm-1', 'bash', { command: ['bash', '-lc', 'echo hello'] });
      const rpc = session.rpcHandlerManager.handlers.get('permission');
      await rpc!({ id: 'perm-1', approved: true, decision: 'approved' });
      await promise;

      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(onUnhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
