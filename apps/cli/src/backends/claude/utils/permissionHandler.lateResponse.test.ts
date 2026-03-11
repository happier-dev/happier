import { describe, expect, it } from 'vitest';

import { PermissionHandler } from './permissionHandler';
import { createPermissionHandlerSessionStub } from './permissionHandler.testkit';

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
