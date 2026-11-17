import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, realpath, rm } from 'node:fs/promises';
import { dirname, join, normalize, resolve } from 'node:path';

import { getPathRemainderWithinBase } from '@/session/handoff/paths/sessionHandoffPathNormalization';
import { realpathWithAbsentSuffix } from '@/utils/path/physicalAncestorPath';
import { inspectWorkspaceLocationWithScmWorkspace } from '@/scm/workspace/workspaceLocationInspection';
import { realizeWorkspaceCheckoutWithScmWorkspace } from '@/scm/workspace/workspaceCheckoutOperations';
import type { ScmWorkspaceIntegrationWorkspaceCheckoutRealizationResult } from '@/scm/workspace/workspaceCheckoutRealization';
import { normalizeSessionHandoffWorkspaceRootPath } from '@happier-dev/protocol/sessions/control/handoff/workspaceTransferSourcePathSafety';
import { decodeWorkspaceSyncSeedBaseline, encodeWorkspaceSyncSeedBaseline } from './workspaceSyncSeedTransfer';
import type { HandoffTargetReplacementApprovalV1 } from '@happier-dev/protocol';
import type { WorkspaceManifest } from '@happier-dev/protocol/workspaces/manifestSchema';
import type { WorkspaceRootOwnershipHandle, WorkspaceRootOwnershipManager } from './workspaceSyncRootOwnership';
import {
  abortWorkspaceTargetMaterializationAfterFailure,
  beginWorkspaceTargetMaterialization,
  recoverInterruptedWorkspaceTargetMaterialization,
  rehydrateWorkspaceTargetMaterializationFromReceiptPath,
  inspectCommittedWorkspaceTargetMaterialization,
  removeCommittedWorkspaceTargetMaterialization,
  assertWorkspaceTargetMaterializationWorkerCopyCreation,
  type WorkspaceExportMaterializationCustody,
  type WorkspaceTargetMaterializationFence,
  type WorkspaceTargetMaterializationWorkerCopyCreation,
} from '@/scm/workspace/workspaceExportMaterialization';
import {
  computeWorkspaceSyncAbsentRootFingerprint,
  computeWorkspaceSyncRootFingerprint,
  readWorkspaceSyncRootObjectIdentity,
} from './workspaceSyncRootIdentity';
import {
  matchesWorkspaceSyncFinalReadyFact,
  readWorkspaceSyncFinalReadyFactAtPath,
  writeWorkspaceSyncFinalReadyFact as writeReadyFact,
  type WorkspaceSyncFinalReadyFactInput,
  type WorkspaceSyncRequesterCopyCustody,
  type WorkspaceSyncNativeCopyOwner,
  workspaceSyncNativeCopyOwnerKey,
  matchesWorkspaceSyncNativeCopyReadyFact,
} from './workspaceSyncFinalReadyFact';
export type { WorkspaceSyncFinalReadyFact } from './workspaceSyncFinalReadyFact';

export type WorkspaceSyncTargetBootstrapInput = Readonly<{
  rootPath: string;
  /** Present only when the source root is on this daemon and path-comparable. */
  sourceRootPath?: string;
  relationshipId: string;
  endpointRole: 'alpha' | 'beta';
  targetWorkspaceRefId: string;
  policyDigest: string;
  contentSelection: 'git_worktree' | 'all_files';
  /** File-only finite seeds materialize before READY, including an empty destination. */
  contentOnly?: true;
  /** Receiving target's current persisted Home definition; never a caller's transient marker. */
  workerCopyCreation?: WorkspaceTargetMaterializationWorkerCopyCreation;
  requesterCopyCustody?: WorkspaceSyncRequesterCopyCustody;
  /** A finite managed Project copy keeps its accepted root across reviewed child operations. */
  nativeCopyOwner?: WorkspaceSyncNativeCopyOwner;
  /** Host-private Action approval, reinspected at this target under root custody. */
  targetReplacementApproval?: HandoffTargetReplacementApprovalV1;
  /** Owner-local proof binding the unchanged chosen child root to this physical root. */
  targetReplacementApprovalTarget?: Readonly<{ canonicalRoot: string; assertCurrent(): Promise<void> }>;
  /**
   * Whether this bootstrap activates exact mirroring, which authorizes deleting
   * target-only files even when the destination is missing or empty today.
   */
  activatesExactMirror?: boolean;
  /** Out-of-tree owner for the canonical finite materialization receipt. */
  materializationDirectory: string;
  rootOwnershipManager: WorkspaceRootOwnershipManager;
  createIfMissing?: boolean;
  /** Explicit user intent for this target; never inferred from target contents. */
  targetBootstrap: 'use_existing' | 'materialize_from_source_workspace';
  /** SCM-owned Git verification/materialization. Credentials stay inside this callback. */
  prepareGitTarget?: (input: Readonly<{
    canonicalRoot: string;
    sourceRootPath?: string;
    relationshipId: string;
    endpointRole: 'alpha' | 'beta';
    policyDigest: string;
    targetState: 'missing' | 'empty' | 'nonempty';
    targetBootstrap: 'use_existing' | 'materialize_from_source_workspace';
    materializationReceiptPath: string;
    targetFence: WorkspaceTargetMaterializationFence;
  }>) => Promise<(WorkspaceExportMaterializationCustody & Readonly<{ manifest?: WorkspaceManifest; excludedPaths?: readonly string[] }>) | void>;
  materializeSeed?: (input: Readonly<{
    canonicalRoot: string;
    relationshipId: string;
    endpointRole: 'alpha' | 'beta';
    policyDigest: string;
    materializationReceiptPath: string;
    originalTargetExists: boolean;
    targetFence: WorkspaceTargetMaterializationFence;
  }>) => Promise<(WorkspaceExportMaterializationCustody & Readonly<{ manifest?: WorkspaceManifest; excludedPaths?: readonly string[] }>) | void>;
}>;

export type WorkspaceSyncTargetBootstrapResult = Readonly<{
  canonicalRoot: string;
  created: boolean;
  state: 'READY';
  rootFingerprint: string;
  policyDigest: string;
  ownershipHandles: readonly WorkspaceRootOwnershipHandle[];
  materializationCustody?: WorkspaceExportMaterializationCustody;
  copyOnceBaseline?: WorkspaceManifest;
  copyOnceExcludedPaths?: readonly string[];
  /** True only when the exact durable READY fact was already observed or published. */
  readyPublished: boolean;
  requesterCopyCustody?: WorkspaceSyncRequesterCopyCustody;
  publishReady(): Promise<void>;
  release(): Promise<void>;
}>;

function bootstrapOperationKey(relationshipId: string, endpointRole: 'alpha' | 'beta'): string {
  return createHash('sha256')
    .update('workspace-sync-bootstrap-v1\0')
    .update(relationshipId)
    .update('\0')
    .update(endpointRole)
    .digest('hex');
}

export function workspaceSyncMaterializationReceiptPath(materializationDirectory: string, relationshipId: string, endpointRole: 'alpha' | 'beta') {
  return join(resolve(materializationDirectory), `${bootstrapOperationKey(relationshipId, endpointRole)}.json`);
}

export type WorkspaceSyncCommittedCopyRemoval = Readonly<{
  rootPath: string;
  relationshipId: string;
  endpointRole: 'alpha' | 'beta';
  rootFingerprint: string;
  materializationDirectory: string;
  signal?: AbortSignal;
  workerCopyCreation?: WorkspaceTargetMaterializationWorkerCopyCreation;
}>;

export async function inspectWorkspaceSyncCommittedCopy(input: Omit<WorkspaceSyncCommittedCopyRemoval, 'rootFingerprint'> & Readonly<{
  rootFingerprint?: string;
  measureSize?: true;
}>): Promise<Readonly<{ rootFingerprint: string; sizeBytes?: number }>> {
  input.signal?.throwIfAborted();
  const receipt = await inspectCommittedWorkspaceTargetMaterialization({
    targetPath: input.rootPath,
    ...(input.rootFingerprint === undefined ? {} : { rootFingerprint: input.rootFingerprint }),
    receiptPath: workspaceSyncMaterializationReceiptPath(input.materializationDirectory, input.relationshipId, input.endpointRole),
    ...(input.measureSize ? { measureSize: true } : {}),
    ...(input.workerCopyCreation ? { workerCopyCreation: input.workerCopyCreation } : {}),
  });
  return { rootFingerprint: receipt.committed.rootFingerprint,
    ...(receipt.sizeBytes === undefined ? {} : { sizeBytes: receipt.sizeBytes }) };
}

export async function removeWorkspaceSyncCommittedCopy(input: WorkspaceSyncCommittedCopyRemoval & Readonly<{
  rootOwnershipManager: WorkspaceRootOwnershipManager;
  /** The native target already holds this exact root until removal settles. */
  retainedOwnership?: WorkspaceRootOwnershipHandle;
}>): Promise<void> {
  const ownership = input.retainedOwnership ?? await input.rootOwnershipManager.tryAcquire({
    ownerId: input.relationshipId, canonicalRoot: input.rootPath, operation: 'bootstrap',
  });
  if ('kind' in ownership) throw bootstrapError('workspace_root_in_use', 'Workspace copy root overlaps active work');
  try {
    await removeCommittedWorkspaceTargetMaterialization({
      targetPath: input.rootPath,
      rootFingerprint: input.rootFingerprint,
      receiptPath: workspaceSyncMaterializationReceiptPath(input.materializationDirectory, input.relationshipId, input.endpointRole),
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.workerCopyCreation ? { workerCopyCreation: input.workerCopyCreation } : {}),
    });
  } finally {
    if (!input.retainedOwnership) await ownership.release();
  }
}

function finalReadyPath(materializationDirectory: string, relationshipId: string, endpointRole: 'alpha' | 'beta', nativeCopyOwner?: WorkspaceSyncNativeCopyOwner): string {
  const key = nativeCopyOwner ? createHash('sha256').update('workspace-native-copy-v1\0')
    .update(workspaceSyncNativeCopyOwnerKey(nativeCopyOwner)).digest('hex') : bootstrapOperationKey(relationshipId, endpointRole);
  return join(resolve(materializationDirectory), `${key}.ready.json`);
}

export type WorkspaceSyncTargetBootstrapDependencies = Readonly<{
  writeReadyFact?(path: string, fact: WorkspaceSyncFinalReadyFactInput): Promise<void>;
  rehydrateMaterializationFromReceiptPath?: typeof rehydrateWorkspaceTargetMaterializationFromReceiptPath;
}>;

export async function readWorkspaceSyncFinalReadyFact(materializationDirectory: string, relationshipId: string, endpointRole: 'alpha' | 'beta') {
  return await readWorkspaceSyncFinalReadyFactAtPath(finalReadyPath(materializationDirectory, relationshipId, endpointRole));
}

/** Read original seed correspondence from the accepted native root, never from its edited tree. */
export async function readWorkspaceSyncNativeCopyOnceBaseline(input: Readonly<{
  materializationDirectory: string; owner: WorkspaceSyncNativeCopyOwner; policyDigest: string;
}>): Promise<WorkspaceManifest | null> {
  const fact = await readWorkspaceSyncFinalReadyFactAtPath(finalReadyPath(input.materializationDirectory, '', 'beta', input.owner));
  if (!fact) return null;
  const canonicalRoot = await realpath(input.owner.target.rootPath).catch(() => null);
  if (!canonicalRoot) return null;
  const rootFingerprint = await computeWorkspaceSyncRootFingerprint(canonicalRoot).catch(() => null);
  if (!rootFingerprint || !matchesWorkspaceSyncNativeCopyReadyFact(fact, input.owner,
    { canonicalRoot, rootFingerprint, policyDigest: input.policyDigest })) return null;
  return decodeWorkspaceSyncSeedBaseline(fact.copyOnceBaseline);
}

async function hasExactReadyFact(path: string, expected: WorkspaceSyncFinalReadyFactInput): Promise<boolean> {
  const fact = await readWorkspaceSyncFinalReadyFactAtPath(path);
  return fact !== null && matchesWorkspaceSyncFinalReadyFact(fact, expected);
}

function bootstrapError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

/**
 * Verifies an already-selected checkout whose repository root is exactly the
 * authorized target WorkspaceRef root. Materialization owners use this same
 * verifier after they have populated a missing or empty target.
 */
export async function prepareExistingGitWorkspaceSyncTarget(input: Readonly<{
  canonicalRoot: string;
  targetState: 'missing' | 'empty' | 'nonempty';
}>, dependencies: Readonly<{
  inspectWorkspaceLocation(input: Readonly<{ candidatePath: string }>): Promise<Readonly<{
    workspaceLocationScm?: Readonly<{ provider: string; rootPath: string }>;
    checkoutDiscovery: readonly Readonly<{ kind: string }>[];
  }> | null>;
}> = {
  inspectWorkspaceLocation: inspectWorkspaceLocationWithScmWorkspace,
}): Promise<void> {
  if (input.targetState !== 'nonempty') {
    throw bootstrapError('target_bootstrap_required', 'Git workspace sync target requires an explicit SCM bootstrap source');
  }
  const canonicalRoot = await realpath(input.canonicalRoot).catch(() => null);
  if (!canonicalRoot) {
    throw bootstrapError('git_selection_unavailable', 'Git workspace sync target is unavailable');
  }
  const inspection = await dependencies.inspectWorkspaceLocation({
    candidatePath: canonicalRoot,
  });
  const inspectedRoot = inspection?.workspaceLocationScm?.provider === 'git'
    ? await realpath(inspection.workspaceLocationScm.rootPath).catch(() => null)
    : null;
  if (inspectedRoot !== canonicalRoot
    || !inspection?.checkoutDiscovery.some(({ kind }) => kind === 'git_worktree')) {
    throw bootstrapError('git_selection_unavailable', 'Selected workspace sync target is not a Git checkout rooted at the authorized path');
  }
}

/**
 * Applies the user's target choice at the SCM ownership boundary. Existing
 * checkouts are verified in place; materialization delegates to the canonical
 * SCM workspace integration so repository credentials and Git behavior never
 * leak into workspace-sync.
 */
export async function prepareWorkspaceSyncGitTarget(input: Readonly<{
  canonicalRoot: string;
  sourceRootPath?: string;
  relationshipId: string;
  targetState: 'missing' | 'empty' | 'nonempty';
  targetBootstrap: 'use_existing' | 'materialize_from_source_workspace';
  materializationReceiptPath: string;
  targetFence: WorkspaceTargetMaterializationFence;
}>, dependencies: Readonly<{
  realizeWorkspaceCheckout(input: Readonly<{
    sourcePath: string;
    targetPath?: string;
    checkoutCreation: Readonly<{
      kind: 'git_worktree';
      displayName: string;
      baseRef: string | null;
      branchMode: 'new';
    }>;
  }>): Promise<ScmWorkspaceIntegrationWorkspaceCheckoutRealizationResult | null>;
  inspectWorkspaceLocation: NonNullable<Parameters<typeof prepareExistingGitWorkspaceSyncTarget>[1]>['inspectWorkspaceLocation'];
}> = {
  realizeWorkspaceCheckout: realizeWorkspaceCheckoutWithScmWorkspace,
  inspectWorkspaceLocation: inspectWorkspaceLocationWithScmWorkspace,
}): Promise<WorkspaceExportMaterializationCustody | void> {
  if (input.targetBootstrap === 'use_existing') {
    return await prepareExistingGitWorkspaceSyncTarget(input, {
      inspectWorkspaceLocation: dependencies.inspectWorkspaceLocation,
    });
  }
  const sourceRootPath = input.sourceRootPath?.trim();
  if (!sourceRootPath || !(await lstat(sourceRootPath).catch(() => null))?.isDirectory()) {
    throw bootstrapError('target_bootstrap_offline', 'Source workspace is unavailable for Git target preparation');
  }
  const displayName = `happier-sync-${createHash('sha256').update(input.relationshipId).digest('hex').slice(0, 12)}`;
  const targetMaterialization = await beginWorkspaceTargetMaterialization({
    targetPath: input.canonicalRoot,
    backupDirectoryPrefix: '.happier-sync-backup',
    receiptPath: input.materializationReceiptPath,
    originalTargetExists: input.targetState !== 'missing',
    targetFence: input.targetFence,
  });
  try {
    const realization = await dependencies.realizeWorkspaceCheckout({
      sourcePath: sourceRootPath,
      targetPath: input.canonicalRoot,
      checkoutCreation: {
        kind: 'git_worktree',
        displayName,
        baseRef: null,
        branchMode: 'new',
      },
    });
    if (!realization) {
      throw bootstrapError('git_selection_unavailable', 'Source workspace cannot materialize a Git target');
    }
    await targetMaterialization.custody.bindPromotedTarget();
    const realizedRoot = await realpath(realization.targetPath).catch(() => null);
    const expectedRoot = await realpath(input.canonicalRoot).catch(() => null);
    if (!realizedRoot || realizedRoot !== expectedRoot) {
      throw bootstrapError('root_changed', 'SCM materialized outside the authorized workspace sync target');
    }
    await prepareExistingGitWorkspaceSyncTarget({
      canonicalRoot: expectedRoot,
      targetState: 'nonempty',
    }, { inspectWorkspaceLocation: dependencies.inspectWorkspaceLocation });
    return targetMaterialization.custody;
  } catch (error) {
    await abortWorkspaceTargetMaterializationAfterFailure(targetMaterialization.custody, error);
    throw error;
  }
}

export { computeWorkspaceSyncRootFingerprint } from './workspaceSyncRootIdentity';

/**
 * Rebuilds process-local target custody from the settings-owned relationship,
 * current root identity, and the canonical finite materialization receipt.
 */
export async function rehydrateWorkspaceSyncTargetBootstrap(input: Readonly<{
  rootPath: string;
  relationshipId: string;
  endpointRole: 'alpha' | 'beta';
  targetWorkspaceRefId: string;
  policyDigest: string;
  contentSelection: 'git_worktree' | 'all_files';
  contentOnly?: true;
  workerCopyCreation?: WorkspaceTargetMaterializationWorkerCopyCreation;
  requesterCopyCustody?: WorkspaceSyncRequesterCopyCustody;
  materializationDirectory: string;
  rootOwnershipManager: WorkspaceRootOwnershipManager;
  /** Restart cleanup probe: do nothing unless the finite receipt exists. */
  requireMaterializationReceipt?: boolean;
  prepareGitTarget?: WorkspaceSyncTargetBootstrapInput['prepareGitTarget'];
}>, dependencies: Pick<WorkspaceSyncTargetBootstrapDependencies, 'rehydrateMaterializationFromReceiptPath'> = {}): Promise<WorkspaceSyncTargetBootstrapResult | null> {
  const contentSelection = input.contentOnly ? 'all_files' : input.contentSelection;
  const receiptPath = workspaceSyncMaterializationReceiptPath(input.materializationDirectory, input.relationshipId, input.endpointRole);
  const readyPath = finalReadyPath(input.materializationDirectory, input.relationshipId, input.endpointRole);
  if (input.requireMaterializationReceipt
    && !(await lstat(receiptPath).catch(() => null))?.isFile()) return null;
  const requested = normalize(resolve(input.rootPath));
  if (requested === resolve('/')) throw bootstrapError('workspace_root_unsafe', 'workspace sync target root is invalid');
  const existingBeforeRecovery = await lstat(requested).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  });
  if (existingBeforeRecovery && (!existingBeforeRecovery.isDirectory() || existingBeforeRecovery.isSymbolicLink())) {
    throw bootstrapError('workspace_root_unsafe', 'workspace sync target root must be a real directory');
  }
  const canonicalRootCandidate = existingBeforeRecovery
    ? await realpath(requested)
    : await realpathWithAbsentSuffix(requested).catch(() => null);
  if (typeof canonicalRootCandidate !== 'string' || canonicalRootCandidate === resolve('/')) {
    throw bootstrapError('workspace_root_unsafe', 'workspace sync target parent is unavailable');
  }
  const canonicalRoot = canonicalRootCandidate;
  const ownership = await input.rootOwnershipManager.tryAcquire({
    ownerId: input.relationshipId,
    canonicalRoot,
    operation: 'bootstrap',
    deferRootIdentityBinding: true,
  });
  if ('kind' in ownership) {
    // The relationship's own running sync already fences this root, directly or as the shared hub
    // workspace of this endpoint, so there is no bootstrap custody left to rebuild; only a foreign
    // operation is a conflict.
    if (ownership.existing.operation === 'sync'
      && (ownership.existing.ownerId === input.relationshipId
        || ownership.existing.ownerId === input.targetWorkspaceRefId)) return null;
    throw bootstrapError('workspace_root_in_use', 'Workspace sync target root overlaps an active operation');
  }
  const materializationCustody = await (dependencies.rehydrateMaterializationFromReceiptPath
    ?? rehydrateWorkspaceTargetMaterializationFromReceiptPath)({
    targetPath: canonicalRoot,
    backupDirectoryPrefix: '.happier-sync-backup',
    receiptPath,
  }).catch(async () => {
    await ownership.release();
    throw bootstrapError('target_bootstrap_required', 'Workspace sync target rollback receipt is unsafe');
  });
  if (materializationCustody && input.workerCopyCreation) {
    try {
      assertWorkspaceTargetMaterializationWorkerCopyCreation(materializationCustody.receipt, input.workerCopyCreation);
    } catch (error) {
      // Rejected original custody never enters this invocation's rollback block.
      await ownership.release();
      throw error;
    }
  }
  let exactReady = false;
  let materializationSettled = false;
  try {
    const currentRootStat = await lstat(requested).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    });
    const currentRoot = currentRootStat?.isDirectory() && !currentRootStat.isSymbolicLink()
      ? await realpath(requested).catch(() => null)
      : null;
    const fingerprint = currentRoot === canonicalRoot
      ? await computeWorkspaceSyncRootFingerprint(currentRoot).catch(() => null)
      : null;
    const readyFact = fingerprint === null
      ? null
      : {
          v: 1,
          relationshipId: input.relationshipId,
          endpointRole: input.endpointRole,
          targetWorkspaceRefId: input.targetWorkspaceRefId,
          canonicalRoot,
          rootFingerprint: fingerprint,
          policyDigest: input.policyDigest,
        } as const;
    const persistedReady = await readWorkspaceSyncFinalReadyFactAtPath(readyPath);
    exactReady = readyFact !== null && persistedReady !== null && matchesWorkspaceSyncFinalReadyFact(persistedReady,
      { ...readyFact, ...(input.requesterCopyCustody ? { requesterCopyCustody: input.requesterCopyCustody } : {}) });
    if (materializationCustody && !exactReady) {
      await materializationCustody.abort();
      materializationSettled = true;
      await ownership.release();
      return null;
    }
    if (!exactReady || readyFact === null || persistedReady === null) {
      if (currentRoot === null && !materializationCustody) {
        throw bootstrapError('root_changed', 'Workspace sync target root is unavailable');
      }
      await ownership.release();
      return null;
    }
    if (contentSelection === 'git_worktree') {
      if (input.prepareGitTarget) {
        await input.prepareGitTarget({
          canonicalRoot,
          relationshipId: input.relationshipId,
          endpointRole: input.endpointRole,
          policyDigest: input.policyDigest,
          targetState: 'nonempty',
          targetBootstrap: 'use_existing',
          materializationReceiptPath: receiptPath,
          targetFence: {
            state: 'nonempty',
            identity: await readWorkspaceSyncRootObjectIdentity(canonicalRoot),
          },
        });
      } else {
        await prepareExistingGitWorkspaceSyncTarget({ canonicalRoot, targetState: 'nonempty' });
      }
    }
    await ownership.bindCurrentRootIdentity();
    return {
      canonicalRoot,
      created: false,
      state: 'READY',
      rootFingerprint: readyFact.rootFingerprint,
      policyDigest: input.policyDigest,
      ownershipHandles: [ownership],
      ...(materializationCustody ? { materializationCustody } : {}),
      readyPublished: true,
      ...(persistedReady.v === 2 ? { requesterCopyCustody: persistedReady.requesterCopyCustody } : {}),
      publishReady: async (): Promise<void> => await writeReadyFact(readyPath, persistedReady),
      release: ownership.release,
    };
  } catch (error) {
    if (materializationCustody && !materializationSettled) {
      await (exactReady ? materializationCustody.commit() : materializationCustody.abort()).then(
        () => { materializationSettled = true; },
        () => undefined,
      );
    }
    await ownership.release();
    throw error;
  }
}

export async function workspaceSyncTargetBootstrap(
  input: WorkspaceSyncTargetBootstrapInput,
  dependencies: WorkspaceSyncTargetBootstrapDependencies = { writeReadyFact },
): Promise<WorkspaceSyncTargetBootstrapResult> {
  const contentSelection = input.contentOnly ? 'all_files' : input.contentSelection;
  const persistReadyFact = dependencies.writeReadyFact ?? writeReadyFact;
  if (!input.rootPath.trim()) throw bootstrapError('workspace_root_unsafe', 'workspace sync target root is blank');
  let sourceRoot: string | undefined;
  if (input.sourceRootPath !== undefined) {
    const normalizedSourceRoot = normalizeSessionHandoffWorkspaceRootPath(input.sourceRootPath);
    if (!normalizedSourceRoot) {
      throw bootstrapError('workspace_root_unsafe', 'workspace sync source root is invalid');
    }
    sourceRoot = normalizedSourceRoot;
  }
  if (!input.relationshipId.trim() || !/^[a-f0-9]{64}$/u.test(input.policyDigest)) {
    throw bootstrapError('target_bootstrap_rejected', 'workspace sync target bootstrap is not authorized');
  }
  if (!input.materializationDirectory.trim()) throw bootstrapError('target_bootstrap_rejected', 'workspace sync materialization directory is blank');

  const requested = normalize(resolve(input.rootPath));
  if (requested === resolve('/')) throw bootstrapError('workspace_root_unsafe', 'workspace sync target root is invalid');
  const receiptPath = workspaceSyncMaterializationReceiptPath(input.materializationDirectory, input.relationshipId, input.endpointRole);
  const readyPath = finalReadyPath(input.materializationDirectory, input.relationshipId, input.endpointRole, input.nativeCopyOwner);
  let created = false;
  let existingBeforeFence = await lstat(requested).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  });
  if (existingBeforeFence && (!existingBeforeFence.isDirectory() || existingBeforeFence.isSymbolicLink())) {
    throw bootstrapError('workspace_root_unsafe', 'workspace sync target root must be a real directory');
  }
  const canonicalRootCandidate = existingBeforeFence
    ? await realpath(requested)
    : await realpathWithAbsentSuffix(requested).catch(() => null);
  if (typeof canonicalRootCandidate !== 'string' || canonicalRootCandidate === resolve('/')) {
    throw bootstrapError('workspace_root_unsafe', 'workspace sync target parent is unavailable');
  }
  const canonicalRoot = canonicalRootCandidate;
  const canonicalSourceRoot = sourceRoot === undefined
    ? undefined
    : await realpath(sourceRoot).catch(() => sourceRoot);
  if (canonicalSourceRoot !== undefined && (
    getPathRemainderWithinBase(canonicalRoot, canonicalSourceRoot) !== null
    || getPathRemainderWithinBase(canonicalSourceRoot, canonicalRoot) !== null
  )) {
    throw bootstrapError('workspace_root_unsafe', 'workspace sync source and target roots overlap');
  }
  if (contentSelection === 'git_worktree' && !input.prepareGitTarget) {
    throw bootstrapError('target_bootstrap_required', 'Git workspace sync target requires an explicit SCM bootstrap source');
  }

  const ownership = await input.rootOwnershipManager.tryAcquire({
    ownerId: input.relationshipId,
    canonicalRoot,
    operation: 'bootstrap',
    deferRootIdentityBinding: true,
  });
  if ('kind' in ownership) throw bootstrapError('workspace_root_in_use', 'workspace sync target root overlaps an active operation');
  let materializationCustody: WorkspaceExportMaterializationCustody | undefined;
  let copyOnceBaseline: WorkspaceManifest | undefined;
  let copyOnceExcludedPaths: readonly string[] | undefined;
  let trustedReadyRequiresCommitOnlyCleanup = false;
  let rejectedOriginalMaterialization = false;
  try {
    const interruptedCustody = await (dependencies.rehydrateMaterializationFromReceiptPath
      ?? rehydrateWorkspaceTargetMaterializationFromReceiptPath)({
      targetPath: requested,
      backupDirectoryPrefix: '.happier-sync-backup',
      receiptPath,
    }).catch((error: unknown) => {
      throw bootstrapError('target_bootstrap_required', `Workspace sync target recovery failed: ${(error as Error).message}`);
    });
    if (input.nativeCopyOwner) {
      const fact = await readWorkspaceSyncFinalReadyFactAtPath(readyPath);
      const currentRoot = await realpath(requested).catch(() => null);
      const fingerprint = currentRoot === canonicalRoot ? await computeWorkspaceSyncRootFingerprint(canonicalRoot).catch(() => null) : null;
      if (fact && fingerprint && matchesWorkspaceSyncNativeCopyReadyFact(fact, input.nativeCopyOwner,
        { canonicalRoot, rootFingerprint: fingerprint, policyDigest: input.policyDigest })) {
        materializationCustody = interruptedCustody ?? undefined;
        trustedReadyRequiresCommitOnlyCleanup = true;
        const baseline = decodeWorkspaceSyncSeedBaseline(fact.copyOnceBaseline);
        await ownership.bindCurrentRootIdentity();
        return { canonicalRoot, created: false, state: 'READY', rootFingerprint: fingerprint,
          policyDigest: input.policyDigest, ownershipHandles: [ownership], readyPublished: true,
          copyOnceBaseline: baseline, ...(materializationCustody ? { materializationCustody } : {}),
          publishReady: async () => await persistReadyFact(readyPath, fact), release: ownership.release };
      }
    }
    if (interruptedCustody) {
      if (input.workerCopyCreation) {
        try {
          assertWorkspaceTargetMaterializationWorkerCopyCreation(interruptedCustody.receipt, input.workerCopyCreation);
        } catch (error) {
          rejectedOriginalMaterialization = true;
          throw error;
        }
      }
      const restartRoot = await realpath(requested).catch(() => null);
      const restartFingerprint = restartRoot
        ? await computeWorkspaceSyncRootFingerprint(restartRoot).catch(() => null)
        : null;
      const restartReadyFact = restartRoot === canonicalRoot && restartFingerprint !== null
        ? {
          ...(input.requesterCopyCustody ? { v: 2 as const, requesterCopyCustody: input.requesterCopyCustody } : { v: 1 as const }),
          relationshipId: input.relationshipId,
          endpointRole: input.endpointRole,
          targetWorkspaceRefId: input.targetWorkspaceRefId,
          canonicalRoot,
          rootFingerprint: restartFingerprint,
          policyDigest: input.policyDigest,
        } as const
        : null;
      const restartReady = restartReadyFact !== null
        && await hasExactReadyFact(readyPath, restartReadyFact);
      if (restartReady && restartReadyFact) {
        materializationCustody = interruptedCustody;
        trustedReadyRequiresCommitOnlyCleanup = true;
        if (contentSelection === 'git_worktree') {
          await input.prepareGitTarget!({
            canonicalRoot,
            ...(canonicalSourceRoot === undefined ? {} : { sourceRootPath: canonicalSourceRoot }),
            relationshipId: input.relationshipId,
            endpointRole: input.endpointRole,
            policyDigest: input.policyDigest,
            targetState: 'nonempty',
            targetBootstrap: 'use_existing',
            materializationReceiptPath: receiptPath,
            targetFence: {
              state: 'nonempty',
              identity: await readWorkspaceSyncRootObjectIdentity(canonicalRoot),
            },
          });
        }
        await ownership.bindCurrentRootIdentity();
        return {
          canonicalRoot,
          created: false,
          state: 'READY',
          rootFingerprint: restartReadyFact.rootFingerprint,
          policyDigest: input.policyDigest,
          ownershipHandles: [ownership],
          materializationCustody: interruptedCustody,
          readyPublished: true,
          publishReady: async () => await persistReadyFact(readyPath, restartReadyFact),
          release: ownership.release,
        };
      }
      await interruptedCustody.abort();
    }
    existingBeforeFence = await lstat(requested).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    });
    if (existingBeforeFence && (!existingBeforeFence.isDirectory() || existingBeforeFence.isSymbolicLink())) {
      throw bootstrapError('workspace_root_unsafe', 'workspace sync target root must be a real directory');
    }
    let targetFence: WorkspaceTargetMaterializationFence = { state: 'missing', identity: null,
      ...(input.workerCopyCreation ? { workerCopyCreation: input.workerCopyCreation } : {}) };
    if (existingBeforeFence || input.activatesExactMirror || input.targetReplacementApproval) {
      let approvalFingerprint = computeWorkspaceSyncAbsentRootFingerprint(canonicalRoot);
      if (existingBeforeFence) {
        const approvalCanonicalRoot = await realpath(requested);
        if (approvalCanonicalRoot !== canonicalRoot) {
          throw bootstrapError('root_changed', 'workspace sync target root changed before approval replay');
        }
        approvalFingerprint = await computeWorkspaceSyncRootFingerprint(canonicalRoot);
        targetFence = {
          state: (await readdir(canonicalRoot)).length === 0 ? 'empty' : 'nonempty',
          identity: await readWorkspaceSyncRootObjectIdentity(canonicalRoot),
          ...(input.workerCopyCreation ? { workerCopyCreation: input.workerCopyCreation } : {}),
        };
      }
      // The complete consequence set is derived here, from the target this
      // daemon actually observes, and compared exactly. A proof that is
      // missing, stale, stamped elsewhere, or carries a consequence the
      // current state does not require authorizes nothing and mutates nothing.
      const replacesNonEmptyTarget = targetFence.state === 'nonempty'
        && input.targetBootstrap === 'materialize_from_source_workspace';
      const requiredConsequences = [
        ...(replacesNonEmptyTarget ? ['replace_nonempty_workspace_target'] as const : []),
        ...(input.activatesExactMirror ? ['delete_target_only_files_during_exact_mirror'] as const : []),
      ];
      if (requiredConsequences.length > 0 || input.targetReplacementApproval) {
        await input.targetReplacementApprovalTarget?.assertCurrent();
        const approval = input.targetReplacementApproval;
        if (!approval
          || approval.canonicalRoot !== (input.targetReplacementApprovalTarget?.canonicalRoot ?? canonicalRoot)
          || approval.rootFingerprint !== approvalFingerprint
          || approval.consequences.length !== requiredConsequences.length
          || !requiredConsequences.every((consequence, index) => approval.consequences[index] === consequence)) {
          throw bootstrapError('approval_stale', 'Workspace target replacement approval is stale');
        }
      }
    }
    await mkdir(input.materializationDirectory, { recursive: true, mode: 0o700 });
    await rm(readyPath, { force: true });
    if (!existingBeforeFence && !input.createIfMissing) {
      throw bootstrapError('target_bootstrap_required', 'workspace sync target root does not exist');
    }
    if (!existingBeforeFence && input.createIfMissing) {
      // Preflight is read-only. Only the admitted bootstrap creates the missing
      // parent chain, under the same physical target fence as materialization.
      await mkdir(dirname(canonicalRoot), { recursive: true });
      if (await realpath(dirname(requested)) !== dirname(canonicalRoot)) {
        throw bootstrapError('root_changed', 'workspace sync target parent changed before materialization');
      }
    }
    if (existingBeforeFence) {
      const recoveredCanonicalRoot = await realpath(requested);
      if (getPathRemainderWithinBase(recoveredCanonicalRoot, canonicalRoot) !== ''
        || getPathRemainderWithinBase(canonicalRoot, recoveredCanonicalRoot) !== '') {
        throw bootstrapError('root_changed', 'workspace sync target root changed during recovery');
      }
    }
    let existing = existingBeforeFence;
    const materializerOwnsMissingTarget = existing === null
      && (contentSelection === 'git_worktree'
        || input.contentOnly && input.targetBootstrap === 'materialize_from_source_workspace');
    if (!existing && !materializerOwnsMissingTarget) {
      const createdTargetMaterialization = await beginWorkspaceTargetMaterialization({
        targetPath: canonicalRoot,
        backupDirectoryPrefix: '.happier-sync-backup',
        receiptPath,
        originalTargetExists: false,
        targetFence,
      });
      await mkdir(canonicalRoot);
      await createdTargetMaterialization.custody.bindPromotedTarget();
      materializationCustody = createdTargetMaterialization.custody;
      created = true;
      existing = await lstat(canonicalRoot);
    }
    if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) {
      throw bootstrapError('workspace_root_unsafe', 'workspace sync target root must be a real directory');
    }
    const targetState = existingBeforeFence === null
      ? 'missing'
      : (await readdir(canonicalRoot)).length === 0 ? 'empty' : 'nonempty';
    if (contentSelection === 'git_worktree') {
      const gitMaterializationCustody = await input.prepareGitTarget!({
        canonicalRoot,
        ...(canonicalSourceRoot === undefined ? {} : { sourceRootPath: canonicalSourceRoot }),
        relationshipId: input.relationshipId,
        endpointRole: input.endpointRole,
        policyDigest: input.policyDigest,
        targetState,
        targetBootstrap: input.targetBootstrap,
        materializationReceiptPath: receiptPath,
        targetFence,
      });
      if (gitMaterializationCustody) {
        materializationCustody = gitMaterializationCustody;
        copyOnceBaseline = gitMaterializationCustody.manifest;
        copyOnceExcludedPaths = gitMaterializationCustody.excludedPaths;
      }
      const preparedIdentity = await realpath(requested);
      if (getPathRemainderWithinBase(preparedIdentity, canonicalRoot) !== ''
        || getPathRemainderWithinBase(canonicalRoot, preparedIdentity) !== ''
        || !(await lstat(preparedIdentity)).isDirectory()) {
        throw bootstrapError('root_changed', 'workspace sync target root changed during SCM bootstrap');
      }
    } else if (targetState === 'nonempty' || input.contentOnly) {
      if (input.targetBootstrap === 'materialize_from_source_workspace') {
        if (!input.materializeSeed) {
          throw bootstrapError('target_bootstrap_seed_required', 'workspace sync target requires the selected source seed');
        }
        const seedMaterializationCustody = await input.materializeSeed({
          canonicalRoot,
          relationshipId: input.relationshipId,
          endpointRole: input.endpointRole,
          policyDigest: input.policyDigest,
          materializationReceiptPath: receiptPath,
          originalTargetExists: existingBeforeFence !== null,
          targetFence,
        });
        if (seedMaterializationCustody) {
          materializationCustody = seedMaterializationCustody;
          copyOnceBaseline = seedMaterializationCustody.manifest;
          copyOnceExcludedPaths = seedMaterializationCustody.excludedPaths;
        }
      }
      const seededIdentity = await realpath(requested);
      if (seededIdentity !== canonicalRoot || !(await lstat(seededIdentity)).isDirectory()) {
        throw bootstrapError('root_changed', 'workspace sync target root changed during seed materialization');
      }
    }
    const verifiedCanonicalRoot = await realpath(requested);
    if (getPathRemainderWithinBase(verifiedCanonicalRoot, canonicalRoot) !== ''
      || getPathRemainderWithinBase(canonicalRoot, verifiedCanonicalRoot) !== '') {
      throw bootstrapError('root_changed', 'workspace sync target root changed before bootstrap');
    }
    await ownership.bindCurrentRootIdentity();
    const fingerprint = await computeWorkspaceSyncRootFingerprint(canonicalRoot);
    const verifiedFingerprint = await computeWorkspaceSyncRootFingerprint(await realpath(requested));
    if (verifiedFingerprint !== fingerprint) throw bootstrapError('root_changed', 'workspace sync target root changed during bootstrap');
    const publishReady = async (): Promise<void> => await persistReadyFact(readyPath, {
      ...(input.nativeCopyOwner && copyOnceBaseline ? { v: 3 as const, kind: 'native_finite' as const,
        nativeCopyOwner: input.nativeCopyOwner, copyOnceBaseline: encodeWorkspaceSyncSeedBaseline(copyOnceBaseline) }
        : input.requesterCopyCustody ? { v: 2 as const, requesterCopyCustody: input.requesterCopyCustody } : { v: 1 as const }),
      relationshipId: input.relationshipId,
      endpointRole: input.endpointRole,
      targetWorkspaceRefId: input.targetWorkspaceRefId,
      canonicalRoot,
      rootFingerprint: fingerprint,
      policyDigest: input.policyDigest,
    });
    let materializationSettled = false;
    const unsettledMaterializationCustody = materializationCustody ?? null;
    const retainedMaterializationCustody = unsettledMaterializationCustody
      ? Object.freeze({
          receipt: unsettledMaterializationCustody.receipt,
          bindPromotedTarget: unsettledMaterializationCustody.bindPromotedTarget,
          commit: async () => {
            if (materializationSettled) return;
            await unsettledMaterializationCustody.commit();
            materializationSettled = true;
          },
          abort: async () => {
            if (materializationSettled) return;
            await unsettledMaterializationCustody.abort();
            materializationSettled = true;
          },
        })
      : undefined;
    return {
      canonicalRoot, created, state: 'READY', rootFingerprint: fingerprint, policyDigest: input.policyDigest,
      ownershipHandles: [ownership], publishReady, release: ownership.release,
      readyPublished: false,
      ...(copyOnceBaseline ? { copyOnceBaseline } : {}),
      ...(copyOnceExcludedPaths ? { copyOnceExcludedPaths } : {}),
      ...(retainedMaterializationCustody ? { materializationCustody: retainedMaterializationCustody } : {}),
    };
  } catch (error) {
    if (rejectedOriginalMaterialization) {
      // This receipt was never admitted to the current operation. Generic
      // rollback must not abort its original copy after refusing a relabel.
      await ownership.release();
      throw error;
    }
    if (trustedReadyRequiresCommitOnlyCleanup) {
      if (materializationCustody) await materializationCustody.commit().catch(() => undefined);
      await ownership.release();
      throw error;
    }
    let materializationAborted = materializationCustody === undefined;
    if (materializationCustody) {
      await materializationCustody.abort().then(
        () => { materializationAborted = true; },
        () => undefined,
      );
    }
    if (!materializationAborted) {
      // Keep the receipt for the next restart when the active custody could
      // not settle. Guessing here could discard the only rollback evidence.
    } else {
      await recoverInterruptedWorkspaceTargetMaterialization({
        targetPath: canonicalRoot,
        backupDirectoryPrefix: '.happier-sync-backup',
        receiptPath,
      }).catch(() => undefined);
    }
    await ownership.release();
    throw error;
  }
}

export const prepareWorkspaceSyncTargetBootstrap = workspaceSyncTargetBootstrap;
