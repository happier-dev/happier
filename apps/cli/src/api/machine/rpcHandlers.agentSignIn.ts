import { randomUUID } from 'node:crypto';
import { resolveMachineAgentExecutionPlacementV1 } from '@happier-dev/protocol';
import {
  AGENT_SIGN_IN_PREPARE_RPC_METHOD,
  AGENT_SIGN_IN_STATUS_RPC_METHOD,
  AgentSignInPrepareRequestSchema,
  AgentSignInStatusRequestSchema,
} from '@happier-dev/protocol/daemon/agentSignIn';

import type { RpcHandlerRegistrar } from '../rpc/types';
import { prepareAgentSignIn, probeAgentSignInStatus } from '@/capabilities/cliAuth/agentSignIn';
import { projectIdentityFreeSignIn } from '@/capabilities/cliAuth/identityFreeSignIn';
import { selectHostRequesterExecutionIdentity } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';
import type { MachineTerminalRpcHandlerDeps } from './rpcHandlers.terminal';

export function registerMachineAgentSignInRpcHandlers(params: Readonly<{
  rpcHandlerManager: RpcHandlerRegistrar;
  deps?: Pick<MachineTerminalRpcHandlerDeps, 'agentIsolation' | 'nativeOperationRuntime' | 'resolveHostHomeServerIdentityId'>;
}>): void {
  params.rpcHandlerManager.registerHandler(AGENT_SIGN_IN_STATUS_RPC_METHOD, async (raw, context) => {
    const request = AgentSignInStatusRequestSchema.parse(raw);
    if (context?.machineAdmission?.role !== 'use') return await probeAgentSignInStatus(request.agentId);
    const snapshot = params.deps?.agentIsolation?.read();
    const placement = resolveMachineAgentExecutionPlacementV1({ policy: snapshot ?? { enabled: false }, platform: process.platform });
    const readNativeStatus = async () => {
      if (params.deps?.agentIsolation && !snapshot) return await probeAgentSignInStatus(request.agentId, null);
      if (placement === 'daemon') return await probeAgentSignInStatus(request.agentId);
      const runtime = params.deps?.nativeOperationRuntime;
      const home = await params.deps?.resolveHostHomeServerIdentityId?.(context.signal) ?? null;
      const identity = selectHostRequesterExecutionIdentity({ rpcContext: context, hostHomeServerIdentityId: home });
      if (!runtime || identity.kind !== 'isolated') return await probeAgentSignInStatus(request.agentId, null);
      // This probe selects no Account material and never borrows the daemon's
      // credential environment. Native UID/HOME and cleanup have one owner.
      const material = { materializationKey: randomUUID(), environment: {}, selectedMaterials: [] };
      let live = true;
      const operation = await runtime.prepareNativeOperation({
        requesterIdentity: identity,
        ingress: context,
        signal: context.signal,
        allowMemberPreparation: false,
        readMaterial: () => live ? material : undefined,
      });
      try {
        return await probeAgentSignInStatus(request.agentId, {
          agentIsolation: operation.agentIsolation,
          cwd: operation.workingDirectory,
          signal: context.signal,
          processEnv: { HOME: operation.memberIdentity?.home ?? operation.workingDirectory, PATH: process.env.PATH },
        });
      } finally {
        live = false;
        await operation.dispose();
      }
    };
    const status = await readNativeStatus().catch(() => probeAgentSignInStatus(request.agentId, null));
    // The verified ingress owns access. Project before transport encryption;
    // the Home cannot inspect an E2EE reply to remove Account identity.
    return {
      ...projectIdentityFreeSignIn(status),
      ...(params.deps?.agentIsolation && !snapshot
        ? {} : { signInScope: placement === 'daemon' ? 'machineOwner' as const : placement }),
    };
  });
  params.rpcHandlerManager.registerHandler(AGENT_SIGN_IN_PREPARE_RPC_METHOD, (raw) =>
    prepareAgentSignIn(AgentSignInPrepareRequestSchema.parse(raw)));
}
