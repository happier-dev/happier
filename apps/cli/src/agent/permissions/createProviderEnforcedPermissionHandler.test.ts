import { describe, expect, it } from 'vitest';

import { createProviderEnforcedPermissionHandler } from './createProviderEnforcedPermissionHandler';

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

describe('createProviderEnforcedPermissionHandler', () => {
  it('creates a provider-enforced handler with optional safe-tool extensions', async () => {
    const session = new FakeSession();
    const handler = createProviderEnforcedPermissionHandler({
      session: session as any,
      logPrefix: '[TestProvider]',
      alwaysAutoApproveToolNameIncludes: ['geminireasoning'],
    });

    expect((handler as any).alwaysAutoApproveToolNameIncludes).toContain('geminireasoning');
    await expect(handler.handleToolCall('safe-1', 'think', {})).resolves.toEqual({ decision: 'approved' });

    const pending = handler.handleToolCall('pending-1', 'Edit', {});
    expect(session.agentState.requests['pending-1']).toBeTruthy();
    const pendingReq = (handler as any).pendingRequests.get('pending-1');
    expect(pendingReq).toBeTruthy();
    pendingReq?.resolve({ decision: 'denied' });
    await expect(pending).resolves.toEqual({ decision: 'denied' });
  });
});
