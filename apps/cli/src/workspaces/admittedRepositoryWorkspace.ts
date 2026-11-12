import type { ActionExecutorContext, ActionExecutorDeps, DeploymentPrepareInputV1 } from '@happier-dev/protocol';
import { ActionExecuteFailureSchema, type ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ProjectSourceV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { readScmHostingRepositoryIdentity, sameScmHostingRepositoryIdentity } from '@happier-dev/protocol/scm/hostingRepositoryIdentity';
import type { WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { normalizeAdmittedHomeServerIdV1 } from '@happier-dev/protocol/actions/executor/deploymentHomeAdmission';
import { resolveWorkspaceRefById } from './workspaceRefsV1';
import { ScmStatusSnapshotResponseSchema } from '@happier-dev/protocol/scm';
import type { ScmBackendRegistry } from '@/scm/registry';
import { getPathRemainderWithinBase } from '@/session/handoff/paths/sessionHandoffPathNormalization';
import type { CliAdmittedProjectRowsReader } from '@/session/actions/cliActionDeps/projectAdmission';

type RepositoryWorkspaceIntent = Pick<DeploymentPrepareInputV1,
  'projectSourceId' | 'sourceRevision' | 'repository'>;
type RepositoryWorkspaceRefusal = Readonly<{ kind: 'refused'; reason: 'workspace_unavailable' }>
  | Readonly<{ kind: 'conflict'; reason: 'source_changed' }>;

/** Account metadata selects placement before any Machine-local repository reads. */
export async function resolveAdmittedRepositoryWorkspace(input: Readonly<{
  workspace: DeploymentPrepareInputV1['workspace'];
  expected?: RepositoryWorkspaceIntent;
  context: ActionExecutorContext;
  readWorkspaceRows: CliAdmittedProjectRowsReader;
  fallbackActionId: string;
}>): Promise<Readonly<{ kind: 'resolved'; workspace: WorkspaceRefV1 }> | RepositoryWorkspaceRefusal | ActionExecuteFailure> {
  const rows = await input.readWorkspaceRows({ key: input.workspace }, input.context.signal, input.context, input.fallbackActionId);
  if (!rows) return { ok: false, errorCode: 'project_requester_authority_unavailable', error: 'project_requester_authority_unavailable' };
  const normalizeServerId = (id: string) => normalizeAdmittedHomeServerIdV1(id, input.context);
  const resolved = resolveWorkspaceRefById(rows.workspaceRefs, input.workspace.id, input.workspace.serverId, { normalizeServerId });
  if (!resolved) return { kind: 'refused', reason: 'workspace_unavailable' };
  const workspace = { ...resolved, serverId: normalizeServerId(resolved.serverId) };
  if (input.expected && (workspace.source?.sourceId !== input.expected.projectSourceId || workspace.source.revision !== input.expected.sourceRevision
    || !sameScmHostingRepositoryIdentity(workspace.repositoryIdentity, input.expected.repository))) return { kind: 'conflict', reason: 'source_changed' };
  return { kind: 'resolved', workspace };
}

/** Runs only after placement, using the selected Machine's native SCM owner. */
export async function validateAdmittedRepositoryWorkspace(input: RepositoryWorkspaceIntent & Readonly<{
  workspace: WorkspaceRefV1;
  baseCommit?: string;
  context: ActionExecutorContext;
  readSource: NonNullable<ActionExecutorDeps['projectSourcesRead']>;
  admittedSource?: ProjectSourceV1;
  readScmStatus?: () => Promise<unknown>;
  registry?: ScmBackendRegistry;
}>): Promise<Readonly<{ kind: 'validated'; source: ProjectSourceV1 }> | RepositoryWorkspaceRefusal | ActionExecuteFailure
  | Readonly<{ kind: 'refused'; reason: 'access_denied' }>
  | Readonly<{ kind: 'conflict'; reason: 'base_changed' }>> {
  const loaded = input.admittedSource ? { ok: true as const, source: input.admittedSource }
    : await input.readSource({ serverId: input.workspace.serverId, sourceId: input.projectSourceId }, input.context);
  if (!loaded.ok) return 'errorCode' in loaded ? loaded : { kind: 'refused', reason: 'access_denied' };
  const source = loaded.source;
  if (source.id !== input.projectSourceId || source.revision !== input.sourceRevision || !source.repository
    || !sameScmHostingRepositoryIdentity(readScmHostingRepositoryIdentity({ ...source.repository.provider,
      nameWithOwner: source.repository.repository.nameWithOwner }), input.repository)) return { kind: 'conflict', reason: 'source_changed' };
  if (input.readScmStatus) {
    const raw = await input.readScmStatus();
    const failed = ActionExecuteFailureSchema.safeParse(raw);
    if (failed.success) return failed.data;
    const status = ScmStatusSnapshotResponseSchema.safeParse(raw);
    if (!status.success) return { kind: 'refused', reason: 'workspace_unavailable' };
    if (!status.data.success && status.data.errorCode) return { ok: false,
      errorCode: status.data.errorCode, error: status.data.error || status.data.errorCode };
    const snapshot = status.data.success ? status.data.snapshot : undefined;
    if (!snapshot?.repo.isRepo || !snapshot.repo.rootPath
      || getPathRemainderWithinBase(snapshot.repo.rootPath, input.workspace.rootPath) !== '')
      return { kind: 'refused', reason: 'workspace_unavailable' };
    if (input.baseCommit !== undefined && snapshot.branch.headOid !== input.baseCommit) return { kind: 'conflict', reason: 'base_changed' };
    if (!sameScmHostingRepositoryIdentity(readScmHostingRepositoryIdentity(snapshot.hostingProvider), input.repository))
      return { kind: 'conflict', reason: 'source_changed' };
    return { kind: 'validated', source };
  }
  const { inspectWorkspaceLocationWithScmWorkspace } = await import('@/scm/workspace/workspaceLocationInspection');
  const inspected = await inspectWorkspaceLocationWithScmWorkspace({ candidatePath: input.workspace.rootPath,
    includeRepositoryIdentity: true, signal: input.context.signal, registry: input.registry });
  if (!inspected) return { kind: 'refused', reason: 'workspace_unavailable' };
  if (input.baseCommit !== undefined && inspected.inspection.committedRevision !== input.baseCommit) return { kind: 'conflict', reason: 'base_changed' };
  if (!sameScmHostingRepositoryIdentity(inspected.repositoryIdentity, input.repository)) return { kind: 'conflict', reason: 'source_changed' };
  return { kind: 'validated', source };
}
