import type {
  WorkflowAuthoredProducerRef,
  WorkflowWorkspaceCreationIntentV1,
  WorkflowWorkspaceDescriptorV1,
  WorkflowWorkspaceResolutionV1,
  WorkflowWorkspaceSelection,
  WorkflowAcceptedWorkspaceTargetPreparation,
  WorkflowProjectTargetV1,
} from '@happier-dev/protocol/workflows';
import type { WorkflowAcceptedSnapshotV1, WorkflowDefinitionV1, WorkflowProgressEnvelopeV1, WorkflowStep, WorkflowWorkspaceProgressV1 } from '@happier-dev/protocol';
import type { WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { workspaceAddressFromRefV2 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import { matchesAcceptedManagedWorkspaceRef } from '@/workspaces/acceptedManagedWorkspace';
import { resolveSessionTargetWorkspace } from '@/daemon/sessions/sessionTargetWorkspaces';
import {
  currentWorkspaceSource, runWithWorkspaceSourceDemand, selectWorkspaceSource,
  type WorkspaceSource, type WorkspaceSourcePlacement,
} from '@/workspaces/source/workspaceSource';

import { getPathRemainderWithinBase } from '@/session/handoff/paths/sessionHandoffPathNormalization';
import { inspectWorkspaceLocationWithScmWorkspace } from '@/scm/workspace/workspaceLocationInspection';
import { realizeWorkspaceCheckoutWithScmWorkspaceSource } from '@/scm/workspace/workspaceCheckoutOperations';
import { DirectoryInCheckoutError, resolveDirectoryInCheckout } from '@/workspaces/activation/resolveDirectoryInCheckout';
import {
  canonicalAbsolutePathsEqual,
  resolveCanonicalAbsolutePath,
} from '@/utils/path/expandHomeDirPath';
import {
  workflowInvocationKey,
  type WorkflowConversationWorkspace,
  type WorkflowCoordinatorInvocation,
  type WorkflowCoordinatorStore,
} from './coordinator';
import type { WorkflowProducerBinding } from './workflowScopeBinding';
import type { WorkflowConversationBinding } from './workflowConversation';
import { walkWorkflowBlocks } from './workflowDefinitionTraversal';

export type WorkflowWorkspaceDescriptor = WorkflowWorkspaceDescriptorV1;
export type WorkflowWorkspaceCreationIntent = WorkflowWorkspaceCreationIntentV1;
export type WorkflowWorkspaceResolution = WorkflowWorkspaceResolutionV1;
export type WorkflowWorkspaceSource = Readonly<{
  descriptor: WorkflowWorkspaceDescriptor;
  creationIntent?: WorkflowWorkspaceCreationIntent;
}>;
export type WorkflowWorkspaceRestoreResult = Readonly<{ ok: true }> | Readonly<{
  ok: false;
  code: 'workflow_workspace_restore_unavailable' | 'workflow_workspace_restore_failed';
}>;

type Dependencies = Readonly<{
  resolveProducerWorkspace?: (producer: WorkflowAuthoredProducerRef) => Promise<WorkflowWorkspaceSource | null>;
  inspectLocation?: (input: Readonly<{ candidatePath: string }>) => Promise<Readonly<{
    inspection: Readonly<{ rootPath: string }>;
  }> | null>;
  inspectCommittedRevision?: (directory: string) => Promise<string | null>;
  realizeWorktree?: (intent: WorkflowWorkspaceCreationIntent) => Promise<Readonly<{ directory: string; checkoutRootPath: string; branchName: string }> | null>;
  persistCreationIntent?: (intent: WorkflowWorkspaceCreationIntent) => Promise<void>;
  persistWorkspace?: (workspace: WorkflowWorkspaceDescriptor) => Promise<void>;
  verifyRecordedWorkspace?: (
    workspace: WorkflowWorkspaceDescriptor,
    creationIntent?: WorkflowWorkspaceCreationIntent,
  ) => Promise<'available' | 'missing' | 'conflict'>;
}>;

function sameWorkspace(left: WorkflowConversationWorkspace, right: WorkflowConversationWorkspace): boolean {
  return left.machineId === right.machineId
    && getPathRemainderWithinBase(left.directory, right.directory) === '';
}

function creationDisplayName(runId: string, logicalInvocationRecordId: string, slot?: 'frame_project'): string {
  return `workflow-${runId}-${logicalInvocationRecordId}${slot === 'frame_project' ? '-project' : ''}`;
}

async function canonicalExistingPathsEqual(left: string, right: string): Promise<boolean> {
  const canonicalize = async (path: string) => {
    try {
      return await currentWorkspaceSource().realpath(path);
    } catch {
      return path;
    }
  };
  return canonicalAbsolutePathsEqual(await canonicalize(left), await canonicalize(right));
}

function inspectWorkflowWorkspaceLocation(input: Readonly<{ candidatePath: string; signal?: AbortSignal }>) {
  // A Run accepts local checkout identity and an optional original revision.
  return inspectWorkspaceLocationWithScmWorkspace({ ...input, includeHostingProviders: false });
}

async function inspectCommittedRevision(directory: string): Promise<string | null> {
  const inspected = await inspectWorkflowWorkspaceLocation({ candidatePath: directory });
  return inspected?.inspection.committedRevision ?? null;
}

/**
 * Revalidates an accepted/recorded descriptor immediately before it can feed a
 * workflow filesystem or agent effect. A normal directory remains usable when
 * no SCM owns it; an SCM-backed descriptor must still resolve to its accepted
 * checkout root.
 */
export async function verifyWorkflowWorkspaceCurrentness(
  workspace: WorkflowWorkspaceDescriptor,
  input: Readonly<{
    creationIntent?: WorkflowWorkspaceCreationIntent;
    pathIsDirectory?: (path: string) => Promise<boolean>;
    inspectLocation?: (input: Readonly<{ candidatePath: string }>) => Promise<Readonly<{
      backendId?: string;
      inspection: Readonly<{ rootPath: string }>;
      checkoutDiscovery?: readonly Readonly<{
        kind: string;
        path?: string;
        repositoryIdentityPath?: string;
      }>[];
    }> | null>;
  }> = {},
): Promise<'available' | 'missing' | 'conflict'> {
  const pathIsDirectory = input.pathIsDirectory ?? (async (path: string) => {
    try {
      return (await currentWorkspaceSource().stat(path)).isDirectory();
    } catch {
      return false;
    }
  });
  if (!await pathIsDirectory(workspace.directory)) return 'missing';
  const inspected = await (input.inspectLocation ?? inspectWorkflowWorkspaceLocation)({
    candidatePath: workspace.directory,
  });
  if (!inspected) return workspace.checkout ? 'conflict' : 'available';
  if (!await canonicalExistingPathsEqual(
    inspected.inspection.rootPath,
    workspace.checkoutRootPath,
  )) return 'conflict';
  if (!workspace.checkout) return 'available';
  if (getPathRemainderWithinBase(workspace.directory, workspace.checkoutRootPath) === null) return 'conflict';

  let checkout: NonNullable<typeof inspected.checkoutDiscovery>[number] | undefined;
  for (const candidate of inspected.checkoutDiscovery ?? []) {
    if (candidate.kind === workspace.checkout.kind
      && candidate.path !== undefined
      && candidate.repositoryIdentityPath !== undefined
      && await canonicalExistingPathsEqual(candidate.path, workspace.checkoutRootPath)) {
      checkout = candidate;
      break;
    }
  }
  if (!checkout?.repositoryIdentityPath || !input.creationIntent) return 'conflict';
  const source = await (input.inspectLocation ?? inspectWorkflowWorkspaceLocation)({
    candidatePath: input.creationIntent.sourceDirectory,
  });
  const sourceCheckout = source?.checkoutDiscovery?.find((candidate) => (
    candidate.kind === workspace.checkout?.kind && candidate.repositoryIdentityPath !== undefined
  ));
  return source?.backendId !== undefined
    && inspected.backendId !== undefined
    && source.backendId === inspected.backendId
    && sourceCheckout?.repositoryIdentityPath !== undefined
    && await canonicalExistingPathsEqual(sourceCheckout.repositoryIdentityPath, checkout.repositoryIdentityPath)
    ? 'available'
    : 'conflict';
}

function workflowUsesOriginalCommittedRevision(definition: WorkflowDefinitionV1): boolean {
  const selectionUsesOriginal = (selection: WorkflowWorkspaceSelection | undefined) => (
    selection?.kind === 'new_worktree' && selection.source.kind === 'original'
  );
  if (selectionUsesOriginal(definition.defaults.workspace)) return true;
  for (const block of walkWorkflowBlocks(definition.blocks)) {
    if (block.kind === 'step' || block.kind === 'action' || block.kind === 'wait' || block.kind === 'workflow') {
      if (selectionUsesOriginal(block.execution?.workspace)) return true;
    }
  }
  return false;
}

/** Canonicalizes only the signed target fields; it performs no filesystem effect. */
export function normalizeWorkflowProjectTarget(input: Readonly<{
  projectTarget: WorkflowProjectTargetV1;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}>): WorkflowProjectTargetV1 | null {
  const canonical = resolveCanonicalAbsolutePath(input.projectTarget.directory, {
    env: input.env,
    platform: input.platform,
  });
  if (!canonical) return null;
  return {
    machineId: input.projectTarget.machineId,
    directory: canonical.path,
    ...(input.projectTarget.workspaceRefId
      ? { workspaceRefId: input.projectTarget.workspaceRefId }
      : {}),
    ...(input.projectTarget.sessionPlacement ? { sessionPlacement: input.projectTarget.sessionPlacement } : {}),
  };
}

type ManagedWorkflowWorkspace = NonNullable<WorkspaceSourcePlacement['workspace']>;
export type RestoreManagedWorkflowWorkspaceSource = (
  workspace: ManagedWorkflowWorkspace, signal?: AbortSignal,
) => Promise<WorkspaceSource | null>;

type WorkflowWorkspacePreparation = WorkflowAcceptedWorkspaceTargetPreparation & Readonly<{ workspaceSource?: WorkspaceSource }>;
type WorkflowProjectWorkspaceAdmission = Readonly<{
  ok: true;
  workspaceSource?: WorkspaceSource;
  prepare(definition: WorkflowDefinitionV1): Promise<WorkflowWorkspacePreparation>;
}> | Extract<WorkflowAcceptedWorkspaceTargetPreparation, { ok: false }>;

/** Open the already-admitted source through the shared workspace routing owner. */
export async function selectManagedWorkflowWorkspaceSource(input: Readonly<{
  workspace: ManagedWorkflowWorkspace;
  accountId: string;
  restore?: RestoreManagedWorkflowWorkspaceSource;
  signal?: AbortSignal;
}>): Promise<WorkspaceSource | null> {
  try {
    return await selectWorkspaceSource({ workspace: input.workspace, requesterAccountId: input.accountId },
      resolveSessionTargetWorkspace, undefined, workspace => input.restore?.(workspace, input.signal) ?? Promise.resolve(null));
  } catch (error) {
    input.signal?.throwIfAborted();
    if (error instanceof Error && 'code' in error) {
      switch (error.code) {
        case 'workspace_target_unavailable':
        case 'managed_power_required':
        case 'admission_unavailable':
        case 'managed_target_access_unavailable':
          return null;
      }
    }
    throw error;
  }
}

/** Bind the selected Project once, before a repo_file definition can read its filesystem. */
export async function admitWorkflowProjectWorkspace(input: Readonly<{
  projectTarget: WorkflowProjectTargetV1;
  executionTargetKind?: WorkflowAcceptedSnapshotV1['executionTarget']['kind'];
  currentServerId?: string;
  accountId?: string;
  restoreManagedWorkspaceSource?: RestoreManagedWorkflowWorkspaceSource;
  signal?: AbortSignal;
  resolveWorkspaceRef?: (workspaceRefId: string) => WorkspaceRefV1 | null | Promise<WorkspaceRefV1 | null>;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  inspectLocation?: (input: Readonly<{ candidatePath: string }>) => Promise<Readonly<{
    inspection: Readonly<{ rootPath: string; committedRevision?: string }>;
  }> | null>;
  pathIsDirectory?: (path: string) => Promise<boolean>;
}>): Promise<WorkflowProjectWorkspaceAdmission> {
  const normalizedTarget = normalizeWorkflowProjectTarget({
    projectTarget: input.projectTarget,
    env: input.env,
    platform: input.platform,
  });
  if (!normalizedTarget) return { ok: false, code: 'workspace_unavailable' };
  const requestedPlacement = normalizedTarget.sessionPlacement;
  const requestedManaged = requestedPlacement?.kind === 'in_place' ? requestedPlacement.workspace : undefined;
  const refId = requestedManaged?.workspaceId ?? normalizedTarget.workspaceRefId;
  const workspaceRef = refId ? await input.resolveWorkspaceRef?.(refId) ?? null : null;
  // A Project-launched Run can name the checkout by its signed Account row id.
  const selectedAddress = requestedPlacement === undefined && workspaceRef ? workspaceAddressFromRefV2(workspaceRef) : undefined;
  const managed = requestedManaged ?? (selectedAddress?.kind === 'managed' ? selectedAddress : undefined);
  // Detached Run admission currently carries a controller cwd, not a guest address.
  if (managed && input.executionTargetKind === 'detached_run') return { ok: false, code: 'workflow_in_place_not_available' };
  const placement = managed ? { kind: 'in_place' as const, workspace: managed } : requestedPlacement;
  if (managed && (input.currentServerId !== managed.serverId || normalizedTarget.machineId !== managed.controller.machineId
    || (normalizedTarget.workspaceRefId && normalizedTarget.workspaceRefId !== refId)
    || getPathRemainderWithinBase(normalizedTarget.directory, managed.rootPath) === null)) {
    return { ok: false, code: 'workspace_conflict' };
  }
  let workspaceSource: WorkspaceSource | undefined;
  if (managed) {
    if (!input.accountId || requestedManaged && !matchesAcceptedManagedWorkspaceRef(workspaceRef, requestedManaged)) {
      return { ok: false, code: 'workspace_conflict' };
    }
    workspaceSource = await selectManagedWorkflowWorkspaceSource({ workspace: managed,
      accountId: input.accountId, restore: input.restoreManagedWorkspaceSource, signal: input.signal }) ?? undefined;
    if (!workspaceSource) return { ok: false, code: 'workspace_unavailable' };
  } else if (refId && (!workspaceRef
    || (input.currentServerId !== undefined && workspaceRef.serverId !== input.currentServerId)
    || workspaceRef.machineId !== normalizedTarget.machineId)) {
    return { ok: false, code: 'workspace_conflict' };
  }

  const prepare = async (definition: WorkflowDefinitionV1): Promise<WorkflowWorkspacePreparation> => {
    const pathIsDirectory = input.pathIsDirectory ?? (async (path: string) => {
      try {
        return (await currentWorkspaceSource().stat(path)).isDirectory();
      } catch {
        return false;
      }
    });
    if (!await pathIsDirectory(normalizedTarget.directory)) return { ok: false, code: 'workspace_unavailable' };
    const inspected = await (input.inspectLocation ?? inspectWorkflowWorkspaceLocation)({
      candidatePath: normalizedTarget.directory,
    });
    if (workspaceRef && (inspected
      ? getPathRemainderWithinBase(workspaceRef.rootPath, inspected.inspection.rootPath) !== ''
      : getPathRemainderWithinBase(normalizedTarget.directory, workspaceRef.rootPath) === null)) {
      return { ok: false, code: 'workspace_conflict' };
    }
    const project: WorkflowWorkspaceDescriptor = {
      machineId: normalizedTarget.machineId,
      directory: normalizedTarget.directory,
      checkoutRootPath: inspected?.inspection.rootPath ?? workspaceRef?.rootPath ?? normalizedTarget.directory,
      ...(refId ? { workspaceRefId: refId } : {}),
    };
    const target = { project, ...(placement ? { sessionPlacement: placement } : {}) };
    const originalCommittedRevision = workflowUsesOriginalCommittedRevision(definition)
      ? inspected?.inspection.committedRevision ?? null : undefined;
    if (originalCommittedRevision === null) return { ok: false, code: 'committed_revision_unavailable' };
    return { ok: true,
      workspaceTarget: { ...target, ...(originalCommittedRevision ? { originalCommittedRevision } : {}) },
      ...(workspaceSource ? { workspaceSource } : {}),
    };
  };
  return { ok: true, ...(workspaceSource ? { workspaceSource } : {}),
    prepare: definition => workspaceSource ? runWithWorkspaceSourceDemand(workspaceSource, () => prepare(definition)) : prepare(definition) };
}

/** Freeze the admitted Project path, SCM root, and optional original Git revision. */
export async function prepareWorkflowAcceptedWorkspaceTarget(input: Parameters<typeof admitWorkflowProjectWorkspace>[0]
  & Readonly<{ definition: WorkflowDefinitionV1 }>): Promise<WorkflowWorkspacePreparation> {
  const admitted = await admitWorkflowProjectWorkspace(input);
  return admitted.ok ? await admitted.prepare(input.definition) : admitted;
}

async function realizeWorktree(intent: WorkflowWorkspaceCreationIntent): Promise<Readonly<{
  directory: string;
  checkoutRootPath: string;
  branchName: string;
}> | null> {
  const realized = await realizeWorkspaceCheckoutWithScmWorkspaceSource({
    sourcePath: intent.sourceDirectory,
    checkoutCreation: intent,
  });
  if (!realized) return null;
  let directory: string;
  try {
    directory = await resolveDirectoryInCheckout({
      sourceDirectory: intent.sourceDirectory,
      sourceRootPath: realized.sourceRootPath,
      checkoutRootPath: realized.realization.targetPath,
      source: currentWorkspaceSource(),
    });
  } catch (error) {
    if (error instanceof DirectoryInCheckoutError) return null;
    throw error;
  }
  return {
    directory,
    checkoutRootPath: realized.realization.targetPath,
    branchName: realized.realization.branchName,
  };
}

/** Restores only the exact recorded checkout; it never chooses a replacement path. */
export async function restoreRecordedWorkflowWorkspace(input: Readonly<{
  workspace: WorkflowWorkspaceProgressV1;
  verify?: (
    workspace: WorkflowWorkspaceDescriptor,
    creationIntent?: WorkflowWorkspaceCreationIntent,
  ) => Promise<'available' | 'missing' | 'conflict'>;
}>): Promise<WorkflowWorkspaceRestoreResult> {
  const descriptor = input.workspace.descriptor;
  const intent = input.workspace.creationIntent;
  if (!descriptor || !intent || !descriptor.checkout) return { ok: false, code: 'workflow_workspace_restore_unavailable' };
  const verify = input.verify ?? (async (workspace, creationIntent) => (
    await verifyWorkflowWorkspaceCurrentness(workspace, { creationIntent })
  ));
  try {
    return await verify(descriptor, intent) === 'available'
      ? { ok: true }
      : { ok: false, code: 'workflow_workspace_restore_unavailable' };
  } catch {
    return { ok: false, code: 'workflow_workspace_restore_failed' };
  }
}

export async function resolveWorkflowWorkspace(input: Readonly<{
  selection: WorkflowWorkspaceSelection;
  defaultSelection: WorkflowWorkspaceSelection;
  projectWorkspace: WorkflowWorkspaceDescriptor;
  projectWorkspaceCreationIntent?: WorkflowWorkspaceCreationIntent;
  runId: string;
  logicalInvocationRecordId: string;
  /** A Workflow frame's selected project and lazy default are separate correspondence slots. */
  creationSlot?: 'frame_project';
  originalCommittedRevision?: string;
  /** Resolved stable workflow default when a step forks from `workflow`. */
  workflowWorkspace?: WorkflowWorkspaceSource;
  /** Exact inherited correspondence, including a session-bound cwd or lazy default. */
  inheritedWorkspace?: WorkflowWorkspaceSource;
  conversationWorkspace?: WorkflowConversationWorkspace;
  recorded?: Readonly<{ creationIntent?: WorkflowWorkspaceCreationIntent; workspace?: WorkflowWorkspaceDescriptor }>;
  deps: Dependencies;
}>): Promise<WorkflowWorkspaceResolution> {
  // A reused Session's authenticated cwd is already on its own Machine. It
  // grants no remote filesystem operations or worktree creation to this Run.
  const remoteSessionWorkspace = input.selection.kind === 'inherit' && input.conversationWorkspace
    && input.conversationWorkspace.machineId !== input.projectWorkspace.machineId
    ? input.conversationWorkspace : undefined;
  if (input.recorded?.workspace) {
    if (input.conversationWorkspace && !sameWorkspace(input.conversationWorkspace, input.recorded.workspace)) {
      return { ok: false, code: 'conversation_workspace_mismatch' };
    }
    const verification = remoteSessionWorkspace ? 'available' : await input.deps.verifyRecordedWorkspace?.(
      input.recorded.workspace,
      input.recorded.creationIntent,
    ) ?? 'available';
    if (verification !== 'available') return { ok: false, code: verification === 'missing' ? 'workspace_unavailable' : 'workspace_conflict' };
    return { ok: true, workspace: input.recorded.workspace };
  }

  const selection = input.selection.kind === 'inherit' ? input.defaultSelection : input.selection;
  let source: WorkflowWorkspaceSource;
  if (selection.kind === 'inherit' || selection.kind === 'project_checkout') {
    source = input.selection.kind === 'inherit' && input.inheritedWorkspace
      ? input.inheritedWorkspace
      : { descriptor: input.projectWorkspace,
        ...(input.projectWorkspaceCreationIntent ? { creationIntent: input.projectWorkspaceCreationIntent } : {}) };
  } else if (selection.kind === 'from_step') {
    const resolved = await input.deps.resolveProducerWorkspace?.(selection.producer);
    if (!resolved) return { ok: false, code: 'source_workspace_unavailable' };
    source = resolved;
  } else {
    if (selection.source.kind === 'step') {
      const resolved = await input.deps.resolveProducerWorkspace?.(selection.source.producer);
      if (!resolved) return { ok: false, code: 'source_workspace_unavailable' };
      source = resolved;
    } else {
      source = selection.source.kind === 'workflow' && input.workflowWorkspace
        ? input.workflowWorkspace
        : { descriptor: input.projectWorkspace,
          ...(input.projectWorkspaceCreationIntent ? { creationIntent: input.projectWorkspaceCreationIntent } : {}) };
    }
  }
  const sourceWorkspace = source.descriptor;

  if (sourceWorkspace.machineId !== input.projectWorkspace.machineId
    && (!remoteSessionWorkspace || !sameWorkspace(remoteSessionWorkspace, sourceWorkspace) || selection.kind === 'new_worktree')) {
    return { ok: false, code: 'workspace_conflict' };
  }

  const sourceVerification = remoteSessionWorkspace ? 'available'
    : await input.deps.verifyRecordedWorkspace?.(sourceWorkspace, source.creationIntent) ?? 'available';
  if (sourceVerification !== 'available') {
    return {
      ok: false,
      code: sourceVerification === 'missing' ? 'workspace_unavailable' : 'workspace_conflict',
    };
  }

  if (input.conversationWorkspace && (
    selection.kind === 'new_worktree' || !sameWorkspace(input.conversationWorkspace, sourceWorkspace)
  )) {
    return { ok: false, code: 'conversation_workspace_mismatch' };
  }
  if (selection.kind !== 'new_worktree') {
    // Every accepted workspace choice is a row-local recovery fact, including
    // shared project and producer-derived workspaces. Persisting only newly
    // created worktrees would make a replacement coordinator re-resolve a
    // source whose current attempt or checkout may since have changed.
    if (source.creationIntent) await input.deps.persistCreationIntent?.(source.creationIntent);
    await input.deps.persistWorkspace?.(sourceWorkspace);
    return { ok: true, workspace: sourceWorkspace };
  }

  const intent = input.recorded?.creationIntent ?? (() => null)();
  let creationIntent = intent;
  if (!creationIntent) {
    const baseRef = selection.baseRef ?? (selection.source.kind === 'original'
      ? input.originalCommittedRevision ?? null
      : await (input.deps.inspectCommittedRevision ?? inspectCommittedRevision)(sourceWorkspace.checkoutRootPath));
    if (!baseRef) return { ok: false, code: 'committed_revision_unavailable' };
    creationIntent = { kind: 'git_worktree', sourceDirectory: sourceWorkspace.directory, baseRef, displayName: selection.displayName ?? creationDisplayName(input.runId, input.logicalInvocationRecordId, input.creationSlot), branchMode: 'new' };
    await input.deps.persistCreationIntent?.(creationIntent);
  }
  const realized = await (input.deps.realizeWorktree ?? realizeWorktree)(creationIntent);
  if (!realized) return { ok: false, code: 'scm_unavailable' };
  const workspace: WorkflowWorkspaceDescriptor = {
    machineId: input.projectWorkspace.machineId,
    directory: realized.directory,
    checkoutRootPath: realized.checkoutRootPath,
    ...(sourceWorkspace.sourceInvocation
      ? { sourceInvocation: sourceWorkspace.sourceInvocation }
      : {}),
    checkout: { kind: 'git_worktree', branchName: realized.branchName },
  };
  await input.deps.persistWorkspace?.(workspace);
  return { ok: true, workspace };
}

type CoordinatorWorkspaceResolveInput = Readonly<{
  runId: string;
  definition: WorkflowDefinitionV1;
  step: Pick<WorkflowStep, 'id' | 'execution'>;
  invocation: WorkflowCoordinatorInvocation;
  scope: WorkflowProgressEnvelopeV1['invocationPath']['scope'];
  producerBinding: WorkflowProducerBinding;
  defaultWorkspaceOwner?: WorkflowCoordinatorInvocation;
  conversationBinding?: WorkflowConversationBinding;
  conversationWorkspace?: WorkflowConversationWorkspace;
  useConversationWorkspace?: boolean;
  projectWorkspace?: WorkflowWorkspaceSource;
  publishProjectWorkspaceWithAdmission?: true;
}>;

/** Binds the pure workspace policy adapter to the coordinator's one row-local persistence owner. */
export function createCoordinatorWorkspaceResolver(input: Readonly<{
  store: WorkflowCoordinatorStore;
  projectWorkspace: WorkflowWorkspaceDescriptor;
  workspaceSource?: WorkspaceSource;
  originalCommittedRevision?: string;
  scm?: Pick<Dependencies, 'inspectLocation' | 'inspectCommittedRevision' | 'realizeWorktree' | 'verifyRecordedWorkspace'>;
}>): (params: CoordinatorWorkspaceResolveInput) => Promise<WorkflowWorkspaceResolution & { publishWithAdmission?: true }> {
  const resolve = async (params: CoordinatorWorkspaceResolveInput): Promise<WorkflowWorkspaceResolution & { publishWithAdmission?: true }> => {
    const selection: WorkflowWorkspaceSelection = params.step.execution?.workspace ?? { kind: 'inherit' };
    const defaultSelection: WorkflowWorkspaceSelection = params.definition.defaults.workspace ?? { kind: 'project_checkout' };
    const frameProject = params.invocation.blockKind === 'workflow';
    const conversationWorkspace = params.conversationWorkspace
      ?? ((params.invocation.execution?.kind === 'session' || params.invocation.execution?.kind === 'session_ready')
        ? params.invocation.workspace?.descriptor : undefined);
    const workspaceProgress = (owner: WorkflowCoordinatorInvocation, selectedProject: boolean) => selectedProject
      ? owner.container?.kind === 'body' ? owner.container.frameProjectWorkspace : undefined
      : owner.workspace;
    const recordedWorkspace = (owner: WorkflowCoordinatorInvocation, selectedProject: boolean) => {
      const workspace = workspaceProgress(owner, selectedProject);
      return workspace ? {
        ...(workspace.creationIntent ? { creationIntent: workspace.creationIntent } : {}),
        ...(workspace.descriptor ? { workspace: workspace.descriptor } : {}),
      } : undefined;
    };
    const persistWorkspaceProgress = async (owner: WorkflowCoordinatorInvocation,
      progress: WorkflowWorkspaceProgressV1, selectedProject: boolean) => {
      if (!selectedProject) {
        await input.store.commitFact({ key: owner.key, lifecycle: owner.lifecycle, workspace: progress });
        return;
      }
      const current = await input.store.read(owner.key);
      if (current?.container?.kind !== 'body') throw new Error('workflow_frame_container_missing');
      await input.store.commitFact({ key: owner.key, lifecycle: current.lifecycle,
        container: { ...current.container,
          frameProjectWorkspace: { ...current.container.frameProjectWorkspace, ...progress } } });
    };
    const dependencies = (owner: WorkflowCoordinatorInvocation, selectedProject = false): Dependencies => ({
      ...(input.scm?.inspectCommittedRevision ? { inspectCommittedRevision: input.scm.inspectCommittedRevision } : {}),
      ...(input.scm?.realizeWorktree ? { realizeWorktree: input.scm.realizeWorktree } : {}),
      resolveProducerWorkspace: async (producer) => {
        const record = await params.producerBinding.resolve(producer);
        if (!record) return null;
        const workspace = workspaceProgress(record, record.blockKind === 'workflow');
        return workspace?.descriptor
          ? {
            descriptor: { ...workspace.descriptor, sourceInvocation: { producer, invocationRecordId: record.recordId } },
            ...(workspace.creationIntent ? { creationIntent: workspace.creationIntent } : {}),
          }
          : null;
      },
      persistCreationIntent: async (creationIntent) => {
        await persistWorkspaceProgress(owner, { creationIntent }, selectedProject);
      },
      persistWorkspace: async (descriptor) => {
        await persistWorkspaceProgress(owner, { descriptor }, selectedProject);
      },
      verifyRecordedWorkspace: input.scm?.verifyRecordedWorkspace ?? (async (workspace, creationIntent) => (
        await verifyWorkflowWorkspaceCurrentness(workspace, { creationIntent })
      )),
    });
    const resolveForOwner = (
      owner: WorkflowCoordinatorInvocation,
      selected: WorkflowWorkspaceSelection,
      defaults: WorkflowWorkspaceSelection,
      sources: Readonly<{ workflowWorkspace?: WorkflowWorkspaceSource; inheritedWorkspace?: WorkflowWorkspaceSource }> = {},
      conversationWorkspace?: WorkflowConversationWorkspace,
      selectedProject = false,
      publishWithAdmission = false,
    ) => resolveWorkflowWorkspace({
      selection: selected,
      defaultSelection: defaults,
      projectWorkspace: params.projectWorkspace?.descriptor ?? input.projectWorkspace,
      ...(params.projectWorkspace?.creationIntent
        ? { projectWorkspaceCreationIntent: params.projectWorkspace.creationIntent } : {}),
      ...sources,
      ...(conversationWorkspace ? { conversationWorkspace } : {}),
      runId: params.runId,
      logicalInvocationRecordId: owner.logicalInvocationRecordId ?? owner.recordId,
      ...(selectedProject ? { creationSlot: 'frame_project' as const } : {}),
      ...(input.originalCommittedRevision ? { originalCommittedRevision: input.originalCommittedRevision } : {}),
      recorded: recordedWorkspace(owner, selectedProject),
      deps: { ...dependencies(owner, selectedProject),
        ...(publishWithAdmission ? { persistWorkspace: undefined } : {}) },
    });

    // A leaf's recorded correspondence is exact, even if its lazy default or
    // producer has since changed. Known missing paths are never rematerialized.
    if (workspaceProgress(params.invocation, frameProject)?.descriptor) {
      return await resolveForOwner(params.invocation, selection, defaultSelection, {}, conversationWorkspace, frameProject);
    }
    if (selection.kind === 'new_worktree' && conversationWorkspace) {
      return { ok: false, code: 'conversation_workspace_mismatch' };
    }

    if (selection.kind === 'inherit' && params.useConversationWorkspace && conversationWorkspace) {
      const conversation = params.step.execution?.conversation ?? params.definition.defaults.conversation;
      let source: WorkflowWorkspaceSource;
      if (conversation?.kind === 'from_step') {
        const resolved = await dependencies(params.invocation).resolveProducerWorkspace?.(conversation.producer);
        if (!resolved) return { ok: false, code: 'source_workspace_unavailable' };
        source = resolved;
      } else if (params.conversationBinding?.kind === 'shared') {
        const owner = await input.store.readByLogicalInvocation(params.conversationBinding.scopeOwnerKey);
        const sourceId = owner?.sharedConversationInvocationRecordId?.session;
        const record = sourceId ? await input.store.readByLogicalInvocation(sourceId) : undefined;
        if (!record?.workspace?.descriptor) return { ok: false, code: 'source_workspace_unavailable' };
        source = { descriptor: record.workspace.descriptor,
          ...(record.workspace.creationIntent ? { creationIntent: record.workspace.creationIntent } : {}) };
      } else {
        const directory = conversationWorkspace.directory;
        // Remote reuse retains only the Session's cwd. The cwd is the
        // descriptor's scope; no coordinator-side SCM root is inferred.
        const inspected = conversationWorkspace.machineId === input.projectWorkspace.machineId
          ? await (input.scm?.inspectLocation ?? inspectWorkflowWorkspaceLocation)({ candidatePath: directory })
          : null;
        const checkoutRootPath = inspected?.inspection.rootPath ?? directory;
        source = { descriptor: {
          machineId: conversationWorkspace.machineId, directory, checkoutRootPath,
        } };
      }
      return await resolveForOwner(params.invocation, selection, { kind: 'project_checkout' },
        { inheritedWorkspace: source }, conversationWorkspace, frameProject);
    }

    const needsDefault = defaultSelection.kind === 'new_worktree' && (
      selection.kind === 'inherit'
      || (selection.kind === 'new_worktree' && selection.source.kind === 'workflow')
    );
    let workflowWorkspace: WorkflowWorkspaceSource | undefined;
    if (needsDefault) {
      const rootKey = workflowInvocationKey({ runId: params.runId, blockId: '$root', scope: [], attempt: 0 });
      const owner = await input.store.read(params.defaultWorkspaceOwner?.key ?? rootKey);
      if (!owner) return { ok: false, code: 'workspace_unavailable' };
      const resolved = await resolveForOwner(owner, defaultSelection, { kind: 'project_checkout' }, {},
        selection.kind === 'inherit' ? conversationWorkspace : undefined);
      if (!resolved.ok) return resolved;
      const recorded = await input.store.read(owner.key);
      workflowWorkspace = {
        descriptor: resolved.workspace,
        ...(recorded?.workspace?.creationIntent ? { creationIntent: recorded.workspace.creationIntent } : {}),
      };
    }
    // The accepted project itself has no mutable producer or creation slot.
    // The caller still verifies it here, then records it with input admission.
    const project = params.projectWorkspace?.descriptor ?? input.projectWorkspace;
    const publishWithAdmission = params.publishProjectWorkspaceWithAdmission === true && params.invocation.blockKind === 'action'
      && !frameProject && !params.projectWorkspace?.creationIntent && !project.sourceInvocation
      && project.checkout?.kind !== 'git_worktree'
      && (selection.kind === 'project_checkout' || selection.kind === 'inherit' && defaultSelection.kind === 'project_checkout');
    const resolution = await resolveForOwner(params.invocation, selection,
      workflowWorkspace && selection.kind === 'inherit' ? { kind: 'project_checkout' } : defaultSelection,
      {
        ...(workflowWorkspace ? { workflowWorkspace } : {}),
        ...(workflowWorkspace && selection.kind === 'inherit' ? { inheritedWorkspace: workflowWorkspace } : {}),
      }, conversationWorkspace, frameProject, publishWithAdmission);
    return resolution.ok && publishWithAdmission ? { ...resolution, publishWithAdmission: true } : resolution;
  };
  const source = input.workspaceSource;
  return source ? params => runWithWorkspaceSourceDemand(source, () => resolve(params)) : resolve;
}
