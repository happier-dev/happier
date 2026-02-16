import { describe, expect, it, vi } from 'vitest';

import { CodexLikePermissionHandler } from './CodexLikePermissionHandler';

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

  getAgentStateSnapshot() {
    return this.agentState;
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

describe('CodexLikePermissionHandler', () => {
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

  it('auto-approves write-like tools in yolo mode', async () => {
    const session = new FakeSession();
    const handler = new CodexLikePermissionHandler({ session: session as any, logPrefix: '[Test]' });
    handler.setPermissionMode('yolo');

    const result = await handler.handleToolCall('tool-1', 'Write', { path: '/tmp/x', content: 'hi' });
    expect(result.decision).toBe('approved_for_session');
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

  it('does not emit unhandledRejection when updateAgentState rejects while resolving pending requests', async () => {
    const session = new FakeSession();
    session.updateAgentState = async () => {
      throw new Error('updateAgentState failed');
    };
    const handler = new CodexLikePermissionHandler({ session: session as any, logPrefix: '[Test]' });

    const onUnhandled = vi.fn();
      process.on('unhandledRejection', onUnhandled);
    try {
      const promise = handler.handleToolCall('tool-1', 'bash', { command: 'echo hi' });

      handler.setPermissionMode('read-only', 10);

      await expect(promise).resolves.toEqual({ decision: 'denied' });

      // Give Node a chance to surface an unhandled rejection if one was created.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(onUnhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
