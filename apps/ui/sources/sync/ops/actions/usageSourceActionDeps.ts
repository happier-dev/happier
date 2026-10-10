import { createUsageSourceActionPort } from '@happier-dev/protocol/actions/executor/usageSourceActions';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import type { LazyActionAccountContext } from './actionAccountContext';

export function createUiUsageSourceActionPort(account: Pick<LazyActionAccountContext, 'serverId' | 'accountId' | 'assertCurrent'>,
  dismiss?: Parameters<typeof createUsageSourceActionPort>[0]['dismiss'],
): NonNullable<ActionExecutorDeps['usageSourceAction']> {
  return createUsageSourceActionPort({
    serverId: account.serverId,
    assertCurrent: context => { context.signal?.throwIfAborted(); account.assertCurrent(); },
    rpc: (request, context) => machineRpcWithServerScope({
      serverId: account.serverId, accountId: account.accountId, machineId: request.input.machineId,
      method: request.actionId, payload: request.input, signal: context.signal, preferScoped: true,
      onDispatched: () => { context.signal?.throwIfAborted(); account.assertCurrent(); },
    }),
    ...(dismiss ? { dismiss } : {}),
  });
}
