import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { join } from 'node:path';
import type { WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import type { WorkspaceActivationRequestV1 } from '@happier-dev/protocol/projects/openProjectV1';
import { resolveWorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import type { HostRequesterExecutionIdentity } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';
import type { readAgentIsolationMemberWorkspaceRoot } from '@/daemon/agentIsolation/agentIsolationNativeIdentity';

type MemberRoot = Awaited<ReturnType<typeof readAgentIsolationMemberWorkspaceRoot>>;

export type PrivateProjectCheckoutRefusalReason = 'workspace_private_checkout_required'
  | 'workspace_private_checkout_review_required' | 'workspace_git_metadata_shared' | 'workspace_private_checkout_retired';

/** One private checkout refusal vocabulary; outer owners log its non-content
 * diagnostic without widening Open's strict public result. */
export function privateProjectCheckoutRefusal(reason: PrivateProjectCheckoutRefusalReason = 'workspace_private_checkout_required'): PluginError {
  return new PluginError({ code: reason === 'workspace_private_checkout_review_required' ? reason : 'workspace_private_checkout_required',
    message: 'Private checkout is unavailable', retryable: false,
    details: { reason, phase: 'native_execution_admission' } });
}

export type PrivateProjectCheckout = Readonly<{
  workspaceRefId: string;
  rootPath: string;
  destinationParentPath: string;
  destinationDirectoryName: string;
}>;

export type PreparePrivateProjectCheckoutInput = Readonly<{
  requesterIdentity: HostRequesterExecutionIdentity;
  memberRoot: MemberRoot;
  workspaceRefs: readonly WorkspaceRefV1[];
  workspaceRefId?: string;
  createId(): string;
}>;

/** Every private checkout identity denotes one direct child of the member root. */
export function resolvePrivateProjectCheckoutRoot(workspaceRoot: string, workspaceRefId: string): string {
  if (!workspaceRefId || workspaceRefId.trim() !== workspaceRefId || /[\\/\0]/u.test(workspaceRefId)
    || workspaceRefId === '.' || workspaceRefId === '..') throw privateProjectCheckoutRefusal();
  return join(workspaceRoot, workspaceRefId);
}

/** Reserve the existing WorkspaceRef identity before destination review. No
 * Account row, filesystem grant or checkout effect is created by preparation. */
export function preparePrivateProjectCheckout(input: PreparePrivateProjectCheckoutInput): PrivateProjectCheckout {
  const unavailable = (): never => {
    throw privateProjectCheckoutRefusal();
  };
  const selected = input.requesterIdentity;
  const native = input.memberRoot.identity;
  // The native operation owner already qualified this Home. A Workspace ref
  // and the selector's saved-profile handle cannot create that authority.
  const home = native.homeServerIdentityId;
  if (selected.kind !== 'isolated' || !home
    || native.requester.serverId !== selected.requester.serverId
    || native.requester.accountId !== selected.requester.accountId
    || native.requester.machineId !== selected.requester.machineId
    || native.requester.installationId !== selected.requester.installationId
    || input.memberRoot.workspaceRoot !== native.workspaceRoot) return unavailable();
  const workspaceRefId = input.workspaceRefId ?? input.createId();
  const rootPath = resolvePrivateProjectCheckoutRoot(input.memberRoot.workspaceRoot, workspaceRefId);
  const existingRoot = resolveWorkspaceRefV1(input.workspaceRefs, {
    serverId: home, machineId: selected.requester.machineId, rootPath,
  });
  if (existingRoot.kind !== 'missing' && (existingRoot.kind !== 'resolved' || existingRoot.ref.id !== workspaceRefId)) return unavailable();
  const existing = resolveWorkspaceRefV1(input.workspaceRefs, { serverId: home, id: workspaceRefId });
  if (existing.kind !== 'missing' && (existing.kind !== 'resolved' || existing.ref.machineId !== selected.requester.machineId
    || existing.ref.rootPath !== rootPath) || input.workspaceRefId !== undefined && existing.kind !== 'resolved') return unavailable();
  return { workspaceRefId, rootPath, destinationParentPath: input.memberRoot.workspaceRoot, destinationDirectoryName: workspaceRefId };
}

/** The reviewed destination must already be the host-prepared own path. */
export function admitPrivateProjectCheckoutDestination(input: Readonly<{
  prepared: PrivateProjectCheckout;
  materialization: WorkspaceActivationRequestV1;
}>): void {
  const choice = input.materialization;
  const matches = choice.kind === 'sync'
    ? choice.targetPath === input.prepared.rootPath
    : choice.kind === 'clone' && choice.destinationParentPath === input.prepared.destinationParentPath
      && choice.destinationDirectoryName === input.prepared.destinationDirectoryName;
  if (!matches) {
    throw privateProjectCheckoutRefusal('workspace_private_checkout_review_required');
  }
}
