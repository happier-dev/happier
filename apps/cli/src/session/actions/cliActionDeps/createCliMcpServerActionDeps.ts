import type { ActionExecutorContext, ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { createMcpServerActionExecuteV1, projectMcpServerActionFailureV1,
  MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/mcp/servers/serverActionsV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { readRpcRequestDisposition } from '@happier-dev/sync-client';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type { StoredCredentials } from '@/persistence';
import { isServerProfileHomeIdentity } from '@/server/serverProfiles';
import type { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import type { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import type { createCliMcpServerStore, createCliMcpServerStoreForOperation } from '@/settings/mcp/mcpServerStore';
import type { SavedSecretOperationContextV1 } from '@/settings/secrets/hydrateSavedSecretCatalog';
import type { listCurrentAccountMachines, resolveCurrentAccountAdministrationMachine } from '@/api/machine/resolveCurrentAccountMachineTarget';
import { CONNECTED_ACCOUNT_CONTROL_COMMAND_RPC_METHOD, ConnectedAccountControlCommandRequestSchema } from '@happier-dev/protocol/connect/connectedAccountDaemonRpcV1';
import type { readCatalogEntriesSnapshot } from '@/agent/catalog/registry';
import type { readPluginMcpServerMetadata } from '@/mcp/runtime/pluginMcpServerItems';
import type { resolveCliHomeTarget } from '@/server/homeTarget';

/** Catalog and Machine operations retain the exact CLI invocation's Home and Account. */
export function createCliMcpServerActionExecuteV1(params: Readonly<{
  credentials: StoredCredentials; serverId: string; serverHttpBaseUrl: string;
  operationContext?: SavedSecretOperationContextV1;
  connectedServiceAction?: ActionExecutorDeps['connectedServiceAction'];
  registryActionExecute?: ActionExecutorDeps['registryActionExecute'];
  personalSavedSecretActionExecute?: ActionExecutorDeps['personalSavedSecretActionExecute'];
  callMachineAction(input: Readonly<{
    machineId: string; serverId?: string; method: string; request: unknown; signal?: AbortSignal;
    authority?: ActionExecutorContext['authority']; authorization?: ActionExecutorContext['rpcSessionAuthorization'];
    context?: ActionExecutorContext; effectActionId?: string; exactMachine?: true;
  }>): Promise<unknown>;
}>): NonNullable<ActionExecutorDeps['mcpServerAction']> {
  return request => runWithServerHttpBaseUrl(params.serverHttpBaseUrl, async (): Promise<ActionExecuteResult> => {
    const { context } = request;
    if (context.serverId && !await isServerProfileHomeIdentity(params.serverId, context.serverId)) {
      return { ok: false, errorCode: 'server_scope_mismatch', error: 'server_scope_mismatch' };
    }
    try {
      context.signal?.throwIfAborted();
      if (params.operationContext) {
        if (!await params.operationContext.isCurrent()) throw Object.assign(new Error('scope-retired'), { code: 'scope-retired' });
      } else {
        const { getActiveAccountSettingsSnapshot } = await import("@/settings/accountSettings/activeAccountSettingsSnapshot");
        if (!getActiveAccountSettingsSnapshot()) {
        const { bootstrapAccountSettingsContext } = await import("@/settings/accountSettings/bootstrapAccountSettingsContext");
        await bootstrapAccountSettingsContext({ credentials: params.credentials, mode: 'blocking' });
      }
      }
      const { createCliMcpServerStoreForOperation, createCliMcpServerStore } = await import("@/settings/mcp/mcpServerStore");
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
        resolveWebappUrl: async () => {
          const { resolveCliHomeTarget } = await import("@/server/homeTarget");
          const target = await resolveCliHomeTarget({ kind: 'saved_profile', profileRef: params.serverId }).catch(cause => {
            if (!cause || typeof cause !== 'object' || !('code' in cause) || cause.code !== 'profile_missing') throw cause;
            return resolveCliHomeTarget({ kind: 'https_url', url: params.serverHttpBaseUrl });
          });
          await assertCurrent();
          return target.webappUrl;
        },
        registryActionExecute: params.registryActionExecute,
        personalSavedSecretActionExecute: params.personalSavedSecretActionExecute,
        readImportLink: async url => {
          await assertCurrent();
          const target = new URL(url);
          if (target.protocol !== 'https:' || target.username || target.password) throw Object.assign(new Error('Invalid config URL'), { code: 'invalid_registry_input' });
          const response = await fetch(target, { signal: context.signal, redirect: 'error' });
          if (!response.ok) throw Object.assign(new Error('Config link unavailable'), { code: 'registry_unavailable' });
          const text = await response.text(); await assertCurrent(); return text;
        },
        connectedServiceAction: params.connectedServiceAction,
        resolveAdministrationMachine: async () => {
          await assertCurrent();
          const requestedMachineId = context.externalActionTarget?.kind === 'machine'
            ? context.externalActionTarget.machineId : context.defaultSessionMachineId ?? undefined;
          const { resolveCurrentAccountAdministrationMachine } = await import("@/api/machine/resolveCurrentAccountMachineTarget");
          const machineId = await resolveCurrentAccountAdministrationMachine({ token: params.credentials.token,
            authorization: context.externalActionExecutionAuthorization, effectActionId: request.actionId,
            serverHttpBaseUrl: params.serverHttpBaseUrl, signal: context.signal,
            ...(requestedMachineId === undefined ? {} : { requestedMachineId }) });
          await assertCurrent();
          return machineId;
        },
        describeConnectedService: async (machineId, command) => {
          await assertCurrent();
          return params.callMachineAction({ machineId, serverId: params.serverId,
            method: CONNECTED_ACCOUNT_CONTROL_COMMAND_RPC_METHOD,
            request: ConnectedAccountControlCommandRequestSchema.parse({ v: 1, machineId,
              command }),
            context, signal: context.signal, authority: context.authority,
            authorization: context.rpcSessionAuthorization, effectActionId: request.actionId, exactMachine: true });
        },
        readCatalog,
        readPluginItems: async () => { 
        const { readPluginMcpServerMetadata } = await import("@/mcp/runtime/pluginMcpServerItems");
        const items = await readPluginMcpServerMetadata(); await assertCurrent(); return items; },
        readToolAgentFacts: async () => {
          await assertCurrent();
          const [{ listCurrentAccountMachines }, { readCatalogEntriesSnapshot }] = await Promise.all([import("@/api/machine/resolveCurrentAccountMachineTarget"), import("@/agent/catalog/registry")]);
          const machines = await listCurrentAccountMachines({ token: params.credentials.token, credentials: params.credentials,
            authorization: context.externalActionExecutionAuthorization, effectActionId: request.actionId,
            serverHttpBaseUrl: params.serverHttpBaseUrl, signal: context.signal }).catch((cause: unknown) => {
              context.signal?.throwIfAborted();
              if (cause && typeof cause === 'object' && 'code' in cause && cause.code === 'machine_inventory_unavailable') return null;
              throw cause;
            });
          await assertCurrent();
          if (machines === null) return null;
          const installed = new Set(machines.filter(machine => machine.kind === 'persistent' && !machine.revokedAt)
            .flatMap(machine => machine.agentInventory?.installedAgentIds ?? []));
          const agents = Object.values(readCatalogEntriesSnapshot()).filter(entry => installed.has(entry.id)).map(entry => ({ agentId: entry.id,
            ...(entry.mcpToolControl === undefined ? {} : { mcpToolControl: entry.mcpToolControl }),
            ...(entry.mcpToolLoading === undefined ? {} : { mcpToolLoading: entry.mcpToolLoading }),
          }));
          await assertCurrent();
          return { agents };
        },
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
          if (actionId === 'mcp.found.list') {
            await assertCurrent();
          }
          return parsed.data;
        },
      })(request);
    } catch (cause) { return projectMcpServerActionFailureV1(cause,
      request.actionId === 'mcp.servers.signIn.start' ? 'host_admission' : undefined); }
  });
}
