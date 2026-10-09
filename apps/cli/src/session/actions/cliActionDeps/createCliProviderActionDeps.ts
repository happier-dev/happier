import type { ActionExecutorContext, ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { createProviderActionExecuteV1 } from '@happier-dev/protocol/providers/executeProviderActionV1';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type { StoredCredentials } from '@/persistence';
import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import type { SavedSecretOperationContextV1 } from '@/settings/secrets/hydrateSavedSecretCatalog';
import { setDefaultProviderModelSelection } from '@/providers/connections/service/settings';

/** Provider Actions share the admitted CLI Home and its incumbent exact-Machine RPC transport. */
export function createCliProviderActionExecuteV1(params: Readonly<{
  credentials: StoredCredentials; serverId: string; serverHttpBaseUrl: string;
  operationContext?: SavedSecretOperationContextV1;
  callMachineAction(input: Readonly<{
    machineId: string; serverId?: string; method: string; request: unknown; signal?: AbortSignal;
    authority?: ActionExecutorContext['authority']; authorization?: ActionExecutorContext['rpcSessionAuthorization'];
    context?: ActionExecutorContext; effectActionId?: string; exactMachine?: true;
  }>): Promise<unknown>;
}>): NonNullable<ActionExecutorDeps['providerActionExecute']> {
  const scopeKey = runWithServerHttpBaseUrl(params.serverHttpBaseUrl, () => resolveAccountSettingsScopeKey(params.credentials));
  const execute = createProviderActionExecuteV1({
    assertCurrent: context => {
      context.signal?.throwIfAborted();
      if (context.serverId && context.serverId !== params.serverId) throw Object.assign(new Error('server_scope_mismatch'), { code: 'server_scope_mismatch' });
      const active = params.operationContext ? params.operationContext.readSnapshot() : getActiveAccountSettingsSnapshot();
      if (params.operationContext && !active || active && active.scopeKey !== scopeKey) throw Object.assign(new Error('scope-retired'), { code: 'scope-retired' });
    },
    rpc: ({ machineId, method, request, context }) => params.callMachineAction({
      machineId, serverId: params.serverId, method, request: request.input, signal: context.signal,
      authority: context.authority, authorization: context.rpcSessionAuthorization,
      context, effectActionId: request.actionId, exactMachine: true,
    }),
    setDefault: (input, context) => setDefaultProviderModelSelection({ credentials: params.credentials, ...input, signal: context.signal }),
  });
  return (request, context) => runWithServerHttpBaseUrl(params.serverHttpBaseUrl, () => execute(request, context));
}
