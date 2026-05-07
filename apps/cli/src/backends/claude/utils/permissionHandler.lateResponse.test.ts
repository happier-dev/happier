import { describe, expect, it } from 'vitest';

import { PermissionHandler } from './permissionHandler';
import { createPermissionHandlerSessionStub } from './permissionHandler.testkit';
import { createPermissionHandlerSessionStubWithMetadata } from './permissionHandler.testkit';
import type { EnhancedMode } from '../loop';
import type { PermissionRpcPayload } from './permissionRpc';

describe('PermissionHandler (late permission responses)', () => {
  async function expectResolvesWithin<T>(promise: Promise<T>, ms = 250): Promise<T> {
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out')), ms);
      promise
        .then((value) => {
          clearTimeout(timer);
          resolve(value);
        })
        .catch((error) => {
          clearTimeout(timer);
          reject(error);
        });
    });
  }

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
    handler.dispose();
  });

  it('uses a detached late ExitPlanMode approval to satisfy a compatible same-id retry', async () => {
    const { session, client } = createPermissionHandlerSessionStubWithMetadata({
      sessionId: 's1-exit-late',
      metadata: { acpSessionModeOverrideV1: { v: 1, updatedAt: 1, modeId: 'plan' } },
    });
    const handler = new PermissionHandler(session);

    const firstController = new AbortController();
    const permissionId = 'perm-late-exit-plan-1';
    const mode = { permissionMode: 'yolo', agentModeId: 'plan', localId: 'm1' } as EnhancedMode;
    const input = { plan: 'p1' };

    const first = handler.handleToolCall(
      'ExitPlanMode',
      input,
      mode,
      { signal: firstController.signal, toolUseId: permissionId },
    );

    firstController.abort();
    await expect(first).rejects.toBeTruthy();

    const permissionRpc = client.rpcHandlerManager.getHandler('permission');
    expect(permissionRpc).toBeTruthy();
    await permissionRpc?.({ id: permissionId, approved: true } satisfies PermissionRpcPayload);

    const retry = handler.handleToolCall(
      'ExitPlanMode',
      input,
      mode,
      { signal: new AbortController().signal, toolUseId: permissionId },
    );

    await expect(expectResolvesWithin(retry)).resolves.toEqual({
      behavior: 'allow',
      updatedInput: input,
    });
    expect(client.getAgentStateSnapshot().requests[permissionId]).toBeUndefined();
    expect(client.getAgentStateSnapshot().completedRequests[permissionId]).toMatchObject({ status: 'approved' });

    await expect(
      handler.handleToolCall(
        'Bash',
        { command: 'pwd' },
        mode,
        { signal: new AbortController().signal, toolUseId: 'perm-late-exit-plan-bash-1' },
      ),
    ).resolves.toMatchObject({ behavior: 'allow' });
    handler.dispose();
  });

  it('ignores uncorrelated stale permission RPCs without mutating mode, allowlist, or completed state', async () => {
    const { session, client } = createPermissionHandlerSessionStub('s-stale-rpc');
    const handler = new PermissionHandler(session);

    const permissionRpc = client.rpcHandlerManager.getHandler('permission');
    expect(permissionRpc).toBeTruthy();
    await permissionRpc?.({
      id: 'missing-permission-id',
      approved: true,
      mode: 'yolo',
      allowedTools: ['Bash(ls:*)'],
      updatedPermissions: [
        {
          type: 'addRules',
          behavior: 'allow',
          destination: 'session',
          rules: [{ toolName: 'Bash', ruleContent: 'ls:*' }],
        },
      ],
    } satisfies PermissionRpcPayload);

    expect(session.setLastPermissionMode).not.toHaveBeenCalled();
    expect(client.getAgentStateSnapshot().completedRequests['missing-permission-id']).toBeUndefined();

    const future = handler.handleToolCall(
      'Bash',
      { command: 'ls src' },
      { permissionMode: 'default' } as EnhancedMode,
      { signal: new AbortController().signal, toolUseId: 'stale-rpc-future-1' },
    );
    expect(client.getAgentStateSnapshot().requests['stale-rpc-future-1']).toBeDefined();
    handler.dispose();
    await expect(future).rejects.toBeTruthy();
  });

  it('applies late approval side-effects to allowlists, permission mode, and matching pending requests', async () => {
    const { session, client } = createPermissionHandlerSessionStub('s2');
    const handler = new PermissionHandler(session);

    const abortedController = new AbortController();
    const pendingController = new AbortController();
    const firstId = 'perm-late-allowlist-1';
    const secondId = 'perm-late-allowlist-2';

    const aborted = handler.handleToolCall(
      'Bash',
      { command: 'unset ANTHROPIC_API_KEY; ls' },
      { permissionMode: 'default' } as any,
      { signal: abortedController.signal, toolUseId: firstId },
    );

    const pending = handler.handleToolCall(
      'Bash',
      { command: 'unset ANTHROPIC_AUTH_TOKEN; ls src' },
      { permissionMode: 'default' } as any,
      { signal: pendingController.signal, toolUseId: secondId },
    );

    abortedController.abort();
    await expect(aborted).rejects.toBeTruthy();

    const permissionRpc = client.rpcHandlerManager.getHandler('permission');
    expect(permissionRpc).toBeTruthy();
    await permissionRpc?.({
      id: firstId,
      approved: true,
      mode: 'yolo',
      updatedPermissions: [
        {
          type: 'addRules',
          behavior: 'allow',
          destination: 'session',
          rules: [{ toolName: 'Bash', ruleContent: 'ls:*' }],
        },
      ],
    } as any);

    await expect(expectResolvesWithin(pending)).resolves.toEqual({
      behavior: 'allow',
      updatedInput: { command: 'unset ANTHROPIC_AUTH_TOKEN; ls src' },
    });
    expect(session.setLastPermissionMode).toHaveBeenCalledWith('yolo');
    expect((client.agentState as any).requests?.[firstId]).toBeUndefined();
    expect((client.agentState as any).requests?.[secondId]).toBeUndefined();
    expect((client.agentState as any).completedRequests?.[firstId]).toMatchObject({
      status: 'approved',
      mode: 'yolo',
      updatedPermissions: [
        {
          type: 'addRules',
          behavior: 'allow',
          destination: 'session',
          rules: [{ toolName: 'Bash', ruleContent: 'ls:*' }],
        },
      ],
    });

    await expect(
      handler.handleToolCall(
        'Bash',
        { command: 'unset AWS_SECRET_ACCESS_KEY; ls packages' },
        { permissionMode: 'default' } as any,
        { signal: new AbortController().signal, toolUseId: 'perm-late-allowlist-3' },
      ),
    ).resolves.toEqual({
      behavior: 'allow',
      updatedInput: { command: 'unset AWS_SECRET_ACCESS_KEY; ls packages' },
    });
    handler.dispose();
  });

  it('auto-approves pending requests when a late approval changes the mode without allowlist updates', async () => {
    const { session, client } = createPermissionHandlerSessionStub('s2-mode-only');
    const handler = new PermissionHandler(session);

    const abortedController = new AbortController();
    const pendingController = new AbortController();
    const firstId = 'perm-late-mode-only-1';
    const secondId = 'perm-late-mode-only-2';

    const aborted = handler.handleToolCall(
      'Read',
      { file_path: '/tmp/a.txt' },
      { permissionMode: 'default' } as any,
      { signal: abortedController.signal, toolUseId: firstId },
    );

    const pending = handler.handleToolCall(
      'Read',
      { file_path: '/tmp/b.txt' },
      { permissionMode: 'default' } as any,
      { signal: pendingController.signal, toolUseId: secondId },
    );

    abortedController.abort();
    await expect(aborted).rejects.toBeTruthy();

    const permissionRpc = client.rpcHandlerManager.getHandler('permission');
    expect(permissionRpc).toBeTruthy();
    await permissionRpc?.({
      id: firstId,
      approved: true,
      mode: 'yolo',
    } as any);

    await expect(expectResolvesWithin(pending)).resolves.toEqual({
      behavior: 'allow',
      updatedInput: { file_path: '/tmp/b.txt' },
    });
    expect(session.setLastPermissionMode).toHaveBeenCalledWith('yolo');
    expect((client.agentState as any).requests?.[secondId]).toBeUndefined();
    expect((client.agentState as any).completedRequests?.[secondId]).toMatchObject({
      status: 'approved',
      mode: 'yolo',
    });
    handler.dispose();
  });

  it('does not apply late denied allowlist side-effects to pending or future requests', async () => {
    const { session, client } = createPermissionHandlerSessionStub('s3');
    const handler = new PermissionHandler(session);

    const abortedController = new AbortController();
    const pendingController = new AbortController();
    const firstId = 'perm-late-denied-1';
    const secondId = 'perm-late-denied-2';

    const aborted = handler.handleToolCall(
      'Bash',
      { command: 'ls' },
      { permissionMode: 'default' } as any,
      { signal: abortedController.signal, toolUseId: firstId },
    );

    const pending = handler.handleToolCall(
      'Bash',
      { command: 'ls src' },
      { permissionMode: 'default' } as any,
      { signal: pendingController.signal, toolUseId: secondId },
    );

    abortedController.abort();
    await expect(aborted).rejects.toBeTruthy();

    const permissionRpc = client.rpcHandlerManager.getHandler('permission');
    expect(permissionRpc).toBeTruthy();
    await permissionRpc?.({
      id: firstId,
      approved: false,
      allowedTools: ['Bash(ls:*)'],
      updatedPermissions: [
        {
          type: 'addRules',
          behavior: 'allow',
          destination: 'session',
          rules: [{ toolName: 'Bash', ruleContent: 'ls:*' }],
        },
      ],
    } as any);

    expect((client.agentState as any).requests?.[secondId]).toBeDefined();
    pendingController.abort();
    await expect(pending).rejects.toBeTruthy();

    const futureController = new AbortController();
    const futureId = 'perm-late-denied-3';
    const future = handler.handleToolCall(
      'Bash',
      { command: 'ls packages' },
      { permissionMode: 'default' } as any,
      { signal: futureController.signal, toolUseId: futureId },
    );

    expect((client.agentState as any).requests?.[futureId]).toBeDefined();
    futureController.abort();
    await expect(future).rejects.toBeTruthy();
    handler.dispose();
  });

  it('does not apply denied mode side-effects to pending or future requests', async () => {
    const { session, client } = createPermissionHandlerSessionStub('s4');
    const handler = new PermissionHandler(session);

    const firstController = new AbortController();
    const secondController = new AbortController();
    const firstId = 'perm-denied-mode-1';
    const secondId = 'perm-denied-mode-2';

    const first = handler.handleToolCall(
      'Read',
      { file_path: '/tmp/a.txt' },
      { permissionMode: 'default' } as any,
      { signal: firstController.signal, toolUseId: firstId },
    );
    const second = handler.handleToolCall(
      'Read',
      { file_path: '/tmp/b.txt' },
      { permissionMode: 'default' } as any,
      { signal: secondController.signal, toolUseId: secondId },
    );

    const permissionRpc = client.rpcHandlerManager.getHandler('permission');
    expect(permissionRpc).toBeTruthy();
    await permissionRpc?.({
      id: firstId,
      approved: false,
      mode: 'yolo',
      reason: 'deny despite mode payload',
    } as any);

    await expect(first).resolves.toMatchObject({ behavior: 'deny' });
    expect(session.setLastPermissionMode).not.toHaveBeenCalledWith('yolo');
    expect((client.agentState as any).requests?.[secondId]).toBeDefined();

    secondController.abort();
    await expect(second).rejects.toBeTruthy();

    const thirdController = new AbortController();
    const thirdId = 'perm-denied-mode-3';
    const third = handler.handleToolCall(
      'Read',
      { file_path: '/tmp/c.txt' },
      { permissionMode: 'default' } as any,
      { signal: thirdController.signal, toolUseId: thirdId },
    );

    expect((client.agentState as any).requests?.[thirdId]).toBeDefined();
    thirdController.abort();
    await expect(third).rejects.toBeTruthy();
    handler.dispose();
  });
});
