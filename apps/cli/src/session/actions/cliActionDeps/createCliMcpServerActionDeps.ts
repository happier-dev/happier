import type { ActionExecutorContext, ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { createMcpServerActionExecuteV1, projectMcpServerActionFailureV1,
  MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/mcp/servers/serverActionsV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { readRpcRequestDisposition } from '@happier-dev/sync-client';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type { StoredCredentials } from '@/persistence';
import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { createCliMcpServerStore, createCliMcpServerStoreForOperation } from '@/settings/mcp/mcpServerStore';
import type { SavedSecretOperationContextV1 } from '@/settings/secrets/hydrateSavedSecretCatalog';

/** Catalog and Machine operations retain the exact CLI invocation's Home and Account. */
export function createCliMcpServerActionExecuteV1(params: Readonly<{
  credentials: StoredCredentials; serverId: string; serverHttpBaseUrl: string;
  operationContext?: SavedSecretOperationContextV1;
  callMachineAction(input: Readonly<{
    machineId: string; serverId?: string; method: string; request: unknown; signal?: AbortSignal;
    authority?: ActionExecutorContext['authority']; authorization?: ActionExecutorContext['rpcSessionAuthorization'];
    context?: ActionExecutorContext; effectActionId?: string; exactMachine?: true;
  }>): Promise<unknown>;
}>): NonNullable<ActionExecutorDeps['mcpServerAction']> {
  return request => runWithServerHttpBaseUrl(params.serverHttpBaseUrl, async () => {
    const { context } = request;
    if (context.serverId && context.serverId !== params.serverId) {
      return { ok: false, errorCode: 'server_scope_mismatch', error: 'server_scope_mismatch' };
    }
    try {
      context.signal?.throwIfAborted();
      if (params.operationContext) {
        if (!await params.operationContext.isCurrent()) throw Object.assign(new Error('scope-retired'), { code: 'scope-retired' });
      } else if (!getActiveAccountSettingsSnapshot()) {
        await bootstrapAccountSettingsContext({ credentials: params.credentials, mode: 'blocking' });
      }
      const store = params.operationContext
        ? createCliMcpServerStoreForOperation({ operationContext: params.operationContext, serverId: params.serverId, signal: context.signal })
        : createCliMcpServerStore({ credentials: params.credentials, serverId: params.serverId, signal: context.signal });
      store.assertCurrent();
      const assertCurrent = async () => {
        store.assertCurrent();
        if (params.operationContext && !await params.operationContext.isCurrent()) {
          throw Object.assign(new Error('scope-retired'), { code: 'scope-retired' });
        }
        store.assertCurrent();
      };
      let admittedCatalog: ReturnType<typeof store.readCatalogForOperation> | undefined;
      const readCatalog = async () => {
        const snapshot = await (admittedCatalog ??= store.readCatalogForOperation());
        await assertCurrent();
        return snapshot;
      };
      return await createMcpServerActionExecuteV1({
        readCatalog,
        mutate: async (change, expectedRevision) => store.mutate(change, expectedRevision, await readCatalog()),
        machine: async ({ actionId, input, machineId }) => {
          await assertCurrent();
          let response: unknown;
          try {
            response = await params.callMachineAction({ machineId, serverId: params.serverId,
              method: actionId === 'mcp.servers.test' ? RPC_METHODS.DAEMON_MCP_SERVERS_TEST : RPC_METHODS.DAEMON_MCP_SERVERS_DETECT,
              request: input, signal: context.signal, authority: context.authority,
              authorization: context.rpcSessionAuthorization, context, effectActionId: actionId, exactMachine: true });
          } catch (cause) {
            const refusal = projectMcpServerActionFailureV1(cause);
            const disposition = readRpcRequestDisposition(cause);
            if (actionId === 'mcp.servers.test' && (disposition === 'outcomeUnknown'
              || refusal.errorCode === 'mcp_catalog_operation_failed')) {
              throw Object.assign(new Error('MCP test disposition'), { code: disposition === 'notSent'
                ? 'machine_unreachable' : 'outcome_unknown' });
            }
            throw cause;
          }
          const parsed = MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1[actionId].safeParse(response);
          if (!parsed.success) throw Object.assign(new Error('Invalid MCP Machine receipt'), {
            code: actionId === 'mcp.servers.test' ? 'outcome_unknown' : 'invalid_action_output' });
          if (actionId === 'mcp.servers.probe') {
            await assertCurrent();
          }
          return parsed.data;
        },
      })(request);
    } catch (cause) { return projectMcpServerActionFailureV1(cause); }
  });
}
