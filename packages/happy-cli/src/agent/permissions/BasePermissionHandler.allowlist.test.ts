import { describe, it, expect } from 'vitest';
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
    return new Promise<PermissionResult>((resolve, reject) => {
      this.pendingRequests.set(toolCallId, { resolve, reject, toolName, input });
      this.addPendingRequestToState(toolCallId, toolName, input);
    });
  }

  isAllowed(toolName: string, input: unknown): boolean {
    return this.isAllowedForSession(toolName, input);
  }
}

describe('BasePermissionHandler allowlist', () => {
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
});
