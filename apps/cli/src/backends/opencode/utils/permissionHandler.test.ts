import { describe, expect, it } from 'vitest';

import { OpenCodePermissionHandler } from './permissionHandler';

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

  getAgentStateSnapshot() {
    return this.agentState;
  }

  updateAgentState(updater: any) {
    this.agentState = updater(this.agentState);
    return this.agentState;
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return await Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs)),
  ]);
}

describe('OpenCodePermissionHandler', () => {
  it('prompts for external_directory in safe-yolo mode', async () => {
    const session = new FakeSession();
    const handler = new OpenCodePermissionHandler(session as any);
    handler.setPermissionMode('safe-yolo');

    const promise = handler.handleToolCall('tool-1', 'external_directory', { path: '/outside' });
    expect(session.agentState.requests['tool-1']).toEqual(expect.objectContaining({ tool: 'external_directory' }));

    const rpc = session.rpcHandlerManager.handlers.get('permission');
    expect(rpc).toBeDefined();
    await rpc!({ id: 'tool-1', approved: true, decision: 'approved' });

    const result = await withTimeout(promise, 50);
    expect(result.decision).toBe('approved');
  });

  it('denies external_directory in read-only mode', async () => {
    const session = new FakeSession();
    const handler = new OpenCodePermissionHandler(session as any);
    handler.setPermissionMode('read-only');

    const result = await handler.handleToolCall('tool-1', 'external_directory', { path: '/outside' });
    expect(result.decision).toBe('denied');
    expect(session.agentState.requests['tool-1']).toBeUndefined();
    expect(session.agentState.completedRequests['tool-1']).toEqual(expect.objectContaining({ tool: 'external_directory', status: 'denied' }));
  });

  it('auto-approves external_directory in yolo mode', async () => {
    const session = new FakeSession();
    const handler = new OpenCodePermissionHandler(session as any);
    handler.setPermissionMode('yolo');

    const result = await handler.handleToolCall('tool-1', 'external_directory', { path: '/outside' });
    expect(result.decision).toBe('approved_for_session');
    expect(session.agentState.requests['tool-1']).toBeUndefined();
    expect(session.agentState.completedRequests['tool-1']).toEqual(expect.objectContaining({ tool: 'external_directory', status: 'approved' }));
  });
});

