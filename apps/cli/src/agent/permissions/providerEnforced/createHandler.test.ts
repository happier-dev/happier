import { describe, expect, it } from 'vitest';

import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { AcpPermissionHandler } from '@/agent/acp/permissions/acpPermissionHandler';
import { createProviderEnforcedPermissionHandler } from './createHandler';

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
  it('creates a provider-enforced handler with optional safe-tool plugins', async () => {
    const session = new FakeSession();
    const handler = createProviderEnforcedPermissionHandler({
      session: session as unknown as ApiSessionClient,
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

  it('exposes typed pending permission abort and flush support', async () => {
    const session = new FakeSession();
    let flushCount = 0;
    (session as unknown as { flush: () => Promise<void> }).flush = async () => {
      flushCount += 1;
    };

    const handler = createProviderEnforcedPermissionHandler({
      session: session as unknown as ApiSessionClient,
      logPrefix: '[TestProvider]',
    });
    const acpHandler: AcpPermissionHandler = handler;

    const pending = acpHandler.handleToolCall('pending-1', 'Edit', {});
    expect(session.agentState.requests['pending-1']).toBeTruthy();

    expect(acpHandler.abortPendingRequestsAndFlush).toBeTypeOf('function');
    if (!acpHandler.abortPendingRequestsAndFlush) throw new Error('abortPendingRequestsAndFlush is not exposed');
    await expect(acpHandler.abortPendingRequestsAndFlush('ACP runtime turn ended')).resolves.toBeUndefined();

    await expect(pending).rejects.toThrow('ACP runtime turn ended');
    expect(session.agentState.requests['pending-1']).toBeUndefined();
    expect(session.agentState.completedRequests['pending-1']).toMatchObject({
      status: 'canceled',
      reason: 'ACP runtime turn ended',
    });
    expect(flushCount).toBe(1);
  });
});
