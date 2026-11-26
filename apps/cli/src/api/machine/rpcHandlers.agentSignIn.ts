import { randomUUID } from 'node:crypto';
import { resolveMachineAgentExecutionPlacementV1 } from '@happier-dev/protocol/machines/agentIsolationV1';
import { MachineAccessGrantsListResponseV1Schema } from '@happier-dev/protocol/machines/machineAccessV1';
import {
  AGENT_SIGN_IN_PREPARE_RPC_METHOD,
  AGENT_SIGN_IN_STATUS_RPC_METHOD,
  AgentSignInPrepareRequestSchema,
  AgentSignInStatusRequestSchema,
} from '@happier-dev/protocol/daemon/agentSignIn';

import type { AgentSignInScope } from '@happier-dev/protocol/daemon/agentSignIn';
import type { RpcHandlerContext, RpcHandlerRegistrar } from '../rpc/types';
import { prepareAgentSignIn, probeAgentSignInStatus } from '@/capabilities/cliAuth/agentSignIn';
import { projectIdentityFreeSignIn } from '@/capabilities/cliAuth/identityFreeSignIn';
import { isHostAgentIsolationPolicyUnread, resolveHostRequesterTerminalPlacementForHost, selectHostRequesterExecutionIdentity } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';
import type { MachineTerminalRpcHandlerDeps } from './rpcHandlers.terminal';

type AgentSignInRpcDeps = Pick<MachineTerminalRpcHandlerDeps, 'agentIsolation' | 'nativeOperationRuntime' | 'resolveHostHomeServerIdentityId'> & Readonly<{
  readSignInConnectedDefaultSelection?: (agentId: string, context: RpcHandlerContext) => Promise<import('@/session/services/agentConnectedDefaultRoutes').CliConnectedDefaultSelection>;
  readSignInMachineAccess?: (signal: AbortSignal) => Promise<unknown>;
}>;

/**
 * Which OS user this caller's native sign-in lands in, as its admission places it: the one producer for both
 * Status and Prepare. Only Prepare checks whether the custodian's own OS user is shared with other people.
 */
async function resolveNativeSignInScope(
  context: RpcHandlerContext | undefined,
  deps: AgentSignInRpcDeps | undefined,
  phase: 'status' | 'prepare',
  snapshot = deps?.agentIsolation?.read(),
): Promise<AgentSignInScope | undefined> {
  const role = context?.machineAdmission?.role;
  if (context && role === 'manage') {
    const home = deps?.resolveHostHomeServerIdentityId
      ? await deps.resolveHostHomeServerIdentityId(context.signal).catch(() => null)
      : context.callerInputAuthorization?.binding.serverIdentityId ?? null;
    const identity = selectHostRequesterExecutionIdentity({ rpcContext: context, hostHomeServerIdentityId: home });
    try {
      if (resolveHostRequesterTerminalPlacementForHost({ identity, readPolicy: () => deps?.agentIsolation?.read() }) !== 'person')
        return undefined;
    } catch { return undefined; /* An unread isolation policy reports no scope. */ }
    const admission = context.machineAdmission;
    if (phase !== 'prepare' || !admission || admission.actorAccountId !== admission.custodianAccountId)
      return 'machineOwner';

    const raw = await deps?.readSignInMachineAccess?.(context.signal).catch(() => undefined);
    const access = MachineAccessGrantsListResponseV1Schema.safeParse(raw);
    if (!access.success || access.data.machineId !== admission.machineId
      || access.data.custodian.accountId !== admission.custodianAccountId
      || !access.data.canManage || access.data.access.accessState !== 'ready' || !access.data.currentRequesterDisplayIdentities)
      return 'machineOwner';

    const others = access.data.currentRequesterDisplayIdentities.filter(person => person.accountId !== admission.custodianAccountId);
    if (others.length === 0) return 'member';
    if (!snapshot?.enabled || isHostAgentIsolationPolicyUnread(snapshot)) return 'machineOwner';
    // Losing all access when a View grant is removed proves the person is Use-only.
    // Surviving access can include inherited Manage, whose role the roster does not expose.
    const useOnly = new Set(access.data.grants.flatMap(grant => grant.level === 'view' ? grant.removal.losesAccessAccountIds : []));
    return others.every(person => useOnly.has(person.accountId)) ? 'member' : 'machineOwner';
  }
  if (role !== 'use' || deps?.agentIsolation && !snapshot) return undefined;
  const placement = resolveMachineAgentExecutionPlacementV1({ policy: snapshot ?? { enabled: false }, platform: process.platform });
  return placement === 'daemon' ? 'machineOwner' : placement;
}

export function registerMachineAgentSignInRpcHandlers(params: Readonly<{
  rpcHandlerManager: RpcHandlerRegistrar;
  deps?: AgentSignInRpcDeps;
}>): void {
  params.rpcHandlerManager.registerHandler(AGENT_SIGN_IN_STATUS_RPC_METHOD, async (raw, context) => {
    const request = AgentSignInStatusRequestSchema.parse(raw);
    const readCredentialSource = async (status: Awaited<ReturnType<typeof probeAgentSignInStatus>>) => {
      if (!context || !params.deps?.readSignInConnectedDefaultSelection) return status;
      const selection = await params.deps.readSignInConnectedDefaultSelection(request.agentId, context);
      return { ...status, credentialSource: selection === 'native' ? status.credentialSource : selection };
    };
    if (context?.machineAdmission?.role !== 'use') {
      const status = await readCredentialSource(await probeAgentSignInStatus(request.agentId));
      const signInScope = await resolveNativeSignInScope(context, params.deps, 'status');
      return signInScope ? { ...status, signInScope } : status;
    }
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
    const status = await readCredentialSource(await readNativeStatus().catch(() => probeAgentSignInStatus(request.agentId, null)));
    const signInScope = await resolveNativeSignInScope(context, params.deps, 'status', snapshot);
    // The verified ingress owns access. Project before transport encryption;
    // the Home cannot inspect an E2EE reply to remove Account identity.
    return { ...projectIdentityFreeSignIn(status), ...(signInScope ? { signInScope } : {}) };
  });
  params.rpcHandlerManager.registerHandler(AGENT_SIGN_IN_PREPARE_RPC_METHOD, async (raw, context) => {
    const prepared = prepareAgentSignIn(AgentSignInPrepareRequestSchema.parse(raw));
    if (!('method' in prepared) || prepared.method !== 'native') return prepared;
    // The start sequence decides from this whether its person confirms before the launch.
    const signInScope = await resolveNativeSignInScope(context, params.deps, 'prepare');
    return signInScope ? { ...prepared, signInScope } : prepared;
  });
}
