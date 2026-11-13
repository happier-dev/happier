import { describe, expect, it } from 'vitest';
import { createActionExecutor, type ActionExecutorDeps } from '@happier-dev/protocol/actions/actionExecutor';
import { registerDaemonScheduledRpcHandlers } from './daemonScheduled';
import { createScheduledObservation } from '@/daemon/scheduled/observation';
import type { RpcHandlerContext, RpcHandlerMap } from '@/api/rpc/types';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';

describe('Machine Scheduled Action → RPC → native observation', () => {
  it('preserves partial native results through Action validation and refuses another Account before reading', async () => {
    let nativeReads = 0;
    const observation = createScheduledObservation({ read: async () => { nativeReads++; return [
      { source: 'system_cron', kind: 'available', jobs: [{ id: 'a', name: 'a', schedule: '@daily' }] },
      { source: 'systemd', kind: 'unavailable', reason: 'command_missing' },
    ]; }, subscribe: () => () => {} });
    const handlers: RpcHandlerMap = new Map();
    registerDaemonScheduledRpcHandlers({ registerHandler: (id, handler) => { handlers.set(id, handler); } },
      { machineId: 'm', accountId: 'owner', observation });
    const controller = new AbortController();
    const context = { signal: controller.signal, transportRequestId: 'r', verifyMachineAdmissionCurrent: async () => true,
      machineAdmission: { machineId: 'm', actorAccountId: 'owner', custodianAccountId: 'owner', role: 'manage' } } as RpcHandlerContext;
    // Machine RPC is the transport boundary; receiver, custody, observation and Action owners stay real.
    const executor = createActionExecutor({ machineScheduledAction: ({ actionId, input }) => handlers.get(actionId)!(input, context) } as ActionExecutorDeps);
    const input = { serverId: 'h', machineId: 'm', pageSize: 1 };
    try {
      expect(await executor.execute('machines.scheduled.list', input, { surface: 'cli', serverId: 'h' }))
        .toMatchObject({ ok: true, result: { kind: 'snapshot', sources: [{ jobs: [{ id: 'a' }] }, { reason: 'command_missing' }] } });
      expect(nativeReads).toBe(1);
      await expect(handlers.get('machines.scheduled.list')!({ ...input, machineId: 'other-machine' }, context))
        .rejects.toMatchObject({ rpcErrorCode: RPC_ERROR_CODES.FORBIDDEN });
      expect(nativeReads).toBe(1);
      const stranger = { ...context, machineAdmission: { ...context.machineAdmission!, actorAccountId: 'other' } };
      await expect(handlers.get('machines.scheduled.list')!(input, stranger)).rejects.toMatchObject({ rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE });
      expect(nativeReads).toBe(1);
    } finally { controller.abort(); observation.dispose(); }
  });
});

it.skipIf(process.platform !== 'linux')('reads the Linux host through the real Action and registered RPC', async () => {
  const handlers: RpcHandlerMap = new Map();
  const observation = registerDaemonScheduledRpcHandlers({ registerHandler: (id, handler) => { handlers.set(id, handler); } },
    { machineId: 'linux-host' });
  const executor = createActionExecutor({ machineScheduledAction: ({ actionId, input }) => handlers.get(actionId)!(input) } as ActionExecutorDeps);
  try {
    const result = await executor.execute('machines.scheduled.list', { serverId: 'h', machineId: 'linux-host', pageSize: 2 }, { surface: 'cli', serverId: 'h' });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.errorCode);
    expect(result.result).toMatchObject({ kind: 'snapshot' });
    const output = result.result as { sources: { source: string; kind: string; jobs?: unknown[] }[] };
    expect(output.sources.some(source => source.source.startsWith('cron:'))).toBe(true);
    expect(output.sources.some(source => source.source.startsWith('systemd:'))).toBe(true);
    expect(output.sources.flatMap(source => source.jobs ?? []).length).toBeLessThanOrEqual(2);
  } finally { observation.dispose(); }
});
