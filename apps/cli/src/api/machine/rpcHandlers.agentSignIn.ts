import {
  AGENT_SIGN_IN_PREPARE_RPC_METHOD,
  AGENT_SIGN_IN_STATUS_RPC_METHOD,
  AgentSignInPrepareRequestSchema,
  AgentSignInStatusRequestSchema,
} from '@happier-dev/protocol/daemon/agentSignIn';

import type { RpcHandlerRegistrar } from '../rpc/types';
import { prepareAgentSignIn, probeAgentSignInStatus } from '@/capabilities/cliAuth/agentSignIn';

export function registerMachineAgentSignInRpcHandlers(params: Readonly<{
  rpcHandlerManager: RpcHandlerRegistrar;
}>): void {
  params.rpcHandlerManager.registerHandler(AGENT_SIGN_IN_STATUS_RPC_METHOD, async (raw) => {
    const request = AgentSignInStatusRequestSchema.parse(raw);
    return await probeAgentSignInStatus(request.agentId);
  });
  params.rpcHandlerManager.registerHandler(AGENT_SIGN_IN_PREPARE_RPC_METHOD, (raw) =>
    prepareAgentSignIn(AgentSignInPrepareRequestSchema.parse(raw)));
}
