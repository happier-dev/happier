import type { ActionExecutorContext, ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { createProviderActionExecuteV1 } from '@happier-dev/protocol/providers/executeProviderActionV1';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type { StoredCredentials } from '@/persistence';
import { isServerProfileHomeIdentity } from '@/server/serverProfiles';
import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import type { SavedSecretOperationContextV1 } from '@/settings/secrets/hydrateSavedSecretCatalog';
import { setDefaultProviderModelSelection } from '@/providers/connections/service/settings';
import { createCliAccountProviderActionExecuteV1 } from '@/providers/connections/accountActions';
import type { DaemonProviderModelProjectionRequestV1, DaemonProviderModelProjectionResponseV1 } from '@happier-dev/protocol/rpc/providers';
import { prepareProviderConnectionsCatalogForCli } from '@/providers/settings/hydrate';
import { createProviderErrorV1 } from '@happier-dev/protocol/providers/errors';

/** Provider Actions share admitted Account custody; only machine effects use exact-Machine RPC. */
export function createCliProviderActionExecuteV1(params: Readonly<{
  credentials: StoredCredentials; serverId: string; serverHttpBaseUrl: string;
  operationContext?: SavedSecretOperationContextV1;
  preparedSavedSecret?: Parameters<typeof createCliAccountProviderActionExecuteV1>[0]['preparedSavedSecret'];
  isCredentialCurrent?(): boolean | Promise<boolean>;
  /** Bound by the receiving host to admitted foreign requester Account custody. */
  projectModelsForAccount?(request: DaemonProviderModelProjectionRequestV1, context: ActionExecutorContext): Promise<DaemonProviderModelProjectionResponseV1>;
  callMachineAction(input: Readonly<{
    machineId: string; serverId?: string; method: string; request: unknown; signal?: AbortSignal;
    authority?: ActionExecutorContext['authority']; authorization?: ActionExecutorContext['rpcSessionAuthorization'];
    context?: ActionExecutorContext; effectActionId?: string; exactMachine?: true;
    timeoutMs?: number | null;
  }>): Promise<unknown>;
}>): NonNullable<ActionExecutorDeps['providerActionExecute']> {
  const scopeKey = runWithServerHttpBaseUrl(params.serverHttpBaseUrl, () => resolveAccountSettingsScopeKey(params.credentials));
  const execute = createProviderActionExecuteV1({
    assertCurrent: context => {
      context.signal?.throwIfAborted();
      const active = params.operationContext ? params.operationContext.readSnapshot() : getActiveAccountSettingsSnapshot();
      if (params.operationContext && !active || active && active.scopeKey !== scopeKey) throw Object.assign(new Error('scope-retired'), { code: 'scope-retired' });
    },
    rpc: async ({ machineId, method, request, context, operationTimeoutMs }) => {
      if (params.operationContext && params.projectModelsForAccount
        && (request.actionId === 'providers.models.projection' || request.actionId === 'providers.models.refresh')
        && request.input.teamCredentialResources === undefined) {
        const catalog = await prepareProviderConnectionsCatalogForCli({ expectedScopeKey: scopeKey,
          operationContext: params.operationContext, signal: context.signal });
        if (catalog.status !== 'ready') return { status: 'error', error: createProviderErrorV1('provider_catalog_unavailable', { machineId }) };
        // The dispatch owner routes here only with the operand's exact Machine.
        return params.projectModelsForAccount({ ...request.input, machineId }, context);
      }
      return params.callMachineAction({
      machineId, serverId: params.serverId, method, request: request.input, signal: context.signal,
      authority: context.authority, authorization: context.rpcSessionAuthorization,
      context, effectActionId: request.actionId, exactMachine: true,
      ...(operationTimeoutMs === null ? { timeoutMs: null } : {}),
      });
    },
    setDefault: async (input, context) => setDefaultProviderModelSelection({ credentials: params.credentials, ...input, signal: context.signal }),
    account: createCliAccountProviderActionExecuteV1(params),
  });
  return (request, context) => runWithServerHttpBaseUrl(params.serverHttpBaseUrl, async () => {
    context.signal?.throwIfAborted();
    if (context.serverId && !await isServerProfileHomeIdentity(params.serverId, context.serverId)) {
      throw Object.assign(new Error('server_scope_mismatch'), { code: 'server_scope_mismatch' });
    }
    return execute(request, context);
  });
}
