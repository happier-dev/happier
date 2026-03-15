import { describe, expect, it } from 'vitest';

import type { EnhancedMode } from '../loop';
import { PermissionHandler } from './permissionHandler';
import { createPermissionHandlerSessionStub } from './permissionHandler.testkit';

const defaultMode = { permissionMode: 'default' } as EnhancedMode;

describe('PermissionHandler (allowlist seeding from updatedPermissions)', () => {
  it('auto-allows tools when completedRequests contains addRules allow entries', async () => {
    const { session, client } = createPermissionHandlerSessionStub('seed-updated-permissions');

    client.agentState.completedRequests.seed1 = {
      tool: 'Read',
      arguments: { file_path: '/tmp/file.txt' },
      createdAt: Date.now(),
      completedAt: Date.now(),
      status: 'approved',
      reason: null,
      mode: null,
      allowedTools: null,
      decision: null,
      updatedPermissions: [
        {
          type: 'addRules',
          behavior: 'allow',
          destination: 'session',
          rules: [{ toolName: 'Read' }],
        },
      ],
    };

    const handler = new PermissionHandler(session);
    const controller = new AbortController();

    await expect(
      handler.handleToolCall('Read', { file_path: '/tmp/another.txt' }, defaultMode, { signal: controller.signal } as any),
    ).resolves.toEqual({ behavior: 'allow', updatedInput: { file_path: '/tmp/another.txt' } });

    expect(Object.keys(client.agentState.requests)).toEqual([]);
  });

  it('auto-allows Bash commands when completedRequests contains addRules allow entries with ruleContent', async () => {
    const { session, client } = createPermissionHandlerSessionStub('seed-updated-permissions-bash');

    client.agentState.completedRequests.seed2 = {
      tool: 'Bash',
      arguments: { command: 'pwd' },
      createdAt: Date.now(),
      completedAt: Date.now(),
      status: 'approved',
      reason: null,
      mode: null,
      allowedTools: null,
      decision: null,
      updatedPermissions: [
        {
          type: 'addRules',
          behavior: 'allow',
          destination: 'session',
          rules: [{ toolName: 'Bash', ruleContent: 'pwd' }],
        },
      ],
    };

    const handler = new PermissionHandler(session);
    const controller = new AbortController();

    await expect(
      handler.handleToolCall('Bash', { command: 'pwd' }, defaultMode, { signal: controller.signal } as any),
    ).resolves.toEqual({ behavior: 'allow', updatedInput: { command: 'pwd' } });

    expect(Object.keys(client.agentState.requests)).toEqual([]);
  });

  it('auto-approves already-pending requests when a new allowlist rule is added', async () => {
    const { session, client } = createPermissionHandlerSessionStub('updated-permissions-auto-approve-pending');
    const handler = new PermissionHandler(session);
    const controller = new AbortController();

    const p1 = handler.handleToolCall(
      'Bash',
      { command: 'rm -rf /tmp/a' },
      defaultMode,
      { signal: controller.signal, toolUseId: 'req1' } as any,
    );
    const p2 = handler.handleToolCall(
      'Bash',
      { command: 'unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN; rm -rf /tmp/b' },
      defaultMode,
      { signal: controller.signal, toolUseId: 'req2' } as any,
    );

    const rpc = client.rpcHandlerManager.getHandler('permission');
    expect(rpc).toBeDefined();

    await rpc?.({
      id: 'req1',
      approved: true,
      updatedPermissions: [
        {
          type: 'addRules',
          behavior: 'allow',
          destination: 'session',
          rules: [{ toolName: 'Bash', ruleContent: 'rm:*' }],
        },
      ],
    } as any);

    const withTimeout = async <T,>(promise: Promise<T>, ms: number): Promise<T> => {
      return await new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timed out')), ms);
        promise
          .then((v) => {
            clearTimeout(timer);
            resolve(v);
          })
          .catch((e) => {
            clearTimeout(timer);
            reject(e);
          });
      });
    };

    await expect(withTimeout(p1, 200)).resolves.toEqual({
      behavior: 'allow',
      updatedInput: { command: 'rm -rf /tmp/a' },
      updatedPermissions: [
        {
          type: 'addRules',
          behavior: 'allow',
          destination: 'session',
          rules: [{ toolName: 'Bash', ruleContent: 'rm:*' }],
        },
      ],
    });
    await expect(withTimeout(p2, 200)).resolves.toEqual({
      behavior: 'allow',
      updatedInput: { command: 'unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN; rm -rf /tmp/b' },
    });

    expect(Object.keys(client.agentState.requests)).toEqual([]);
    expect(Object.keys(client.agentState.completedRequests).sort()).toEqual(['req1', 'req2']);
  });
});
