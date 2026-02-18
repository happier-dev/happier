import { describe, expect, it } from 'vitest';

import { PermissionHandler } from './permissionHandler';
import { createPermissionHandlerSessionStub } from './permissionHandler.testkit';

describe('PermissionHandler (provided toolUseId)', () => {
  it('uses options.toolUseId when provided (no tool_use message required)', async () => {
    const { session, client } = createPermissionHandlerSessionStub();
    const handler = new PermissionHandler(session);

    const controller = new AbortController();
    const promise = handler.handleToolCall(
      'Read',
      { file_path: '/tmp/file.txt' },
      { permissionMode: 'default' } as any,
      { signal: controller.signal, toolUseId: 'toolu_123' } as any,
    );

    expect(client.getAgentStateSnapshot().requests.toolu_123).toEqual(
      expect.objectContaining({
        tool: 'Read',
        arguments: { file_path: '/tmp/file.txt' },
      }),
    );

    const permissionHandler = client.rpcHandlerManager.getHandler('permission');
    expect(permissionHandler).toBeDefined();

    await permissionHandler?.({
      id: 'toolu_123',
      approved: true,
      reason: '',
      mode: 'default',
      allowedTools: [],
    } as any);

    await expect(promise).resolves.toEqual({
      behavior: 'allow',
      updatedInput: { file_path: '/tmp/file.txt' },
    });
  });
});

