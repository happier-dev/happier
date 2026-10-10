import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { createProviderActionExecuteV1 } from '@happier-dev/protocol/providers/executeProviderActionV1';
import { applyProviderDefaultModelSelectionV1 } from '@happier-dev/protocol/providers/selection/v1';
import { createAccountProviderActionExecuteV1 } from '@happier-dev/protocol/providers/connections/accountProviderActionV1';
import { readAccountProviderDeclarations, readAccountAgentProviderRequirements } from '@/providers/catalog/accountProviderDeclarations';
import { readProviderCatalogForMutationInContext,
  writeProviderCatalogAndPublishInContext } from '@/sync/api/account/apiProviderCatalog';
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import type { LazyActionAccountContext } from './actionAccountContext';

export function createUiProviderActionExecuteV1(account: LazyActionAccountContext,
  options?: Readonly<{ onRpcDispatched?: () => void }>,
): NonNullable<ActionExecutorDeps['providerActionExecute']> {
  return createProviderActionExecuteV1({
    assertCurrent: context => { context.signal?.throwIfAborted(); account.assertCurrent(); },
    rpc: ({ machineId, method, request, context }) => machineRpcWithServerScope<unknown, typeof request.input>({
      machineId, method, payload: request.input, serverId: account.serverId, accountId: account.accountId,
      signal: context.signal,
      onDispatched: () => { context.signal?.throwIfAborted(); account.assertCurrent(); options?.onRpcDispatched?.(); },
    }),
    setDefault: (input, context) => account.mutateRawSettings(raw => applyProviderDefaultModelSelectionV1(raw, input),
      { signal: context.signal, observeOutcome: true }),
    account: (request, context) => {
      const execute = createAccountProviderActionExecuteV1({
        assertCurrent: () => { context.signal?.throwIfAborted(); account.assertCurrent(); },
        readCatalog: () => readProviderCatalogForMutationInContext(account, context.signal),
        writeCatalog: input => writeProviderCatalogAndPublishInContext(account, input, context.signal),
        readDefinitions: async () => readAccountProviderDeclarations(),
        readAgentProviderRequirements: readAccountAgentProviderRequirements,
        now: Date.now,
      });
      return execute(request, context);
    },
  });
}
