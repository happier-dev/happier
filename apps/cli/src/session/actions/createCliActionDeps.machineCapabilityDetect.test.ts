import { expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createCliActionDeps } from './createCliActionDeps';

it('lets an agent refresh Tools through the real Action without disclosing detector facts', async () => {
  // The direct target transport is the external daemon boundary. Admission and RPC routing stay real.
  const response = { protocolVersion: 1, results: { 'tool.tmux': { ok: true, checkedAt: 1, data: { available: true, version: '3.5' } } } };
  const invoke = vi.fn<(_method: string, _request: unknown) => Promise<unknown>>(async () => response);
  const executor = createActionExecutor(createCliActionDeps({ token: 'local', sessionId: 'cli-global', serverId: 'home',
    serverHttpBaseUrl: 'https://home.example.test', mode: 'plain', ctx: null,
    machineActionDirectTargetTransport: { machineId: 'machine', invoke } }));
  const actionId = 'machines.capabilities.detect';
  const request = { requests: [{ id: 'tool.tmux', params: { includeLatestVersion: true } }], bypassCache: true };
  const input = { machineId: 'machine' };
  const context = { surface: 'agent', authority: 'account_automation' } as const;
  expect(await executor.execute(actionId, { ...input, request }, context)).toMatchObject({ ok: false });
  expect(invoke).not.toHaveBeenCalled();
  expect(await executor.execute(actionId, input, context)).toEqual({ ok: true, result: { status: 'completed' } });
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(invoke).toHaveBeenLastCalledWith(RPC_METHODS.CAPABILITIES_DETECT, expect.objectContaining({ checklistId: 'machine-details' }),
    expect.objectContaining({ localActionContext: expect.objectContaining({ authority: 'account_automation' }) }));
  invoke.mockResolvedValueOnce({ error: 'Method not found', errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND });
  expect(await executor.execute(actionId, input, context)).toEqual({ ok: true, result: { status: 'failed', reason: 'not-supported' } });
  expect(await executor.execute(actionId, input, context)).toEqual({ ok: true, result: { status: 'completed' } });
  invoke.mockRejectedValueOnce(Object.assign(new Error('private transport details'), { rpcErrorCode: RPC_ERROR_CODES.FORBIDDEN }));
  expect(await executor.execute(actionId, input, context)).toEqual({ ok: true,
    result: { status: 'failed', reason: 'error', error: { name: 'Error', rpcErrorCode: RPC_ERROR_CODES.FORBIDDEN } } });
  expect(await executor.execute(actionId, input, context)).toEqual({ ok: true, result: { status: 'completed' } });
  vi.useFakeTimers();
  try {
    await vi.advanceTimersByTimeAsync(60_000);
    expect(invoke).toHaveBeenCalledTimes(5);
  } finally { vi.useRealTimers(); }
});
