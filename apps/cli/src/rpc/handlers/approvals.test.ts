import { readFile } from 'node:fs/promises';

import { describe, expect, it, vi } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { registerApprovalRpcHandlers } from './approvals';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';

describe('approval RPC handlers', () => {
  it('does not admit payload-labelled human authority through the private continuation handler', async () => {
    const rpc = new RpcHandlerManager({ scopePrefix: 'machine-1', encryptionMode: 'plain', logger: () => {} });
    registerApprovalRpcHandlers({ rpcHandlerManager: rpc });
    const response = await rpc.handleRequest({
      method: `machine-1:${RPC_METHODS.APPROVAL_REQUEST_SECRET_CONTINUE}`,
      params: { authority: 'present_user', choice: { kind: 'once', value: 'private-test-value' } },
      callerAuthority: 'account_automation',
    });
    expect(response).toEqual({ status: 'refused', code: 'approval_required' });
    expect(JSON.stringify(response)).not.toContain('private-test-value');
  });
  it('does not own a static RPC binding table', async () => {
    const source = await readFile(new URL('./approvals.ts', import.meta.url), 'utf8');

    expect(source).not.toContain('APPROVAL_RPC_BINDINGS');
  });

  it('registers approval queue RPC methods through ActionSpec dispatch', async () => {
    const handlers = new Map<string, (input: unknown) => Promise<unknown>>();
    const calls: unknown[] = [];
    const replayApprovedApprovalRequest = vi.fn(async (input: unknown) => ({
      ok: true as const,
      result: { ok: true as const, status: 'executed' as const, input },
    }));

    registerApprovalRpcHandlers({
      rpcHandlerManager: {
        registerHandler(method, handler) {
          handlers.set(method, handler);
        },
      },
      actionExecutor: {
        replayApprovedApprovalRequest,
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
      RPC_METHODS.APPROVAL_REQUEST_REPLAY_APPROVED,
      RPC_METHODS.APPROVAL_REQUEST_SECRET_CONTINUE,
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
          authority: 'account_automation',
          serverId: 'server-1',
          surface: 'rpc',
        },
      },
    ]);

    await expect(handlers.get(RPC_METHODS.APPROVAL_REQUEST_REPLAY_APPROVED)?.({
      artifactId: 'approval-1',
      decision: 'reject',
      authority: 'present_user',
    })).resolves.toEqual({
      ok: true,
      result: {
        ok: true,
        status: 'executed',
        input: { artifactId: 'approval-1' },
      },
    });
    expect(replayApprovedApprovalRequest).toHaveBeenCalledExactlyOnceWith({
      artifactId: 'approval-1',
    });
  });
});
