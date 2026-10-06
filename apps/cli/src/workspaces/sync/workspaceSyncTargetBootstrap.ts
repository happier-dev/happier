import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { basename, dirname, join, normalize, resolve } from 'node:path';

import { getPathRemainderWithinBase } from '@/session/handoff/paths/sessionHandoffPathNormalization';
import { writeJsonAtomic } from '@/utils/fs/writeJsonAtomic';
import { inspectWorkspaceLocationWithScmWorkspace } from '@/scm/workspace/workspaceLocationInspection';
import { realizeWorkspaceCheckoutWithScmWorkspace } from '@/scm/workspace/workspaceCheckoutOperations';
import type { ScmWorkspaceIntegrationWorkspaceCheckoutRealizationResult } from '@/scm/workspace/workspaceCheckoutRealization';
import { normalizeSessionHandoffWorkspaceRootPath } from '@happier-dev/protocol/sessions/control/handoff/workspaceTransferSourcePathSafety';
import type { HandoffTargetReplacementApprovalV1 } from '@happier-dev/protocol';
import type { WorkspaceRootOwnershipHandle, WorkspaceRootOwnershipManager } from './workspaceSyncRootOwnership';
import {
  beginWorkspaceTargetMaterialization,
  recoverInterruptedWorkspaceTargetMaterialization,
  rehydrateWorkspaceTargetMaterializationFromReceiptPath,
  type WorkspaceExportMaterializationCustody,
  type WorkspaceTargetMaterializationFence,
} from '@/scm/workspace/workspaceExportMaterialization';
import {
  computeWorkspaceSyncAbsentRootFingerprint,
  computeWorkspaceSyncRootFingerprint,
  readWorkspaceSyncRootObjectIdentity,
} from './workspaceSyncRootIdentity';

export type WorkspaceSyncTargetBootstrapInput = Readonly<{
  rootPath: string;
  /** Present only when the source root is on this daemon and path-comparable. */
  sourceRootPath?: string;
  relationshipId: string;
  endpointRole: 'alpha' | 'beta';
  targetWorkspaceRefId: string;
  policyDigest: string;
  contentSelection: 'git_worktree' | 'all_files';
  /** Host-private Action approval, reinspected at this target under root custody. */
  targetReplacementApproval?: HandoffTargetReplacementApprovalV1;
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
  }>) => Promise<WorkspaceExportMaterializationCustody | void>;
  materializeSeed?: (input: Readonly<{
    canonicalRoot: string;
    relationshipId: string;
    endpointRole: 'alpha' | 'beta';
    policyDigest: string;
    materializationReceiptPath: string;
    originalTargetExists: boolean;
    targetFence: WorkspaceTargetMaterializationFence;
  }>) => Promise<WorkspaceExportMaterializationCustody | void>;
}>;

export type WorkspaceSyncTargetBootstrapResult = Readonly<{
  canonicalRoot: string;
  created: boolean;
  state: 'READY';
  rootFingerprint: string;
  policyDigest: string;
  ownershipHandles: readonly WorkspaceRootOwnershipHandle[];
  materializationCustody?: WorkspaceExportMaterializationCustody;
  /** True only when the exact durable READY fact was already observed or published. */
  readyPublished: boolean;
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

function materializationReceiptPath(materializationDirectory: string, relationshipId: string, endpointRole: 'alpha' | 'beta') {
  return join(resolve(materializationDirectory), `${bootstrapOperationKey(relationshipId, endpointRole)}.json`);
}

function finalReadyPath(materializationDirectory: string, relationshipId: string, endpointRole: 'alpha' | 'beta'): string {
  return join(resolve(materializationDirectory), `${bootstrapOperationKey(relationshipId, endpointRole)}.ready.json`);
}

export type WorkspaceSyncFinalReadyFact = Readonly<{
  v: 1;
  relationshipId: string;
  endpointRole: 'alpha' | 'beta';
  targetWorkspaceRefId: string;
  canonicalRoot: string;
  rootFingerprint: string;
  policyDigest: string;
  completedAtMs: number;
}>;

export type WorkspaceSyncTargetBootstrapDependencies = Readonly<{
  writeReadyFact?(path: string, fact: Omit<WorkspaceSyncFinalReadyFact, 'completedAtMs'>): Promise<void>;
  rehydrateMaterializationFromReceiptPath?: typeof rehydrateWorkspaceTargetMaterializationFromReceiptPath;
}>;

function isExactReadyFact(value: unknown, expected: Omit<WorkspaceSyncFinalReadyFact, 'completedAtMs'>): value is WorkspaceSyncFinalReadyFact {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expectedKeys = ['canonicalRoot', 'completedAtMs', 'endpointRole', 'policyDigest', 'relationshipId', 'rootFingerprint', 'targetWorkspaceRefId', 'v'];
  return keys.length === expectedKeys.length
    && keys.every((key, index) => key === expectedKeys[index])
    && record.v === expected.v
    && record.relationshipId === expected.relationshipId
    && record.endpointRole === expected.endpointRole
    && record.targetWorkspaceRefId === expected.targetWorkspaceRefId
    && record.canonicalRoot === expected.canonicalRoot
    && record.rootFingerprint === expected.rootFingerprint
    && record.policyDigest === expected.policyDigest
    && typeof record.completedAtMs === 'number'
    && Number.isFinite(record.completedAtMs);
}

async function writeReadyFact(path: string, fact: Omit<WorkspaceSyncFinalReadyFact, 'completedAtMs'>): Promise<void> {
  await writeJsonAtomic(path, { ...fact, completedAtMs: Date.now() });
}

async function hasExactReadyFact(path: string, expected: Omit<WorkspaceSyncFinalReadyFact, 'completedAtMs'>): Promise<boolean> {
  const raw = await readFile(path, 'utf8').catch(() => null);
  if (raw === null) return false;
  try {
    return isExactReadyFact(JSON.parse(raw) as unknown, expected);
  } catch {
    return false;
  }
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
    await targetMaterialization.custody.abort();
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
  materializationDirectory: string;
  rootOwnershipManager: WorkspaceRootOwnershipManager;
  /** Restart cleanup probe: do nothing unless the finite receipt exists. */
  requireMaterializationReceipt?: boolean;
  prepareGitTarget?: WorkspaceSyncTargetBootstrapInput['prepareGitTarget'];
}>, dependencies: Pick<WorkspaceSyncTargetBootstrapDependencies, 'rehydrateMaterializationFromReceiptPath'> = {}): Promise<WorkspaceSyncTargetBootstrapResult | null> {
  const receiptPath = materializationReceiptPath(input.materializationDirectory, input.relationshipId, input.endpointRole);
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
    : await realpath(dirname(requested)).then((parent) => normalize(join(parent, basename(requested)))).catch(() => null);
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
    exactReady = readyFact !== null && await hasExactReadyFact(readyPath, readyFact);
    if (materializationCustody && !exactReady) {
      await materializationCustody.abort();
      materializationSettled = true;
      await ownership.release();
      return null;
    }
    if (!exactReady || readyFact === null) {
      if (currentRoot === null && !materializationCustody) {
        throw bootstrapError('root_changed', 'Workspace sync target root is unavailable');
      }
      await ownership.release();
      return null;
    }
    if (input.contentSelection === 'git_worktree') {
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
      publishReady: async (): Promise<void> => await writeReadyFact(readyPath, readyFact),
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
  const receiptPath = materializationReceiptPath(input.materializationDirectory, input.relationshipId, input.endpointRole);
  const readyPath = finalReadyPath(input.materializationDirectory, input.relationshipId, input.endpointRole);
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
    : await realpath(dirname(requested)).then((parent) => normalize(join(parent, basename(requested)))).catch(() => null);
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
  if (input.contentSelection === 'git_worktree' && !input.prepareGitTarget) {
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
  let trustedReadyRequiresCommitOnlyCleanup = false;
  try {
    const interruptedCustody = await (dependencies.rehydrateMaterializationFromReceiptPath
      ?? rehydrateWorkspaceTargetMaterializationFromReceiptPath)({
      targetPath: requested,
      backupDirectoryPrefix: '.happier-sync-backup',
      receiptPath,
    }).catch((error: unknown) => {
      throw bootstrapError('target_bootstrap_required', `Workspace sync target recovery failed: ${(error as Error).message}`);
    });
    if (interruptedCustody) {
      const restartRoot = await realpath(requested).catch(() => null);
      const restartFingerprint = restartRoot
        ? await computeWorkspaceSyncRootFingerprint(restartRoot).catch(() => null)
        : null;
      const restartReadyFact = restartRoot === canonicalRoot && restartFingerprint !== null
        ? {
          v: 1,
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
        if (input.contentSelection === 'git_worktree') {
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
    let targetFence: WorkspaceTargetMaterializationFence = { state: 'missing', identity: null };
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
        const approval = input.targetReplacementApproval;
        if (!approval
          || approval.canonicalRoot !== canonicalRoot
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
    if (existingBeforeFence) {
      const recoveredCanonicalRoot = await realpath(requested);
      if (getPathRemainderWithinBase(recoveredCanonicalRoot, canonicalRoot) !== ''
        || getPathRemainderWithinBase(canonicalRoot, recoveredCanonicalRoot) !== '') {
        throw bootstrapError('root_changed', 'workspace sync target root changed during recovery');
      }
    }
    let existing = existingBeforeFence;
    const gitOwnsMissingTargetMaterialization = existing === null
      && input.contentSelection === 'git_worktree';
    if (!existing && !gitOwnsMissingTargetMaterialization) {
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
    if (input.contentSelection === 'git_worktree') {
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
      if (gitMaterializationCustody) materializationCustody = gitMaterializationCustody;
      const preparedIdentity = await realpath(requested);
      if (getPathRemainderWithinBase(preparedIdentity, canonicalRoot) !== ''
        || getPathRemainderWithinBase(canonicalRoot, preparedIdentity) !== ''
        || !(await lstat(preparedIdentity)).isDirectory()) {
        throw bootstrapError('root_changed', 'workspace sync target root changed during SCM bootstrap');
      }
    } else if (targetState === 'nonempty') {
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
        if (seedMaterializationCustody) materializationCustody = seedMaterializationCustody;
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
      v: 1,
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
      ...(retainedMaterializationCustody ? { materializationCustody: retainedMaterializationCustody } : {}),
    };
  } catch (error) {
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
