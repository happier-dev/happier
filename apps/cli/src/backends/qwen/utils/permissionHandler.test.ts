import { describe, expect, it } from 'vitest';

import { QwenPermissionHandler } from './permissionHandler';

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

describe('QwenPermissionHandler', () => {
  it('denies write-like tools in read-only mode', async () => {
    const session = new FakeSession();
    const handler = new QwenPermissionHandler(session as any);
    handler.setPermissionMode('read-only');

    const result = await handler.handleToolCall('tool-1', 'Write', { path: '/tmp/x', content: 'hi' });
    expect(result.decision).toBe('denied');
    expect(session.agentState.requests['tool-1']).toBeUndefined();
    expect(session.agentState.completedRequests['tool-1']).toEqual(expect.objectContaining({ tool: 'Write', status: 'denied' }));
  });

  it('auto-approves in yolo mode', async () => {
    const session = new FakeSession();
    const handler = new QwenPermissionHandler(session as any);
    handler.setPermissionMode('yolo');

    const result = await handler.handleToolCall('tool-1', 'Write', { path: '/tmp/x', content: 'hi' });
    expect(result.decision).toBe('approved_for_session');
    expect(session.agentState.requests['tool-1']).toBeUndefined();
    expect(session.agentState.completedRequests['tool-1']).toEqual(expect.objectContaining({ tool: 'Write', status: 'approved' }));
  });
});

