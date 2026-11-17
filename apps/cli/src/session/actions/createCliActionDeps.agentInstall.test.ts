import type { ActionExecutorContext } from '@happier-dev/protocol/actions/actionExecutor';
import { ActionSurfaceSchema } from '@happier-dev/protocol/actions/metadata';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

const { callMachineRpc } = vi.hoisted(() => ({ callMachineRpc: vi.fn() }));
vi.mock('@/session/transport/rpc/machineRpc', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/session/transport/rpc/machineRpc')>(), callMachineRpc,
}));
import { createCliActionDeps } from './createCliActionDeps';

describe('CLI install job Actions', () => {
  beforeEach(() => callMachineRpc.mockReset());
  it('starts jobs with explicit consent and reads/cancels that job through the machine transport', async () => {
    const credentials = { token: 'token', encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) } };
    const executor = createActionExecutor({
    readActionsSettings: (context: ActionExecutorContext) => ActionsSettingsV1Schema.parse({ v: 1, ...context.actionsSettings, approvalWaivedSurfaces: {"machines.agents.install": Object.keys(ActionSurfaceSchema.shape), "machines.agents.install.status": Object.keys(ActionSurfaceSchema.shape), "machines.agents.install.cancel": Object.keys(ActionSurfaceSchema.shape), ...context.actionsSettings?.approvalWaivedSurfaces} }),
      ...createCliActionDeps({ token: credentials.token, credentials, sessionId: 'session', mode: 'plain', ctx: null }),

    });
    const context = { surface: 'cli' as const, authority: 'present_user' as const };
    callMachineRpc.mockResolvedValueOnce({ ok: true, jobId: 'job' });
    expect(await executor.execute('machines.agents.install', { machineId: 'machine', agentId: 'plugin/agent', intent: 'update', force: true }, context)).toMatchObject({ ok: true, result: { jobId: 'job' } });
    expect(callMachineRpc).toHaveBeenLastCalledWith(expect.objectContaining({ method: RPC_METHODS.DAEMON_AGENTS_INSTALL_START, request: { agentId: 'plugin/agent', intent: 'update', consent: { vendorRecipe: true }, force: true } }));
    callMachineRpc.mockResolvedValueOnce({ ok: true, steps: [], progress: [], events: [], nextCursor: 4, done: true, outcome: { kind: 'succeeded', version: '1.2' } });
    expect(await executor.execute('machines.agents.install.status', { machineId: 'machine', jobId: 'job', cursor: 4 }, context)).toMatchObject({ ok: true, result: { outcome: { kind: 'succeeded' } } });
    expect(callMachineRpc).toHaveBeenLastCalledWith(expect.objectContaining({ method: RPC_METHODS.DAEMON_AGENTS_INSTALL_READ, request: { jobId: 'job', cursor: 4 } }));
    callMachineRpc.mockResolvedValueOnce({ ok: false, errorCode: 'job_not_found', error: 'Missing job' });
    expect(await executor.execute('machines.agents.install.cancel', { machineId: 'machine', jobId: 'job' }, context)).toMatchObject({ ok: false, errorCode: 'job_not_found' });
  });
  it('uses an exact direct machine transport without widening it to another unauthenticated machine', async () => {
    const invoke = vi.fn(async () => ({ ok: true, jobId: 'direct-job' }));
    const executor = createActionExecutor({
    readActionsSettings: (context: ActionExecutorContext) => ActionsSettingsV1Schema.parse({ v: 1, ...context.actionsSettings, approvalWaivedSurfaces: {"machines.agents.install": Object.keys(ActionSurfaceSchema.shape), ...context.actionsSettings?.approvalWaivedSurfaces} }),
      ...createCliActionDeps({ token: 'token', sessionId: 'session', mode: 'plain', ctx: null, serverId: 'home-1', serverHttpBaseUrl: 'https://home-1.test',
        machineActionDirectTargetTransport: { machineId: 'exact-machine', invoke },
      }),

    });
    const context = { surface: 'cli' as const, authority: 'present_user' as const, serverId: 'home-1' };
    expect(await executor.execute('machines.agents.install', { machineId: 'exact-machine', agentId: 'plugin/agent', intent: 'install' }, context)).toMatchObject({ ok: true, result: { jobId: 'direct-job' } });
    expect(await executor.execute('machines.agents.install', { machineId: 'other-machine', agentId: 'plugin/agent', intent: 'install' }, context)).toMatchObject({ ok: false, errorCode: 'install_unavailable' });
    expect(callMachineRpc).not.toHaveBeenCalled();
  });

  it.each([
    { actionId: 'machines.agents.install', input: { agentId: 'plugin/agent', intent: 'install' } },
    { actionId: 'machines.agents.install.status', input: { jobId: 'job' } },
    { actionId: 'machines.agents.install.cancel', input: { jobId: 'job' } },
  ] as const)('rejects a different Home before $actionId can reach the admitted machine', async ({ actionId, input }) => {
    const invoke = vi.fn(async (method: string) => {
      if (method === RPC_METHODS.DAEMON_AGENTS_INSTALL_START) return { ok: true, jobId: 'job' };
      if (method === RPC_METHODS.DAEMON_AGENTS_INSTALL_READ) {
        return { ok: true, steps: [], progress: [], events: [], nextCursor: 0, done: false, outcome: null };
      }
      return { ok: true };
    });
    const executor = createActionExecutor({
    readActionsSettings: (context: ActionExecutorContext) => ActionsSettingsV1Schema.parse({ v: 1, ...context.actionsSettings, approvalWaivedSurfaces: {"machines.agents.install": Object.keys(ActionSurfaceSchema.shape), "machines.agents.install.status": Object.keys(ActionSurfaceSchema.shape), "machines.agents.install.cancel": Object.keys(ActionSurfaceSchema.shape), ...context.actionsSettings?.approvalWaivedSurfaces} }),
      ...createCliActionDeps({ token: 'token', sessionId: 'session', mode: 'plain', ctx: null,
        serverId: 'home-1', serverHttpBaseUrl: 'https://home-1.test',
        ...(actionId === 'machines.agents.install'
          ? { credentials: { token: 'token', encryption: { type: 'legacy' as const, secret: new Uint8Array(32) } } }
          : { machineActionDirectTargetTransport: { machineId: 'machine', invoke } }),
      }),

    });
    callMachineRpc.mockResolvedValueOnce({ ok: true, jobId: 'job' });
    const result = await executor.execute(actionId, { machineId: 'machine', ...input }, {
      surface: 'cli', authority: 'present_user', serverId: 'home-2',
    });
    expect(result).toMatchObject({ ok: false, errorCode: 'server_scope_mismatch', error: 'server_scope_mismatch' });
    expect(invoke).not.toHaveBeenCalled();
    expect(callMachineRpc).not.toHaveBeenCalled();
  });
});
