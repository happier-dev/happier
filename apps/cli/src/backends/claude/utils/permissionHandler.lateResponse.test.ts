import { describe, expect, it } from 'vitest';

import { PermissionHandler } from './permissionHandler';
import { createPermissionHandlerSessionStub } from './permissionHandler.testkit';

describe('PermissionHandler (late permission responses)', () => {
  it('completes agentState requests when a permission response arrives after the in-flight request was aborted', async () => {
    const { session, client } = createPermissionHandlerSessionStub('s1');
    const handler = new PermissionHandler(session);

    const controller = new AbortController();
    const permissionId = 'perm-late-1';

    const promise = handler.handleToolCall(
      'Bash',
      { command: 'echo hello' },
      { permissionMode: 'default' } as any,
      { signal: controller.signal, toolUseId: permissionId },
    );

    controller.abort();
    await expect(promise).rejects.toBeTruthy();

    // UI approval arrives late (after abort cleared in-memory pending state).
    const permissionRpc = client.rpcHandlerManager.getHandler('permission');
    expect(permissionRpc).toBeTruthy();
    await permissionRpc?.({ id: permissionId, approved: true } as any);

    // The request should still be resolved for the UI state surface:
    // remove from requests and mark in completedRequests.
    expect((client.agentState as any).requests?.[permissionId]).toBeUndefined();
    expect((client.agentState as any).completedRequests?.[permissionId]?.status).toBe('approved');
  });
});

