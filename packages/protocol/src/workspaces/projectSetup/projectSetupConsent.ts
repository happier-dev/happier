import type { WorkspaceAddressV1 } from '../workspaceRefV1.js';
import { normalizeWorkspaceRootPathV1 } from '../workspaceRefResolutionV1.js';
import type { ActionOperationSnapshotV1 } from '../../actions/operations/v1.js';
import type { ProjectTrustValueV1, ProjectTrustMutationResponseV1, QualifiedProjectTrustProjectV1 } from './projectTrustRowV1.js';

export type ProjectSetupConsentScopeV1 = Readonly<{ serverId: string; accountId: string }>;
export type RememberProjectSetupConsentResult =
  | Readonly<{ kind: 'remembered'; operation: ActionOperationSnapshotV1 }>
  | Readonly<{ kind: 'changed' }>
  | Readonly<{ kind: 'unavailable'; code: string }>;
type OpenedTrust = Readonly<{ status: 'present'; revision: number; value: ProjectTrustValueV1 }>
  | Readonly<{ status: 'absent' }> | Readonly<{ status: 'deleted'; revision: number }>;

/** The admitted Account effect. Transports supply the existing Trust row and retained operation owners. */
export async function rememberAdmittedProjectSetupConsentV1(input: Readonly<{
  scope: ProjectSetupConsentScopeV1;
  workspace: WorkspaceAddressV1;
  reviewedEffectDigest: string;
  operation: ActionOperationSnapshotV1;
  project: QualifiedProjectTrustProjectV1;
  refreshOperation(): Promise<ActionOperationSnapshotV1 | null>;
  readTrust(): Promise<OpenedTrust>;
  observeOperation?(operation: ActionOperationSnapshotV1): void;
  rememberEffect(value: ProjectTrustValueV1 & Readonly<{ currentEffectDigest: string; expectedRevision: number | 'absent' }>): Promise<ProjectTrustMutationResponseV1>;
}>): Promise<RememberProjectSetupConsentResult> {
  const refresh = async () => {
    const current = await input.refreshOperation();
    if (!current || !matchesRetainedCheckout(current, input.operation, input.scope, input.workspace)) return null;
    input.observeOperation?.(current);
    return current;
  };
  // The retained producer owns current executable review; a displayed digest is not evidence of it.
  const before = await refresh();
  if (!before?.setupReview) return { kind: 'unavailable', code: before?.error?.errorCode ?? 'project_setup_review_unavailable' };
  const currentEffectDigest = before.setupReview.reviewedEffectDigest;
  if (currentEffectDigest !== input.reviewedEffectDigest) return { kind: 'changed' };
  const current = await input.readTrust();
  if (!(current.status === 'present' && current.value.reviewedEffectDigest === input.reviewedEffectDigest)) {
    const response = await input.rememberEffect({ project: input.project, reviewedEffectDigest: input.reviewedEffectDigest,
      currentEffectDigest, approvedAtMs: Date.now(), expectedRevision: current.status === 'absent' ? 'absent' : current.revision });
    if (response.status !== 'updated') return { kind: 'changed' };
  }
  // The same operation owner resumes its original admission after the Account write.
  const resumed = await refresh();
  if (!resumed) return { kind: 'unavailable', code: 'project_setup_review_unavailable' };
  if (resumed.setupReview) return resumed.setupReview.reviewedEffectDigest !== input.reviewedEffectDigest
    ? { kind: 'changed' } : { kind: 'unavailable', code: resumed.setupReview.code };
  if (resumed.state === 'failed' || resumed.state === 'cancelled') {
    return { kind: 'unavailable', code: resumed.error?.errorCode ?? 'cancelled' };
  }
  return { kind: 'remembered', operation: resumed };
}

/** Bind the current target review to the same retained invocation and its original Source checkout. */
export function matchesRetainedCheckout(
  current: ActionOperationSnapshotV1,
  retained: ActionOperationSnapshotV1,
  scope: ProjectSetupConsentScopeV1,
  workspace: WorkspaceAddressV1,
): boolean {
  const target = current.domainRef;
  const original = retained.domainRef;
  if (target?.kind !== 'projectCommand' || original?.kind !== 'projectCommand') return false;
  // Once review clears, the same invocation's producer may project only its target.
  // Its validated retained review still binds Source; a supplied Source must match.
  const source = target.sourceWorkspace ?? (!current.setupReview ? original.sourceWorkspace : undefined);
  return current.operationId === retained.operationId && current.actionId === retained.actionId
    && current.scope.accountId === scope.accountId && current.scope.machineId === retained.scope.machineId
    && target.serverId === scope.serverId && target.machineId === current.scope.machineId
    && target.workspaceRefId === original.workspaceRefId
    && (!current.setupReview || normalizeWorkspaceRootPathV1(target.cwd) === normalizeWorkspaceRootPathV1(original.cwd))
    && source !== undefined && source.serverId === scope.serverId && source.serverId === workspace.serverId
    && source.machineId === workspace.machineId && source.workspaceId === workspace.workspaceId
    && normalizeWorkspaceRootPathV1(source.rootPath) === normalizeWorkspaceRootPathV1(workspace.rootPath);
}
