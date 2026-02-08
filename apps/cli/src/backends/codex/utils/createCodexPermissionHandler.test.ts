import { describe, expect, it } from 'vitest';

import { CodexPermissionHandler } from '@/backends/codex/utils/permissionHandler';
import { createCodexPermissionHandler } from './createCodexPermissionHandler';

class FakeRpcHandlerManager {
  handlers = new Map<string, (payload: any) => any>();
  registerHandler(name: string, handler: any) {
    this.handlers.set(name, handler);
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

describe('createCodexPermissionHandler', () => {
  it('returns a CodexPermissionHandler instance', () => {
    const handler = createCodexPermissionHandler({
      session: new FakeSession() as any,
      onAbortRequested: () => {},
    });

    expect(handler).toBeInstanceOf(CodexPermissionHandler);
  });
});
