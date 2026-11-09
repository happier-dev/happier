import { expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createCliActionDeps } from './createCliActionDeps';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';

it('uses the selected daemon capability owner for an install Action and keeps its refusal result', async () => {
  const invoke = vi.fn<(_method: string, _request: unknown) => Promise<unknown>>(
    async () => ({ ok: true, result: { logPath: '/machine/install.log' } }));
  const deps = createCliActionDeps({ token: 'local', sessionId: 'cli-global', serverId: 'home',
    serverHttpBaseUrl: 'https://home.example.test', mode: 'plain', ctx: null,
    machineActionDirectTargetTransport: { machineId: 'machine', invoke } });
  const input = { machineId: 'machine', capabilityId: 'dep.codex-acp', method: 'install' as const };
  const context = { surface: 'cli' as const, authority: 'present_user' as const };
  await expect(deps.machinePageAction!({ actionId: 'machines.capabilities.install', input, context }))
    .resolves.toEqual({ supported: true, response: { ok: true, result: { logPath: '/machine/install.log' } } });
  expect(invoke).toHaveBeenCalledWith(RPC_METHODS.CAPABILITIES_INVOKE, { id: input.capabilityId, method: 'install' },
    expect.objectContaining({ localActionContext: expect.objectContaining({ authority: 'present_user' }) }));
  invoke.mockResolvedValueOnce({ ok: false, error: { message: 'Install unavailable', code: 'install-failed' } });
  await expect(deps.machinePageAction!({ actionId: 'machines.capabilities.install', input, context }))
    .resolves.toEqual({ supported: true, response: { ok: false, error: { message: 'Install unavailable', code: 'install-failed' } } });
  invoke.mockResolvedValueOnce({ error: 'Method not found', errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND });
  await expect(deps.machinePageAction!({ actionId: 'machines.capabilities.install', input, context }))
    .resolves.toEqual({ supported: false, reason: 'not-supported' });
  invoke.mockResolvedValueOnce({ error: 'Method not found', errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND, unexpected: true });
  await expect(deps.machinePageAction!({ actionId: 'machines.capabilities.install', input, context }))
    .resolves.toEqual({ supported: false, reason: 'error' });
});
