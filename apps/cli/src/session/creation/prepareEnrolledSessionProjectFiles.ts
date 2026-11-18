import type { ActionExecuteFailure, HostReviewedChildPortV1 } from '@happier-dev/protocol/actions/executor/types';
import { OpenProjectInputV1Schema,
  type OpenProjectInputV1 } from '@happier-dev/protocol/projects/openProjectV1';
import { invokeReviewedProjectOpen } from '@/workspaces/activation/invokeReviewedProjectOpen';
import { buildSessionProjectFilesSourceOpenInputV1, needsEnrolledSessionProjectFilesOpenV1,
  SESSION_PROJECT_FILES_OPEN_CHILDREN_V1 } from '@happier-dev/protocol/sessions/creation/sessionProjectFilesOpenV1';
import type { SessionExecutionTargetV1 } from '@happier-dev/protocol/sessions/creation/sessionExecutionTargetV1';
import type { SessionPlacementSelectionV1, SessionProjectFilesV1 } from '@happier-dev/protocol/sessions/creation/sessionPlacementSelectionV1';
import { createDefaultWorkspaceContentPolicyV1 } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { buildWorkspaceSyncMaterializationOpenInputV1 } from '@happier-dev/protocol/workspaces/workspaceSyncAdmissionV1';
import type { ManagedWorkspaceRefV2, WorkspaceAddressV1, WorkspaceAddressV2 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import type { SessionProjectFilesOriginV1 } from '@happier-dev/protocol/sessions/creation/sessionCreationCorrespondenceV1';

import type { ScmRepositoryCloneSourceV1 } from '@happier-dev/protocol/scm/repositoryClone';
import { isResolvedSessionProjectFilesV1, type ResolvedSessionProjectFilesV1 } from '@happier-dev/protocol/machines/machineIsolationV1';

export type EnrolledSessionProjectFiles = Readonly<{
  ok: true;
  directory: string;
  projectFiles?: ResolvedSessionProjectFilesV1;
  workspace?: WorkspaceAddressV2;
  sourceWorkspace?: WorkspaceAddressV1;
  projectFilesOrigin?: SessionProjectFilesOriginV1;
}> | ActionExecuteFailure;

export async function prepareSessionProjectFilesSource(input: Readonly<{
  placement?: SessionPlacementSelectionV1;
  cloneSource?: true;
  invokeReviewedChild?: HostReviewedChildPortV1['invoke'];
  signal?: AbortSignal;
}>): Promise<Readonly<{ ok: true; sourceWorkspace: WorkspaceAddressV1; directory: string; cloneSource?: ScmRepositoryCloneSourceV1 }> | ActionExecuteFailure> {
  const request = input.placement ? buildSessionProjectFilesSourceOpenInputV1(input.placement) : null;
  if (!request) return { ok: false, errorCode: 'source_unavailable', error: 'source_unavailable' };
  const result = await invokeReviewedProjectOpen({ request: { ...request, ...(input.cloneSource ? { cloneSource: true as const } : {}) }, role: SESSION_PROJECT_FILES_OPEN_CHILDREN_V1.source.role,
    invokeReviewedChild: input.invokeReviewedChild, signal: input.signal });
  if (!result.ok) return result;
  if (result.opened.workspace.kind === 'managed') {
    return { ok: false, errorCode: 'workspace_managed_target_required', error: 'workspace_managed_target_required' };
  }
  return { ok: true, sourceWorkspace: result.opened.workspace, directory: result.opened.directory,
    ...(result.opened.cloneSource ? { cloneSource: result.opened.cloneSource } : {}) };
}

/** Resolve authored folder defaults once, before destination credentials or materialization. */
export async function resolveSessionProjectFiles(input: Readonly<{
  projectFiles: SessionProjectFilesV1;
  placement?: SessionPlacementSelectionV1;
  invokeReviewedChild?: HostReviewedChildPortV1['invoke'];
  signal?: AbortSignal;
}>): Promise<Readonly<{ ok: true; projectFiles: ResolvedSessionProjectFilesV1 }> | ActionExecuteFailure> {
  const choice = input.projectFiles;
  if (isResolvedSessionProjectFilesV1(choice)) return { ok: true, projectFiles: choice };
  const result = await prepareSessionProjectFilesSource({ ...input, cloneSource: true });
  if (!result.ok) return result;
  const repository = choice.source ?? result.cloneSource?.source;
  if (!repository) return { ok: false, errorCode: 'source_unavailable', error: 'source_unavailable' };
  const branch = choice.branch ?? result.cloneSource?.branch;
  if (!branch) return { ok: false, errorCode: 'ref_unavailable', error: 'ref_unavailable' };
  return { ok: true, projectFiles: { ...choice, source: repository, branch } };
}

/** Enrolled and retained native destinations use the same admitted Project Open child. */
export async function prepareSessionProjectFilesTarget(input: Readonly<{
  sourceWorkspace: WorkspaceAddressV1;
  executionTarget: SessionExecutionTargetV1;
  targetDirectory: string;
  projectFiles?: Exclude<SessionProjectFilesV1, { kind: 'git_clone' }>;
  targetManaged?: Pick<ManagedWorkspaceRefV2, 'managedId' | 'controller'>;
  invokeReviewedChild?: HostReviewedChildPortV1['invoke'];
  signal?: AbortSignal;
}>): ReturnType<typeof invokeReviewedProjectOpen> {
  const choice = input.projectFiles ?? { kind: 'copy_once' as const };
  const contentPolicy = choice.contentPolicy ?? createDefaultWorkspaceContentPolicyV1();
  return invokeReviewedProjectOpen({ request: buildWorkspaceSyncMaterializationOpenInputV1({
    serverId: input.executionTarget.serverId, source: input.sourceWorkspace,
    targetMachineId: input.executionTarget.machineId, targetPath: input.targetDirectory,
    ...(input.targetManaged ? { targetManaged: input.targetManaged } : {}),
    workspaceAction: choice.kind === 'copy_once' ? { kind: 'copy_once', contentPolicy }
      : { kind: 'create_relationship', mode: choice.mode, contentPolicy, flushBeforeCommit: true },
  }), role: SESSION_PROJECT_FILES_OPEN_CHILDREN_V1.target.role,
    invokeReviewedChild: input.invokeReviewedChild, signal: input.signal });
}

/** Remote Session preparation consumes Project Open's source admission, transfer and clone owners. */
export async function prepareEnrolledSessionProjectFiles(input: Readonly<{
  placement?: SessionPlacementSelectionV1;
  projectFiles?: SessionProjectFilesV1;
  executionTarget: SessionExecutionTargetV1;
  /** Allocated by the destination daemon's existing managed-directory preparation. */
  targetDirectory: string;
  invokeReviewedChild?: HostReviewedChildPortV1['invoke'];
  signal?: AbortSignal;
}>): Promise<EnrolledSessionProjectFiles> {
  if (!needsEnrolledSessionProjectFilesOpenV1(input)) return { ok: true, directory: input.targetDirectory };
  if (!input.invokeReviewedChild) return { ok: false, errorCode: 'credential_scope_denied', error: 'credential_scope_denied' };
  const open = (request: OpenProjectInputV1, role: string) => invokeReviewedProjectOpen({ request, role,
    invokeReviewedChild: input.invokeReviewedChild, signal: input.signal });
  const resolved = await resolveSessionProjectFiles({ ...input,
    projectFiles: input.placement?.projectFiles ?? input.projectFiles ?? { kind: 'copy_once' } });
  if (!resolved.ok) return resolved;
  const choice = resolved.projectFiles;
  if (choice.kind === 'git_clone') {
    const cloned = await open(OpenProjectInputV1Schema.parse({
      ...input.executionTarget, source: { kind: 'repository', selector: { ...choice.source, protocol: 'https' } },
      materialization: { kind: 'clone', destinationParentPath: input.targetDirectory,
        destinationDirectoryName: 'repository', initialCheckout: { branch: choice.branch }, authentication: 'connected_account',
        ...(choice.gitAccount ? { gitAccount: choice.gitAccount } : {}) },
    }), SESSION_PROJECT_FILES_OPEN_CHILDREN_V1.target.role);
    return cloned.ok ? { ok: true, directory: cloned.opened.directory, workspace: cloned.opened.workspace, projectFiles: choice } : cloned;
  }
  const sourceInput = input.placement ? buildSessionProjectFilesSourceOpenInputV1(input.placement) : null;
  if (!sourceInput) return { ok: false, errorCode: 'source_unavailable', error: 'source_unavailable' };
  if (sourceInput.serverId !== input.executionTarget.serverId)
    return { ok: false, errorCode: 'server_scope_mismatch', error: 'server_scope_mismatch' };
  const source = await prepareSessionProjectFilesSource({ placement: input.placement!,
    invokeReviewedChild: input.invokeReviewedChild, signal: input.signal });
  if (!source.ok) return source;
  const target = await prepareSessionProjectFilesTarget({ sourceWorkspace: source.sourceWorkspace,
    executionTarget: input.executionTarget, targetDirectory: input.targetDirectory, projectFiles: choice,
    invokeReviewedChild: input.invokeReviewedChild, signal: input.signal });
  return target.ok ? { ok: true, directory: target.opened.directory, workspace: target.opened.workspace,
    sourceWorkspace: source.sourceWorkspace,
    ...(choice.kind === 'copy_once' ? { projectFilesOrigin: {
      sourceWorkspace: source.sourceWorkspace, targetWorkspace: target.opened.workspace,
      ...(target.opened.copyOnceBaseline ? { baseline: target.opened.copyOnceBaseline } : {}),
    } } : {}) } : target;
}
