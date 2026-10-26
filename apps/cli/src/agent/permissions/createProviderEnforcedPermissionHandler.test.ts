import { SESSION_RPC_METHODS } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import { createOfflineSessionStub } from '@/api/offline/offlineSessionStub';

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

  async updateAgentStateRequestSettlement(updater: Parameters<FakeSession['updateAgentState']>[0]): Promise<void> {

    await this.updateAgentState(updater);

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

    await expect(handler.handleToolCall('safe-extension', 'geminireasoning', {}))
      .resolves.toEqual({ decision: 'approved' });
    await expect(handler.handleToolCall('safe-1', 'think', {})).resolves.toEqual({ decision: 'approved' });

    const pending = handler.handleToolCall('pending-1', 'Edit', {});
    expect(session.agentState.requests['pending-1']).toBeTruthy();
    const respond = session.rpcHandlerManager.handlers.get('permission');
    if (!respond) throw new Error('Permission RPC was not registered');
    await respond({ id: 'pending-1', approved: false, decision: 'denied' });
    await expect(pending).resolves.toEqual({ decision: 'denied' });
  });

  it('binds permission responses on the offline session stub a provider starts with', () => {
    // Providers start on this stub when the server is unreachable and swap sessions later.
    const session = createOfflineSessionStub('permission-offline');
    createProviderEnforcedPermissionHandler({ session, logPrefix: '[TestProvider]' });

    expect(session.rpcHandlerManager.hasHandler(SESSION_RPC_METHODS.SESSION_PERMISSION_RESPOND_LEGACY)).toBe(true);
    expect(session.rpcHandlerManager.hasHandler(SESSION_RPC_METHODS.SESSION_STRUCTURED_QUESTION_RESPOND_V1)).toBe(true);
  });
});
