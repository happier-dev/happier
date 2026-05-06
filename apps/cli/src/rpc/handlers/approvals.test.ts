import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { registerApprovalRpcHandlers } from './approvals';

describe('approval RPC handlers', () => {
  it('does not own a static RPC binding table', async () => {
    const source = await readFile(new URL('./approvals.ts', import.meta.url), 'utf8');

    expect(source).not.toContain('APPROVAL_RPC_BINDINGS');
  });

  it('registers approval queue RPC methods through ActionSpec dispatch', async () => {
    const handlers = new Map<string, (input: unknown) => Promise<unknown>>();
    const calls: unknown[] = [];

    registerApprovalRpcHandlers({
      rpcHandlerManager: {
        registerHandler(method, handler) {
          handlers.set(method, handler);
        },
      },
      actionExecutor: {
        execute: async (actionId, input, context) => {
          calls.push({ actionId, input, context });
          return { ok: true, result: { actionId, input } };
        },
      },
    });

    expect([...handlers.keys()]).toEqual([
      RPC_METHODS.APPROVAL_REQUEST_LIST,
      RPC_METHODS.APPROVAL_REQUEST_GET,
      RPC_METHODS.APPROVAL_REQUEST_CREATE,
      RPC_METHODS.APPROVAL_REQUEST_DECIDE,
    ]);

    await expect(handlers.get(RPC_METHODS.APPROVAL_REQUEST_DECIDE)?.({
      artifactId: 'approval-1',
      decision: 'approve',
      serverId: 'server-1',
    })).resolves.toEqual({
      actionId: 'approval.request.decide',
      input: {
        artifactId: 'approval-1',
        decision: 'approve',
        serverId: 'server-1',
      },
    });
    expect(calls).toEqual([
      {
        actionId: 'approval.request.decide',
        input: {
          artifactId: 'approval-1',
          decision: 'approve',
          serverId: 'server-1',
        },
        context: {
          serverId: 'server-1',
          surface: 'rpc',
        },
      },
    ]);
  });
});
