import { createUsageSourceActionPort } from '@happier-dev/protocol/actions/executor/usageSourceActions';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { createAccountKvJsonTransport } from '@/sync/ops/account/accountKvJsonTransport';
import { withActionAccountRequestSignal, type LazyActionAccountContext } from './actionAccountContext';

export function createUiUsageSourceActionPort(account: Pick<LazyActionAccountContext, 'serverId' | 'accountId' | 'assertCurrent'>
  & Partial<Pick<LazyActionAccountContext, 'accountLifetime' | 'invocationSignal' | 'credentials' | 'request'>>,
): NonNullable<ActionExecutorDeps['usageSourceAction']> {
  const { credentials, request } = account;
  return createUsageSourceActionPort({
    serverId: account.serverId,
    assertCurrent: context => { context.signal?.throwIfAborted(); account.assertCurrent(); },
    rpc: (request, context) => withActionAccountRequestSignal(account, context.signal, signal => machineRpcWithServerScope({
      serverId: account.serverId, accountId: account.accountId, machineId: request.input.machineId,
      method: request.actionId, payload: request.input, signal, preferScoped: true,
      onDispatched: () => { context.signal?.throwIfAborted(); account.assertCurrent(); },
    })),
    ...(credentials && request ? { dismissalTransport: (key, context) => createAccountKvJsonTransport({
      credentials, key,
      request: (path, init, options) => withActionAccountRequestSignal(account, context.signal, signal =>
        request(path, { ...init, ...(signal ? { signal } : {}) }, options)),
      shouldContinue: () => {
        context.signal?.throwIfAborted();
        account.assertCurrent();
        return true;
      },
    }) } : {}),
  });
}
