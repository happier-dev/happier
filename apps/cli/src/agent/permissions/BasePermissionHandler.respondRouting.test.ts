import { describe, expect, it } from 'vitest';

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
}

describe('BasePermissionHandler permission-response routing (gap 28/29)', () => {
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

  it('exposes a typed routing outcome via respondToPendingPermission', async () => {
    const session = new FakeSession();
    const handler = new CodexLikePermissionHandler({ session: session as any, logPrefix: '[Test]' });
    handler.setPermissionMode('safe-yolo');

    expect(handler.respondToPendingPermission({ id: 'unknown', approved: true })).toEqual({ status: 'not_found' });

    const promise = handler.handleToolCall('tool-2', 'Write', { path: '/tmp/y', content: 'hi' });
    expect(handler.respondToPendingPermission({ id: 'tool-2', approved: true, decision: 'approved' })).toEqual({
      status: 'resolved',
    });
    expect((await promise).decision).toBe('approved');
  });
});
