import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { createProviderActionExecuteV1 } from '@happier-dev/protocol/providers/executeProviderActionV1';
import { applyProviderDefaultModelSelectionV1 } from '@happier-dev/protocol/providers/selection/v1';
import { createAccountProviderActionExecuteV1 } from '@happier-dev/protocol/providers/connections/accountProviderActionV1';
import { providerDeclarationContext, readAccountProviderDeclarations, readAccountAgentProviderRequirements } from '@/providers/catalog/accountProviderDeclarations';
import { loadDaemonMergedProjectionInputs } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { readProviderCatalogForMutationInContext,
  writeProviderCatalogAndPublishInContext } from '@/sync/api/account/apiProviderCatalog';
import { refreshProviderCatalog } from '@/sync/engine/settings/providerCatalogEngine';
import { getProviderCatalogSnapshot } from '@/sync/store/settings/providerCatalogSnapshot';
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { createMachineRpcReadAdmission } from '@/sync/runtime/orchestration/serverScopedRpc/machineRpcReadAdmission';
import { executeOriginalAccountMachineAction } from '@/sync/api/externalActionAccountTransport';
import { createRpcCallError } from '@happier-dev/protocol/rpcErrors';
import { ProviderErrorV1Schema } from '@happier-dev/protocol/providers/errors';
import { withActionAccountRequestSignal, type LazyActionAccountContext } from './actionAccountContext';
import { readUiOwnedSessionForAction } from './botTemplateActionDeps';

export function createUiProviderActionExecuteV1(account: LazyActionAccountContext,
  options?: Readonly<{ onRpcDispatched?: () => void }>,
): NonNullable<ActionExecutorDeps['providerActionExecute']> {
  return createProviderActionExecuteV1({
    assertCurrent: context => { context.signal?.throwIfAborted(); account.assertCurrent(); },
    readSessionMetadata: async ({ sessionId }, context) => {
      try {
        return (await readUiOwnedSessionForAction(account, { serverId: account.serverId, sessionId }, context)).metadata;
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'session_target_unavailable') return null;
        throw error;
      }
    },
    rpc: ({ machineId, method, request, context, operationTimeoutMs }) => withActionAccountRequestSignal(account, context.signal, async signal => {
      // Personal discovery on a granted worker needs the requester's Account
      // custody. Own workers and Team compatibility retain their raw RPC path.
      if ((request.actionId === 'providers.models.projection' || request.actionId === 'providers.models.refresh')
        && request.input.teamCredentialResources === undefined && !context.externalActionCredential
        && !context.externalActionExecutionAuthorization && !context.rpcSessionAuthorization) {
        if (!context.actionRequestId) throw createRpcCallError({ error: 'admission_unavailable', errorCode: 'admission_unavailable' });
        const execution = await executeOriginalAccountMachineAction({ account, machineId,
          actionId: request.actionId, input: request.input, requestId: context.actionRequestId,
          authority: context.authority, actionCaller: context.actionCaller, signal, foreignTargetOnly: true,
          onTransportIssued: () => { context.signal?.throwIfAborted(); account.assertCurrent(); options?.onRpcDispatched?.(); },
        });
        if (execution) {
          if (!execution.ok) {
            const error = ProviderErrorV1Schema.safeParse(execution.details);
            if (error.success && error.data.code === execution.errorCode) throw error.data;
            throw createRpcCallError({ error: execution.error, errorCode: execution.errorCode });
          }
          return execution.result;
        }
      }
      return machineRpcWithServerScope<unknown, typeof request.input>({
        machineId, method, payload: request.input, serverId: account.serverId, accountId: account.accountId,
        signal,
        ...(request.actionId === 'providers.models.projection' || request.actionId === 'providers.models.list'
          || request.actionId === 'providers.connections.describe' ? {
          readAdmission: createMachineRpcReadAdmission([request.actionId, account.serverId,
            account.accountId, machineId, request.input]),
        } : {}),
        ...(operationTimeoutMs === null ? { operationTimeoutMs: null } : {}),
        onDispatched: () => { context.signal?.throwIfAborted(); account.assertCurrent(); options?.onRpcDispatched?.(); },
      });
    }),
    setDefault: (input, context) => account.mutateRawSettings(raw => applyProviderDefaultModelSelectionV1(raw, input),
      { signal: context.signal, observeOutcome: true }),
    account: (request, context) => {
      const machineId = 'machineId' in request.input ? request.input.machineId : null;
      const readDeclarationProjection = async () => {
        // Account-only actions retain bundled declarations; installed sources
        // require the invocation's explicitly addressed Machine authority.
        if (!machineId) return null;
        const inputs = await loadDaemonMergedProjectionInputs({ machineId, serverId: account.serverId,
          accountLifetime: account.accountLifetime, signal: context.signal });
        context.signal?.throwIfAborted(); account.assertCurrent();
        return inputs?.pluginProjectionV2 ?? null;
      };
      const execute = createAccountProviderActionExecuteV1({
        assertCurrent: () => { context.signal?.throwIfAborted(); account.assertCurrent(); },
        // Reads own first-use admission even without a mounted catalog observer.
        // Mutations still require the admitted row and never activate an inactive source.
        readCatalog: async () => {
          if (getActionSpec(request.actionId).sideEffectClass !== 'read') {
            return readProviderCatalogForMutationInContext(account, context.signal);
          }
          const scope = { serverId: account.serverId, accountId: account.accountId };
          await refreshProviderCatalog(scope);
          context.signal?.throwIfAborted(); account.assertCurrent();
          return getProviderCatalogSnapshot(scope)?.catalog ?? { status: 'unavailable', reason: 'authority-not-confirmed' };
        },
        writeCatalog: input => writeProviderCatalogAndPublishInContext(account, input, context.signal),
        readDefinitions: async () => readAccountProviderDeclarations(providerDeclarationContext(machineId, await readDeclarationProjection())),
        readAgentProviderRequirements: async agentTargetKey => readAccountAgentProviderRequirements(agentTargetKey, providerDeclarationContext(machineId, await readDeclarationProjection())),
        now: Date.now,
      });
      return execute(request, context);
    },
  });
}
