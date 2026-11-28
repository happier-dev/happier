import { randomUUID } from 'node:crypto';
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
import { isHostAgentIsolationPolicyUnread, resolveHostRequesterTerminalIdentityForHost, resolveHostRequesterTerminalPlacementForHost, selectHostRequesterExecutionIdentity } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';
import type { MachineTerminalRpcHandlerDeps } from './rpcHandlers.terminal';

type AgentSignInRpcDeps = Pick<MachineTerminalRpcHandlerDeps, 'agentIsolation' | 'nativeOperationRuntime' | 'resolveHostHomeServerIdentityId'> & Readonly<{
  readSignInConnectedDefaultSelection?: (agentId: string, context: RpcHandlerContext) => Promise<import('@/session/services/agentConnectedDefaultRoutes').CliConnectedDefaultSelection>;
  readSignInMachineAccess?: (signal: AbortSignal) => Promise<unknown>;
}>;

async function resolveUseSignInPlacement(
  context: RpcHandlerContext,
  deps: AgentSignInRpcDeps | undefined,
  snapshot = deps?.agentIsolation?.read(),
) {
  if (deps?.agentIsolation && !snapshot) return undefined;
  const home = await deps?.resolveHostHomeServerIdentityId?.(context.signal).catch(() => null) ?? null;
  const identity = selectHostRequesterExecutionIdentity({ rpcContext: context, hostHomeServerIdentityId: home });
  if (identity.kind === 'unknown') return undefined;
  try {
    const placement = resolveHostRequesterTerminalPlacementForHost({ identity, readPolicy: () => snapshot });
    // The sign-in terminal runs as the identity its placement selects.
    if (placement) return { identity: resolveHostRequesterTerminalIdentityForHost(identity, placement), placement,
      memberManager: identity.kind === 'owner_person' && identity.machineManager === true && placement === 'member' };
  } catch {
    // The sign-in projection leaves scope absent while the Machine policy is unread.
  }
}

function projectSignInScope(placement: NonNullable<ReturnType<typeof resolveHostRequesterTerminalPlacementForHost>>): AgentSignInScope {
  return placement === 'daemon' || placement === 'person' ? 'machineOwner' : placement;
}

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
      const placement = resolveHostRequesterTerminalPlacementForHost({ identity, readPolicy: () => deps?.agentIsolation?.read() });
      // A Manage grantee placed as their member user signs in there (owner ruling 2026-11-27).
      if (placement === 'member' && identity.kind === 'owner_person') return 'member';
      if (placement !== 'person') return undefined;
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
  if (!context || role !== 'use') return undefined;
  const placed = await resolveUseSignInPlacement(context, deps, snapshot);
  return placed && projectSignInScope(placed.placement);
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
    const admission = context?.machineAdmission;
    // A Manage grantee placed as their member user reads that member's sign-in (owner ruling 2026-11-27).
    const placed = context && (admission?.role === 'use' || admission?.role === 'manage' && admission.actorAccountId !== admission.custodianAccountId)
      ? await resolveUseSignInPlacement(context, params.deps).catch(() => undefined) : undefined;
    if (!context || admission?.role !== 'use' && !placed?.memberManager) {
      const status = await readCredentialSource(await probeAgentSignInStatus(request.agentId));
      const signInScope = await resolveNativeSignInScope(context, params.deps, 'status');
      return signInScope ? { ...status, signInScope } : status;
    }
    const readNativeStatus = async () => {
      if (!placed) return await probeAgentSignInStatus(request.agentId, null);
      if (placed.placement === 'daemon' || placed.placement === 'person') return await probeAgentSignInStatus(request.agentId);
      const runtime = params.deps?.nativeOperationRuntime;
      const { identity } = placed;
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
    const signInScope = placed && projectSignInScope(placed.placement);
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
