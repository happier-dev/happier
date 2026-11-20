import type { ActionExecuteFailure, HostReviewedChildPortV1, HostReviewedChildrenPlanV1 } from '@happier-dev/protocol/actions/executor/types';
import { OpenProjectInputV1Schema } from '@happier-dev/protocol/projects/openProjectV1';
import { projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';
import { SessionCreationCorrespondenceV1ReadSchema, type SessionProjectFilesOriginV1 } from '@happier-dev/protocol/sessions/creation/sessionCreationCorrespondenceV1';
import { deriveSessionCreationTagV1 } from '@happier-dev/protocol/sessions/creation/sessionCreationIdentityV1';
import { SESSION_PROJECT_FILES_OPEN_CHILDREN_V1 } from '@happier-dev/protocol/sessions/creation/sessionProjectFilesOpenV1';
import { computeWorkspaceSyncPolicyDigest, type WorkspaceSyncRequesterAvailabilityV1 } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { SESSION_WORKSPACE_RETURN_CAPTURE_CHILD_V1 } from '@happier-dev/protocol/actions/sessionWorkspaceReturnActionIdsV1';
import { SessionWorkspaceReturnCaptureResultV1Schema } from '@happier-dev/protocol/actions/specs/session/projectFilesReturn';
import type { WorkspaceAddressV2 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { resolveWorkspaceSyncExecutionMachineIdV1 } from '@happier-dev/protocol/workspaces/workspaceSyncTopology';
import { buildWorkspaceSyncMaterializationOpenInputV1 } from '@happier-dev/protocol/workspaces/workspaceSyncAdmissionV1';
import { createManagedSessionDirectories, predictManagedSessionCreationDirectory } from '@/session/creation/managedSessionDirectories';
import type { ScmBackendRegistry } from '@/scm/registry';
import { readScmAccountScope } from '@/scm/accountScope';
import { resolveSessionTargetWorkspace } from '@/daemon/sessions/sessionTargetWorkspaces';
import { selectWorkspaceSource, type WorkspaceTargetSourceResolver } from '@/workspaces/source/workspaceSource';
import { invokeReviewedProjectOpen } from '@/workspaces/activation/invokeReviewedProjectOpen';
import { prepareManagedWorkspaceReturnFromStage, projectManagedWorkspaceReturnFailure, readManagedWorkspaceReturnErrorDetails,
  type ManagedWorkspaceReturnPreview } from './managedWorkspaceReturn';

export type PreparedEnrolledWorkspaceReturn = Readonly<{
  children: HostReviewedChildrenPlanV1['children'];
  origin: SessionProjectFilesOriginV1;
  sessionCreationTag: ReturnType<typeof deriveSessionCreationTagV1>;
  targetPath: string;
}>;

/** Metadata locates endpoints. The exact source attach is admitted anew by Project Open. */
export async function prepareEnrolledWorkspaceReturnChildren(input: Readonly<{
  sessionId: string; machineId: string; metadata: unknown; activeServerDir: string; actionRequestId?: string;
  readRequesterWorkspaceScope?: () => Promise<WorkspaceSyncRequesterAvailabilityV1>;
}>): Promise<PreparedEnrolledWorkspaceReturn | null> {
  const metadata = input.metadata;
  if (!metadata || typeof metadata !== 'object' || !('sessionCreationCorrespondenceV1' in metadata)) return null;
  const parsed = SessionCreationCorrespondenceV1ReadSchema.safeParse(metadata.sessionCreationCorrespondenceV1);
  if (!parsed.success) throw Object.assign(new Error('Session creation origin is unavailable'), { code: 'project_files_origin_unavailable' });
  const origin = parsed.data.recipe.projectFilesOrigin;
  if (!origin) return null;
  const originalMachineId = resolveWorkspaceSyncExecutionMachineIdV1(origin.sourceWorkspace);
  if (originalMachineId !== input.machineId
    || origin.sourceWorkspace.serverId !== origin.targetWorkspace.serverId) {
    throw Object.assign(new Error('The return must run on the original Machine'), { code: 'target_mismatch' });
  }
  if (!input.actionRequestId) throw Object.assign(new Error('Return request identity is required'), { code: 'action_request_id_required' });
  const scope = await input.readRequesterWorkspaceScope?.();
  if (!scope || scope.kind === 'unavailable') {
    throw Object.assign(new Error('The requester workspace scope is unavailable'), {
      code: scope?.reason ?? 'requester_authority_unavailable',
    });
  }
  const sessionCreationTag = deriveSessionCreationTagV1({ callerCreationNamespace: 'workspace-return',
    creationKey: `${input.sessionId}:${input.actionRequestId}` });
  const targetPath = (scope.workspaceRoot
    ? predictManagedSessionCreationDirectory({ root: scope.workspaceRoot, sessionCreationTag })
    : createManagedSessionDirectories({ activeServerDir: input.activeServerDir }).prepareForCreation({ sessionCreationTag })).directory;
  const source = OpenProjectInputV1Schema.parse({ serverId: origin.sourceWorkspace.serverId,
    machineId: originalMachineId,
    source: { kind: 'workspace', workspaceId: origin.sourceWorkspace.workspaceId, checkout: origin.sourceWorkspace },
    materialization: { kind: 'attach' } });
  const target = origin.targetWorkspace.kind === 'managed'
    ? [
      { ...SESSION_WORKSPACE_RETURN_CAPTURE_CHILD_V1, input: projectNativeJsonValueForTransport({
        sessionId: input.sessionId, machineId: origin.targetWorkspace.controller.machineId,
      }) },
      { ...SESSION_PROJECT_FILES_OPEN_CHILDREN_V1.target,
        scopeInput: { serverId: origin.sourceWorkspace.serverId, machineId: originalMachineId } },
    ]
    : [{ ...SESSION_PROJECT_FILES_OPEN_CHILDREN_V1.target,
      input: projectNativeJsonValueForTransport(buildReturnCopy(origin.sourceWorkspace, origin.targetWorkspace, targetPath, origin.baseline)) }];
  return { origin, sessionCreationTag, targetPath, children: [
    { ...SESSION_PROJECT_FILES_OPEN_CHILDREN_V1.source, input: projectNativeJsonValueForTransport(source) },
    ...target,
  ] };
}

function buildReturnCopy(original: WorkspaceAddressV2, source: WorkspaceAddressV2, targetPath: string, baseline?: SessionProjectFilesOriginV1['baseline']) {
  const policy = { v: 1 as const, selection: 'git_worktree' as const,
    extraIgnorePatterns: [], extraIncludePatterns: [], contentOnly: true as const };
  return buildWorkspaceSyncMaterializationOpenInputV1({ serverId: original.serverId,
    source, targetMachineId: resolveWorkspaceSyncExecutionMachineIdV1(original), targetPath,
    workspaceAction: { kind: 'copy_once', contentPolicy: { ...policy, policyDigest: computeWorkspaceSyncPolicyDigest(policy) },
      ...(baseline ? { exclusionCandidates: baseline.entries.filter(entry => entry.kind !== 'directory').map(entry => entry.relativePath) } : {}) } });
}

/** Existing transfer produces a private stage; the incumbent review owner captures it. */
export async function prepareEnrolledWorkspaceReturn(input: Readonly<{
  sessionId: string; activeServerDir: string; prepared: PreparedEnrolledWorkspaceReturn;
  invokeReviewedChild?: HostReviewedChildPortV1['invoke']; registry?: ScmBackendRegistry; signal?: AbortSignal;
  resolveWorkspaceTarget?: WorkspaceTargetSourceResolver;
}>): Promise<ManagedWorkspaceReturnPreview | ActionExecuteFailure> {
  if (!input.invokeReviewedChild) return { ok: false, errorCode: 'credential_scope_denied', error: 'credential_scope_denied' };
  const open = (child: HostReviewedChildrenPlanV1['children'][number]) => invokeReviewedProjectOpen({
    request: OpenProjectInputV1Schema.parse(child.input), role: child.role,
    invokeReviewedChild: input.invokeReviewedChild, signal: input.signal });
  const source = await open(input.prepared.children[0]);
  if (!source.ok) return source;
  let stageRoot = input.prepared.targetPath;
  try {
    const workspace = source.opened.workspace;
    const original = workspace?.kind === 'managed' ? { workspace, source: await selectWorkspaceSource({
      workspace, requesterAccountId: readScmAccountScope(),
    }, input.resolveWorkspaceTarget ?? resolveSessionTargetWorkspace) } : undefined;
    let baseline = input.prepared.origin.baseline;
    let excludedPaths: readonly string[] | undefined;
    let copied: Awaited<ReturnType<typeof open>>;
    if (input.prepared.origin.targetWorkspace.kind === 'managed') {
      input.signal?.throwIfAborted();
      const captured = await input.invokeReviewedChild({ ...SESSION_WORKSPACE_RETURN_CAPTURE_CHILD_V1,
        input: input.prepared.children[1].input! });
      if (!captured.ok) return captured;
      const parsed = SessionWorkspaceReturnCaptureResultV1Schema.safeParse(captured.result);
      if (!parsed.success) return { ok: false, errorCode: 'invalid_action_output', error: 'invalid_action_output' };
      baseline ??= parsed.data.baseline;
      excludedPaths = parsed.data.excludedPaths;
      copied = await invokeReviewedProjectOpen({
        request: buildReturnCopy(input.prepared.origin.sourceWorkspace, parsed.data.workspace, input.prepared.targetPath),
        role: SESSION_PROJECT_FILES_OPEN_CHILDREN_V1.target.role,
        invokeReviewedChild: input.invokeReviewedChild, signal: input.signal,
      });
    } else copied = await open(input.prepared.children[1]);
    if (!copied.ok) return copied;
    stageRoot = copied.opened.directory;
    excludedPaths ??= copied.opened.copyOnceExcludedPaths;
    return await prepareManagedWorkspaceReturnFromStage({ sessionId: input.sessionId, activeServerDir: input.activeServerDir,
      hostRoot: source.opened.directory, stageRoot,
      ...(original ? { original } : {}),
      ...(input.registry ? { registry: input.registry } : {}),
      ...(baseline ? { baseline } : {}),
      ...(excludedPaths ? { excludedPaths } : {}),
      ...(input.signal ? { signal: input.signal } : {}) });
  } catch (error) {
    const failure = projectManagedWorkspaceReturnFailure(error, 'workspace.return.prepare');
    return { ...failure, details: { appliedPaths: [], ...readManagedWorkspaceReturnErrorDetails(error), recoveryPath: stageRoot } };
  }
}
