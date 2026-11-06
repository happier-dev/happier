import { projectAutomationEligibleEventsCatalogV1 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import type { CliActionDepsParams } from './types';
import type { CliMachineActionCall, CliMachineActionServerScopeCurrent } from './machineTransport';
import { AGENT_SIGN_IN_STATUS_RPC_METHOD, AgentSignInStatusResponseSchema } from '@happier-dev/protocol/daemon/agentSignIn';
import { startMachineAgentSignIn, cancelMachineAgentSignIn, restartMachineAgentSignIn } from '@happier-dev/protocol/daemon/startAgentSignIn';
import { buildMachineAgentsDetectRequest, buildMachineAgentInventoryDescriptors, projectMachineAgentsDetectResponse, projectAcpCatalogForMachineInventory, MachineAgentInventoryUnavailableError } from '@happier-dev/protocol/capabilities/machineAgentInventory';
import { DaemonContributionRegistryProjectionDescribeResponseSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { AGENT_SIGN_IN_PREPARE_RPC_METHOD } from '@happier-dev/protocol/daemon/agentSignIn';
import { ConnectedAccountAttemptResponseSchema, CONNECTED_ACCOUNT_AUTHENTICATION_COMMAND_RPC_METHOD } from '@happier-dev/protocol/connect/connectedAccountDaemonRpcV1';
import { DaemonTerminalEnsureResponseSchema, DaemonTerminalListResponseV1Schema, DaemonTerminalCloseResponseSchema } from '@happier-dev/protocol/daemon/terminal';
import type { createCliActionInventoryDeps } from './createCliActionInventoryDeps';
import type { ActionExecutorDeps } from '@happier-dev/protocol';
export function createCliMachineInventoryActionDeps(
  params: Pick<CliActionDepsParams, 'credentials' | 'machineActionDirectTargetTransport' | 'serverHttpBaseUrl'>,
  { callMachineAction, inventoryDeps }: Readonly<{
    callMachineAction: CliMachineActionCall;
    inventoryDeps: ReturnType<typeof createCliActionInventoryDeps>;
  }>,
): Pick<ActionExecutorDeps, 'machinesAgentsList' | 'machineAgentSignInStart' | 'machineAgentSignInStatus' | 'machineAgentSignInCancel' | 'machineAgentSignInRestart' | 'workflowEventsList'> {
  const signInOperations = (target: Readonly<{ machineId: string; serverId?: string; signal?: AbortSignal }>): Parameters<typeof restartMachineAgentSignIn>[1] => {
    const { machineId, serverId, signal } = target;
    return {
      signal,
      prepare: (request) => callMachineAction({ machineId, serverId, method: AGENT_SIGN_IN_PREPARE_RPC_METHOD, request, signal }),
      beginConnect: async (command) => ConnectedAccountAttemptResponseSchema.parse(await callMachineAction({
        machineId, serverId, method: CONNECTED_ACCOUNT_AUTHENTICATION_COMMAND_RPC_METHOD, request: { v: 1, machineId, command }, signal,
      })),
      ensureTerminal: async (request) => DaemonTerminalEnsureResponseSchema.parse(await callMachineAction({
        machineId, serverId, method: RPC_METHODS.DAEMON_TERMINAL_ENSURE, request,
      })),
      listTerminals: async () => DaemonTerminalListResponseV1Schema.parse(await callMachineAction({
        machineId, serverId, method: RPC_METHODS.DAEMON_TERMINAL_LIST, request: {}, signal,
      })),
      // Cleanup must retain an acquired process even after the initiating request aborts.
      closeTerminal: async (terminalId) => DaemonTerminalCloseResponseSchema.parse(await callMachineAction({
        machineId, serverId, method: RPC_METHODS.DAEMON_TERMINAL_CLOSE, request: { terminalId },
      })),
    };
  };
  return {
    machinesAgentsList: async (args, context) => {
      if (!params.credentials && params.machineActionDirectTargetTransport?.machineId !== args.machineId) {
        return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      }
      try {
        const readInventory = async () => {
          const protectedRequest = context.externalActionCredential || context.externalActionExecutionAuthorization
            ? { context, effectActionId: context.externalActionExecutionAuthorization?.binding.actionId ?? 'machines.agents.list' } : {};
          if (args.draftDefinitions) {
            const definitions = args.definitionId
              ? args.draftDefinitions.filter(definition => definition.definitionId === args.definitionId) : args.draftDefinitions;
            const request = buildMachineAgentsDetectRequest({ agents: [], definitions, refresh: args.refresh });
            const response = await callMachineAction({ machineId: args.machineId, serverId: args.serverId,
              method: RPC_METHODS.CAPABILITIES_DETECT, request, ...protectedRequest, ...(context.signal ? { signal: context.signal } : {}) });
            return projectMachineAgentsDetectResponse({ agents: [], definitions, response });
          }
          const roster = DaemonContributionRegistryProjectionDescribeResponseSchema.safeParse(await callMachineAction({
            machineId: args.machineId,
            serverId: args.serverId,
            method: RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE,
            request: { machineId: args.machineId, selection: 'agents' },
            ...protectedRequest,
            ...(context.signal ? { signal: context.signal } : {}),
          }));
          if (!roster.success) throw new MachineAgentInventoryUnavailableError(args.agentId ?? 'unknown');
          const agents = buildMachineAgentInventoryDescriptors(roster.data.projection)
            .filter(({ agentId }) => !args.agentId || args.agentId === agentId);
          const binding = context.externalActionExecutionAuthorization?.binding;
          // A foreign root admits Machine facts, not this executor's Account catalog.
          // Requester-owned definitions arrive only through the draft path above.
          const observedDefinitions: ReturnType<typeof projectAcpCatalogForMachineInventory> = binding && binding.accountId !== binding.custodianAccountId
            ? { definitionCatalog: { status: 'unavailable', reason: 'requester-account-unavailable' } }
            : !args.agentId || args.definitionId
              ? projectAcpCatalogForMachineInventory(await inventoryDeps.readAccountAcpCatalog({ signal: context.signal })) : {};
          const definitionInventory = args.definitionId && 'definitions' in observedDefinitions
            ? { ...observedDefinitions, definitions: observedDefinitions.definitions?.filter(definition => definition.definitionId === args.definitionId) }
            : observedDefinitions;
          const request = buildMachineAgentsDetectRequest({ agents, ...definitionInventory, refresh: args.refresh });
          if (request.requests?.length === 0) return { items: [],
            ...('definitionCatalog' in definitionInventory && definitionInventory.definitionCatalog ? { definitionCatalog: definitionInventory.definitionCatalog } : {}) };
          const response = await callMachineAction({
            machineId: args.machineId,
            serverId: args.serverId,
            method: RPC_METHODS.CAPABILITIES_DETECT,
            request,
            ...protectedRequest,
            ...(context.signal ? { signal: context.signal } : {}),
          });
          return projectMachineAgentsDetectResponse({ agents, response, ...definitionInventory });
        };
        return await (params.serverHttpBaseUrl
          ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, readInventory)
          : readInventory());
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'server_scope_mismatch') {
          return { ok: false, errorCode: 'server_scope_mismatch', error: 'server_scope_mismatch' };
        }
        if (error instanceof MachineAgentInventoryUnavailableError) {
          return { ok: false, errorCode: error.code, error: error.message };
        }
        throw error;
      }
    },
    machineAgentSignInStart: async ({ machineId, signal, serverId, ...request }) => {
      if (!params.credentials && params.machineActionDirectTargetTransport?.machineId !== machineId) {
        return { ok: false, errorCode: 'sign_in_unavailable', error: 'An authenticated machine transport is required.' };
      }
      return startMachineAgentSignIn({ ...request, machineId }, signInOperations({ machineId, serverId, signal }));
    },
    machineAgentSignInStatus: async ({ machineId, signal, serverId, agentId }, context) => {
      if (!params.credentials && params.machineActionDirectTargetTransport?.machineId !== machineId) {
        throw Object.assign(new Error('An authenticated machine transport is required.'), { code: 'sign_in_unavailable' });
      }
      return AgentSignInStatusResponseSchema.parse(await callMachineAction({
        machineId, serverId, method: AGENT_SIGN_IN_STATUS_RPC_METHOD, request: { agentId }, signal,
        context, effectActionId: context.externalActionExecutionAuthorization?.binding.actionId ?? 'machines.agents.signIn.status',
      }));
    },
    machineAgentSignInCancel: async ({ machineId, serverId, signal, ...request }) => {
      if (!params.credentials && params.machineActionDirectTargetTransport?.machineId !== machineId) {
        return { ok: false, errorCode: 'sign_in_unavailable', error: 'An authenticated machine transport is required.' };
      }
      return await cancelMachineAgentSignIn({ ...request, machineId }, signInOperations({ machineId, serverId, signal }));
    },
    machineAgentSignInRestart: async ({ machineId, serverId, signal, ...request }) => {
      if (!params.credentials && params.machineActionDirectTargetTransport?.machineId !== machineId) {
        return { ok: false, errorCode: 'sign_in_unavailable', error: 'An authenticated machine transport is required.' };
      }
      return await restartMachineAgentSignIn({ ...request, machineId }, signInOperations({ machineId, serverId, signal }));
    },
  
    workflowEventsList: async (args, context) => {
      if (!params.credentials && params.machineActionDirectTargetTransport?.machineId !== args.machineId) {
        return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      }
      try {
        const readCatalog = async () => {
          const response = DaemonContributionRegistryProjectionDescribeResponseSchema.safeParse(await callMachineAction({
            machineId: args.machineId, serverId: args.serverId,
            method: RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE,
            request: { machineId: args.machineId },
            ...(context.signal ? { signal: context.signal } : {}),
          }));
          if (!response.success || response.data.automationEligibleEvents === undefined) {
            return { ok: false as const, errorCode: 'workflow_event_catalog_unavailable', error: 'workflow_event_catalog_unavailable' };
          }
          return { machineId: args.machineId, events: projectAutomationEligibleEventsCatalogV1(response.data.automationEligibleEvents) };
        };
        return await (params.serverHttpBaseUrl
          ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, readCatalog) : readCatalog());
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'server_scope_mismatch') {
          return { ok: false, errorCode: 'server_scope_mismatch', error: 'server_scope_mismatch' };
        }
        throw error;
      }
    },
  };
}
