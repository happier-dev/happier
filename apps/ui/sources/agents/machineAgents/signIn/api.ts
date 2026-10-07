import { AGENT_SIGN_IN_PREPARE_RPC_METHOD, AGENT_SIGN_IN_STATUS_RPC_METHOD, AgentSignInPrepareRequestSchema, AgentSignInPrepareResponseSchema, AgentSignInStatusRequestSchema, AgentSignInStatusResponseSchema, type AgentSignInPrepareRequest } from '@happier-dev/protocol/daemon/agentSignIn';
import { startMachineAgentSignIn, cancelMachineAgentSignIn } from '@happier-dev/protocol/daemon/startAgentSignIn';
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { runConnectedAccountAuthenticationCommand } from '@/sync/ops/connectedAccounts/connectedAccountDaemon';
import { machineTerminalEnsure, machineTerminalClose, machineTerminalList } from '@/sync/ops/machineTerminal';

export type AgentSignInTarget = Readonly<{ serverId?: string | null; machineId: string; signal?: AbortSignal }>;

export async function prepareAgentSignInRpc(target: AgentSignInTarget, input: AgentSignInPrepareRequest) {
  const payload = AgentSignInPrepareRequestSchema.parse(input);
  return AgentSignInPrepareResponseSchema.parse(await machineRpcWithServerScope<unknown, typeof payload>({
    serverId: target.serverId, machineId: target.machineId, signal: target.signal,
    method: AGENT_SIGN_IN_PREPARE_RPC_METHOD, payload,
  }));
}

export async function checkAgentSignInRpc(target: AgentSignInTarget, agentId: string) {
  const payload = AgentSignInStatusRequestSchema.parse({ agentId });
  return AgentSignInStatusResponseSchema.parse(await machineRpcWithServerScope<unknown, typeof payload>({
    serverId: target.serverId, machineId: target.machineId, signal: target.signal,
    method: AGENT_SIGN_IN_STATUS_RPC_METHOD, payload,
  }));
}

export async function startAgentSignInRpc(
  target: AgentSignInTarget,
  input: AgentSignInPrepareRequest,
  onNativeTerminalChanged?: (terminalId: string | null) => void,
) {
  const result = await startMachineAgentSignIn({ ...input, machineId: target.machineId }, {
    signal: target.signal,
    prepare: (request) => prepareAgentSignInRpc(target, request),
    beginConnect: (command) => runConnectedAccountAuthenticationCommand({
      serverId: target.serverId ?? null, machineId: target.machineId, command, signal: target.signal,
    }),
    ensureTerminal: async (request) => {
      const ensured = await machineTerminalEnsure(target.machineId, request, { serverId: target.serverId });
      if (ensured.ok) onNativeTerminalChanged?.(ensured.terminalId);
      return ensured;
    },
    closeTerminal: async (id) => {
      const closed = await machineTerminalClose(target.machineId, { terminalId: id }, { serverId: target.serverId });
      if (closed.ok) onNativeTerminalChanged?.(null);
      return closed;
    },
  });
  return result;
}

export async function cancelAgentSignInRpc(target: AgentSignInTarget, agentId: string, terminalId: string) {
  return await cancelMachineAgentSignIn({ machineId: target.machineId, agentId, terminalId }, {
    signal: target.signal,
    listTerminals: () => machineTerminalList(target.machineId, target),
    closeTerminal: (id) => machineTerminalClose(target.machineId, { terminalId: id }, target),
  });
}
