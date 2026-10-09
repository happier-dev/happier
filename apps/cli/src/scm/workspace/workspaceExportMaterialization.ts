import { randomUUID } from 'node:crypto';
import { access, readFile, readdir, realpath, rename, rm, rmdir } from 'node:fs/promises';
import { basename, dirname, join, parse, resolve } from 'node:path';

import type { ScmBackendRegistry } from '../registry';
import { writeJsonAtomic } from '@/utils/fs/writeJsonAtomic';
import { runWithScmBackendRegistryLease } from '../scmBackendCatalog';
import { cleanupWorkspaceStaging } from './workspaceExportStaging/cleanupWorkspaceStaging';
import {
    createWorkspaceStagingRoot,
    type WorkspaceStagingRoot,
} from './workspaceExportStaging/createWorkspaceStagingRoot';
import { promoteStagedWorkspace } from './workspaceExportStaging/promoteStagedWorkspace';
import {
    stageWorkspaceEntries,
    type WorkspaceExportBlobProvider,
} from './workspaceExportStaging/stageWorkspaceEntries';
import {
    assertWorkspaceMaterializationSymlinkTarget,
    resolveContainedWorkspaceMaterializationPath,
} from './workspaceMaterializationSafety';
import { resolveWorkspaceMaterializationTargetPath } from './workspaceMaterializationTargetPath';
import { measureWorkspaceSyncRegularFileBytesAtRoot } from '@/workspaces/sync/workspaceSyncFileRead';

import {
    assertPortableWorkspaceEntriesWithScmWorkspace,
    reconcilePostMaterializationWithScmWorkspace,
} from '../workspace';
import type { ScmWorkspaceIntegrationWorkspaceExportArtifacts } from './workspaceExportArtifacts';
import type { ScmWorkspaceIntegrationWorkspaceTransferConflictPolicy } from './workspaceTransfer';
import {
    isWorkspaceSyncRootObjectIdentityV1,
    readWorkspaceSyncRootObjectIdentity,
    workspaceSyncRootObjectIdentitiesEqual,
    computeWorkspaceSyncRootFingerprint,
    type WorkspaceSyncRootObjectIdentityV1,
} from '@/workspaces/sync/workspaceSyncRootIdentity';

export type WorkspaceExportMaterializationNaming = Readonly<{
    siblingCopySuffixBase: string;
    backupDirectoryPrefix: string;
    stagingIdPrefix: string;
}>;

export type WorkspaceTargetMaterializationWorkerCopyCreation = Readonly<{
    serverId: string;
    relationshipId: string;
    sourceWorkspaceRefId: string;
    targetWorkspaceRefId: string;
}>;

export type WorkspaceTargetMaterializationReceiptV1 = Readonly<{
    v: 1;
    previousTargetName: string | null;
    originalTargetIdentity: WorkspaceSyncRootObjectIdentityV1 | null;
    promotedTargetIdentity: WorkspaceSyncRootObjectIdentityV1 | null;
    expectedBackupIdentity: WorkspaceSyncRootObjectIdentityV1 | null;
    /** Initial target-custodian creation evidence, never enriched by retirement or recovery. */
    workerCopyCreation?: WorkspaceTargetMaterializationWorkerCopyCreation;
    /** Settled promotion custody; rollback must never delete this copy. */
    committed?: Readonly<{ canonicalRoot: string; rootFingerprint: string }>;
    /** Explicit removal began; retain the exact moved name for inspection, never blind replay. */
    removalTargetName?: string;
}>;

export type WorkspaceExportMaterializationCustody = Readonly<{
    receipt: WorkspaceTargetMaterializationReceiptV1;
    bindPromotedTarget(): Promise<void>;
    commit(): Promise<void>;
    abort(): Promise<void>;
}>;

export type WorkspaceExportMaterializationResult = Readonly<{
    targetPath: string;
    custody: WorkspaceExportMaterializationCustody;
}>;

/** Bootstrap-admitted target object and consequence state, replayed at the destructive leaf. */
export type WorkspaceTargetMaterializationFence = Readonly<{
    state: 'missing' | 'empty' | 'nonempty';
    identity: WorkspaceSyncRootObjectIdentityV1 | null;
    /** Derived from the original current Home relationship by the physical target custodian. */
    workerCopyCreation?: WorkspaceTargetMaterializationWorkerCopyCreation;
}>;

async function readMaterializationReceipt(path: string): Promise<WorkspaceTargetMaterializationReceiptV1 | null> {
    const raw = await readFile(path, 'utf8').catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
    });
    if (raw === null) return null;
    try {
        const value = JSON.parse(raw) as unknown;
        if (!value || typeof value !== 'object' || Array.isArray(value)
            || Object.keys(value).filter((key) => key !== 'committed' && key !== 'removalTargetName' && key !== 'workerCopyCreation').sort().join('\0') !== [
                'expectedBackupIdentity',
                'originalTargetIdentity',
                'previousTargetName',
                'promotedTargetIdentity',
                'v',
            ].sort().join('\0')) {
            throw new Error('invalid receipt');
        }
        const candidate = value as Record<string, unknown>;
        if (candidate.v !== 1
            || !(candidate.previousTargetName === null || typeof candidate.previousTargetName === 'string')
            || !(candidate.originalTargetIdentity === null
                || isWorkspaceSyncRootObjectIdentityV1(candidate.originalTargetIdentity))
            || !(candidate.promotedTargetIdentity === null
                || isWorkspaceSyncRootObjectIdentityV1(candidate.promotedTargetIdentity))
            || !isCommittedTarget(candidate.committed) || !isRemovalTargetName(candidate.removalTargetName)
            || !isWorkerCopyCreation(candidate.workerCopyCreation)
            || !(candidate.expectedBackupIdentity === null
                || isWorkspaceSyncRootObjectIdentityV1(candidate.expectedBackupIdentity))) {
            throw new Error('invalid receipt');
        }
        return candidate as WorkspaceTargetMaterializationReceiptV1;
    } catch {
        throw materializationRecoveryError('Invalid or unsupported workspace target materialization receipt');
    }
}

function materializationRecoveryError(message: string): Error {
    return Object.assign(new Error(message), { code: 'workspace_target_materialization_manual_recovery' });
}

function isWorkerCopyCreation(value: unknown): boolean {
    if (value === undefined) return true;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const candidate = value as Record<string, unknown>;
    const fields = ['relationshipId', 'serverId', 'sourceWorkspaceRefId', 'targetWorkspaceRefId'];
    return Object.keys(candidate).sort().join('\0') === fields.join('\0')
        && fields.every(key => {
            const field = candidate[key];
            return typeof field === 'string' && field !== '' && field === field.trim();
        })
        && candidate.sourceWorkspaceRefId !== candidate.targetWorkspaceRefId;
}

function workerCopyCreationsEqual(
    left: WorkspaceTargetMaterializationWorkerCopyCreation | undefined,
    right: WorkspaceTargetMaterializationWorkerCopyCreation,
): boolean {
    return left !== undefined && left.serverId === right.serverId && left.relationshipId === right.relationshipId
        && left.sourceWorkspaceRefId === right.sourceWorkspaceRefId && left.targetWorkspaceRefId === right.targetWorkspaceRefId;
}

function workerCopyCreationError(): Error {
    return Object.assign(new Error('Workspace target has no matching original worker-copy creation evidence'), { code: 'workspace_copy_not_worker' });
}

/** Recovery and retirement share the original physical receipt's creation proof. */
export function assertWorkspaceTargetMaterializationWorkerCopyCreation(
    receipt: WorkspaceTargetMaterializationReceiptV1,
    expected: WorkspaceTargetMaterializationWorkerCopyCreation,
): void {
    if (!workerCopyCreationsEqual(receipt.workerCopyCreation, expected)) throw workerCopyCreationError();
}

function isCommittedTarget(value: unknown): boolean {
    if (value === undefined) return true;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const candidate = value as Record<string, unknown>;
    return Object.keys(candidate).sort().join('\0') === ['canonicalRoot', 'rootFingerprint'].join('\0')
        && typeof candidate.canonicalRoot === 'string' && candidate.canonicalRoot === resolve(candidate.canonicalRoot)
        && typeof candidate.rootFingerprint === 'string' && /^[a-f0-9]{64}$/u.test(candidate.rootFingerprint);
}

function isRemovalTargetName(value: unknown): boolean {
    return value === undefined || (typeof value === 'string'
        && /^\.happier-sync-backup\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value));
}

async function committedReceipt(targetPath: string, receipt: WorkspaceTargetMaterializationReceiptV1): Promise<WorkspaceTargetMaterializationReceiptV1> {
    const canonicalRoot = await realpath(targetPath);
    return Object.freeze({ ...receipt, committed: {
        canonicalRoot,
        rootFingerprint: await computeWorkspaceSyncRootFingerprint(canonicalRoot),
    } });
}

async function readObjectIdentityOrAbsent(path: string): Promise<WorkspaceSyncRootObjectIdentityV1 | null> {
    try {
        return await readWorkspaceSyncRootObjectIdentity(path);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw materializationRecoveryError(`Cannot prove filesystem identity for ${path}`);
    }
}

async function assertObjectIdentity(
    path: string,
    expected: WorkspaceSyncRootObjectIdentityV1,
): Promise<void> {
    const actual = await readObjectIdentityOrAbsent(path);
    if (!actual || !workspaceSyncRootObjectIdentitiesEqual(actual, expected)) {
        throw materializationRecoveryError(`Filesystem object changed at ${path}`);
    }
}

async function assertTargetMaterializationFence(
    targetPath: string,
    fence: WorkspaceTargetMaterializationFence,
): Promise<void> {
    const actualIdentity = await readObjectIdentityOrAbsent(targetPath);
    const identityMatches = fence.identity === null
        ? actualIdentity === null
        : actualIdentity !== null && workspaceSyncRootObjectIdentitiesEqual(actualIdentity, fence.identity);
    if (!identityMatches) {
        throw Object.assign(new Error('Workspace target replacement approval is stale'), { code: 'approval_stale' });
    }
    const actualState = actualIdentity === null
        ? 'missing'
        : (await readdir(targetPath)).length === 0 ? 'empty' : 'nonempty';
    if (actualState !== fence.state) {
        throw Object.assign(new Error('Workspace target replacement approval is stale'), { code: 'approval_stale' });
    }
}

export async function prepareWorkspaceTargetMaterializationReceipt(input: Readonly<{
    targetPath: string;
    backupDirectoryPrefix: string;
    receiptPath: string;
    originalTargetExists: boolean;
    workerCopyCreation?: WorkspaceTargetMaterializationWorkerCopyCreation;
}>): Promise<WorkspaceTargetMaterializationReceiptV1> {
    if (!isWorkerCopyCreation(input.workerCopyCreation)) throw workerCopyCreationError();
    const existing = await readMaterializationReceipt(input.receiptPath);
    if (existing) {
        if (existing.committed) throw materializationRecoveryError('Workspace target already has committed materialization custody');
        if (input.workerCopyCreation) assertWorkspaceTargetMaterializationWorkerCopyCreation(existing, input.workerCopyCreation);
        if ((existing.previousTargetName !== null) !== input.originalTargetExists) {
            throw materializationRecoveryError('Workspace target materialization receipt does not match the observed target state');
        }
        return existing;
    }
    const originalTargetIdentity = await readObjectIdentityOrAbsent(input.targetPath);
    if (input.originalTargetExists && originalTargetIdentity === null) {
        throw materializationRecoveryError('Workspace target disappeared before materialization custody was recorded');
    }
    const previousTargetPath = input.originalTargetExists
        ? join(dirname(input.targetPath), `${input.backupDirectoryPrefix}.${randomUUID()}`)
        : undefined;
    const receipt: WorkspaceTargetMaterializationReceiptV1 = Object.freeze({
        v: 1,
        previousTargetName: previousTargetPath ? basename(previousTargetPath) : null,
        originalTargetIdentity,
        promotedTargetIdentity: null,
        expectedBackupIdentity: previousTargetPath ? originalTargetIdentity : null,
        ...(input.workerCopyCreation ? { workerCopyCreation: Object.freeze({ ...input.workerCopyCreation }) } : {}),
    });
    await writeJsonAtomic(input.receiptPath, receipt);
    return receipt;
}

async function pathExists(path: string): Promise<boolean> {
    return await access(path).then(() => true, () => false);
}

async function resolveWorkspaceExportMaterializationTargetPath(params: Readonly<{
    targetPath: string;
    conflictPolicy: ScmWorkspaceIntegrationWorkspaceTransferConflictPolicy;
    naming: WorkspaceExportMaterializationNaming;
}>): Promise<string> {
    return await resolveWorkspaceMaterializationTargetPath(params);
}

export async function beginWorkspaceTargetMaterialization(input: Readonly<{
    targetPath: string;
    backupDirectoryPrefix: string;
    /**
     * Bootstrap-owned durable receipt. When supplied, it is written before
     * the first destructive filesystem mutation and removed only on custody
     * settlement.
     */
    receiptPath?: string;
    /** The target state observed by the bootstrap owner before it created an empty root. */
    originalTargetExists?: boolean;
    /** Exact root object and empty/non-empty consequence admitted by the bootstrap owner. */
    targetFence?: WorkspaceTargetMaterializationFence;
}>, dependencies: Readonly<{
    /** Filesystem rename boundary injection used to prove the final empty-target race. */
    replaceTarget?: typeof rename;
}> = {}): Promise<Readonly<{
    previousTargetPath?: string;
    custody: WorkspaceExportMaterializationCustody;
}>> {
    if (!isWorkerCopyCreation(input.targetFence?.workerCopyCreation)) throw workerCopyCreationError();
    const targetExists = await pathExists(input.targetPath);
    if (input.targetFence) await assertTargetMaterializationFence(input.targetPath, input.targetFence);
    const originalTargetExists = input.originalTargetExists ?? targetExists;
    let receipt = input.receiptPath
        ? await prepareWorkspaceTargetMaterializationReceipt({
            targetPath: input.targetPath,
            backupDirectoryPrefix: input.backupDirectoryPrefix,
            receiptPath: input.receiptPath,
            originalTargetExists,
            ...(input.targetFence?.workerCopyCreation ? { workerCopyCreation: Object.freeze({ ...input.targetFence.workerCopyCreation }) } : {}),
        })
        : Object.freeze({
            v: 1 as const,
            previousTargetName: originalTargetExists
                ? basename(join(dirname(input.targetPath), `${input.backupDirectoryPrefix}.${randomUUID()}`))
                : null,
            originalTargetIdentity: await readObjectIdentityOrAbsent(input.targetPath),
            promotedTargetIdentity: null,
            expectedBackupIdentity: null,
            ...(input.targetFence?.workerCopyCreation ? { workerCopyCreation: Object.freeze({ ...input.targetFence.workerCopyCreation }) } : {}),
        });
    if (receipt.previousTargetName !== null && receipt.expectedBackupIdentity === null) {
        receipt = Object.freeze({ ...receipt, expectedBackupIdentity: receipt.originalTargetIdentity });
    }
    const previousTargetPath = receipt.previousTargetName === null
        ? undefined
        : join(dirname(input.targetPath), receipt.previousTargetName);
    if (input.targetFence) await assertTargetMaterializationFence(input.targetPath, input.targetFence);
    if (previousTargetPath) {
        if (!receipt.originalTargetIdentity || !receipt.expectedBackupIdentity) {
            throw materializationRecoveryError('Original target identity is unavailable');
        }
        await assertObjectIdentity(input.targetPath, receipt.originalTargetIdentity);
        await (dependencies.replaceTarget ?? rename)(input.targetPath, previousTargetPath);
        await assertObjectIdentity(previousTargetPath, receipt.expectedBackupIdentity);
        if (input.targetFence?.state === 'empty' && (await readdir(previousTargetPath)).length > 0) {
            await rename(previousTargetPath, input.targetPath);
            if (input.receiptPath) await rm(input.receiptPath, { force: true });
            throw Object.assign(new Error('Workspace target replacement approval is stale'), { code: 'approval_stale' });
        }
    } else if (targetExists) {
        // Bootstrap may have created an empty root in order to acquire and
        // fingerprint it. It was still absent at the operation boundary.
        if (!receipt.originalTargetIdentity) {
            throw materializationRecoveryError('Prepared target identity is unavailable');
        }
        await assertObjectIdentity(input.targetPath, receipt.originalTargetIdentity);
        await rm(input.targetPath, { recursive: true, force: true });
    }

    let settled = false;
    const custody: WorkspaceExportMaterializationCustody = Object.freeze({
        get receipt() {
            return receipt;
        },
        bindPromotedTarget: async () => {
            if (settled) return;
            const promotedTargetIdentity = await readObjectIdentityOrAbsent(input.targetPath);
            if (!promotedTargetIdentity) {
                throw materializationRecoveryError('Promoted target identity is unavailable');
            }
            receipt = Object.freeze({ ...receipt, promotedTargetIdentity });
            if (input.receiptPath) await writeJsonAtomic(input.receiptPath, receipt);
        },
        commit: async () => {
            if (settled) return;
            if (!receipt.promotedTargetIdentity) {
                throw materializationRecoveryError('Promoted target identity was not bound');
            }
            await assertObjectIdentity(input.targetPath, receipt.promotedTargetIdentity);
            if (previousTargetPath) {
                if (!receipt.expectedBackupIdentity) {
                    throw materializationRecoveryError('Backup identity is unavailable');
                }
                await assertObjectIdentity(previousTargetPath, receipt.expectedBackupIdentity);
                if (input.targetFence?.state === 'empty') {
                    await rmdir(previousTargetPath).catch((error: unknown) => {
                        if ((error as NodeJS.ErrnoException).code === 'ENOTEMPTY') {
                            throw Object.assign(new Error('Workspace target replacement approval is stale'), { code: 'approval_stale' });
                        }
                        throw error;
                    });
                } else {
                    await rm(previousTargetPath, { recursive: true, force: true });
                }
            }
            receipt = await committedReceipt(input.targetPath, receipt);
            if (input.receiptPath) await writeJsonAtomic(input.receiptPath, receipt);
            settled = true;
        },
        abort: async () => {
            if (settled) return;
            if (!receipt.promotedTargetIdentity) {
                throw materializationRecoveryError('Promoted target identity was not bound');
            }
            await assertObjectIdentity(input.targetPath, receipt.promotedTargetIdentity);
            if (previousTargetPath) {
                if (!receipt.expectedBackupIdentity) {
                    throw materializationRecoveryError('Backup identity is unavailable');
                }
                await assertObjectIdentity(previousTargetPath, receipt.expectedBackupIdentity);
            }
            await rm(input.targetPath, { recursive: true, force: true });
            if (previousTargetPath) {
                await rename(previousTargetPath, input.targetPath);
            }
            if (input.receiptPath) await rm(input.receiptPath, { force: true });
            settled = true;
        },
    });
    return {
        ...(previousTargetPath ? { previousTargetPath } : {}),
        custody,
    };
}

/** Rebuilds the narrow rollback closure from a root-bound durable receipt. */
export async function rehydrateWorkspaceTargetMaterialization(input: Readonly<{
    targetPath: string;
    backupDirectoryPrefix: string;
    receipt: WorkspaceTargetMaterializationReceiptV1;
    receiptPath?: string;
}>): Promise<WorkspaceExportMaterializationCustody | null> {
    const receipt = input.receipt as unknown;
    if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)
        || Object.keys(receipt).filter((key) => key !== 'committed' && key !== 'removalTargetName' && key !== 'workerCopyCreation').sort().join('\0') !== [
            'expectedBackupIdentity',
            'originalTargetIdentity',
            'previousTargetName',
            'promotedTargetIdentity',
            'v',
        ].sort().join('\0')) {
        throw materializationRecoveryError('Unsupported partial workspace target materialization receipt');
    }
    const candidate = receipt as Record<string, unknown>;
    if (candidate.v !== 1 || !isCommittedTarget(candidate.committed) || !isRemovalTargetName(candidate.removalTargetName)
        || !isWorkerCopyCreation(candidate.workerCopyCreation)
        || !(candidate.previousTargetName === null || typeof candidate.previousTargetName === 'string')
        || !(candidate.originalTargetIdentity === null || isWorkspaceSyncRootObjectIdentityV1(candidate.originalTargetIdentity))
        || !(candidate.promotedTargetIdentity === null || isWorkspaceSyncRootObjectIdentityV1(candidate.promotedTargetIdentity))
        || !(candidate.expectedBackupIdentity === null || isWorkspaceSyncRootObjectIdentityV1(candidate.expectedBackupIdentity))) {
        throw materializationRecoveryError('Invalid workspace target materialization receipt identity');
    }
    const validatedReceipt = candidate as WorkspaceTargetMaterializationReceiptV1;
    const targetPath = resolve(input.targetPath);
    if (validatedReceipt.committed) {
        await inspectCommittedWorkspaceTargetMaterialization({
            targetPath, receipt: validatedReceipt,
            rootFingerprint: validatedReceipt.committed.rootFingerprint,
        });
        return null;
    }
    const expectedPrefix = `${input.backupDirectoryPrefix}.`;
    const previousTargetName = validatedReceipt.previousTargetName;
    if (previousTargetName !== null && (
        basename(previousTargetName) !== previousTargetName
        || !previousTargetName.startsWith(expectedPrefix)
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
            .test(previousTargetName.slice(expectedPrefix.length))
    )) {
        throw materializationRecoveryError('Invalid workspace target materialization receipt');
    }
    const previousTargetPath = previousTargetName === null
        ? undefined
        : join(dirname(targetPath), previousTargetName);
    const targetIdentity = await readObjectIdentityOrAbsent(targetPath);
    const backupIdentity = previousTargetPath ? await readObjectIdentityOrAbsent(previousTargetPath) : null;
    const targetIsOriginal = targetIdentity !== null
        && validatedReceipt.originalTargetIdentity !== null
        && workspaceSyncRootObjectIdentitiesEqual(targetIdentity, validatedReceipt.originalTargetIdentity);
    const targetIsPromoted = targetIdentity !== null
        && validatedReceipt.promotedTargetIdentity !== null
        && workspaceSyncRootObjectIdentitiesEqual(targetIdentity, validatedReceipt.promotedTargetIdentity);
    const backupMatches = backupIdentity !== null
        && validatedReceipt.expectedBackupIdentity !== null
        && workspaceSyncRootObjectIdentitiesEqual(backupIdentity, validatedReceipt.expectedBackupIdentity);

    if (backupIdentity && !backupMatches) {
        throw materializationRecoveryError('Expected backup pathname is occupied by another filesystem object');
    }
    if (targetIdentity && !targetIsOriginal && !targetIsPromoted) {
        throw materializationRecoveryError('Target pathname is occupied by another filesystem object');
    }
    // Once the verified backup object is absent, the destructive commit
    // boundary has already crossed. Recovery never deletes the target in this
    // state; retain promotion evidence for separately reviewed removal.
    if (previousTargetPath && !backupIdentity && (targetIsOriginal || targetIsPromoted)) {
        if (input.receiptPath) {
            if (targetIsPromoted) await writeJsonAtomic(input.receiptPath, await committedReceipt(targetPath, validatedReceipt));
            else await rm(input.receiptPath, { force: true });
        }
        return null;
    }

    if (!previousTargetPath && !targetIdentity) {
        if (input.receiptPath) await rm(input.receiptPath, { force: true });
        return null;
    }
    if (validatedReceipt.promotedTargetIdentity === null && targetIdentity !== null && !targetIsOriginal) {
        throw materializationRecoveryError('Interrupted materialization has an unbound target object');
    }

    let settled = false;
    return Object.freeze({
        receipt: validatedReceipt,
        bindPromotedTarget: async () => {
            throw materializationRecoveryError('Rehydrated materialization cannot bind a new promoted target');
        },
        commit: async () => {
            if (settled) return;
            if (!validatedReceipt.promotedTargetIdentity) {
                throw materializationRecoveryError('Promoted target identity was not durably bound');
            }
            await assertObjectIdentity(targetPath, validatedReceipt.promotedTargetIdentity);
            if (previousTargetPath) {
                if (!validatedReceipt.expectedBackupIdentity) {
                    throw materializationRecoveryError('Backup identity is unavailable');
                }
                await assertObjectIdentity(previousTargetPath, validatedReceipt.expectedBackupIdentity);
                await rm(previousTargetPath, { recursive: true, force: true });
            }
            if (input.receiptPath) await writeJsonAtomic(input.receiptPath, await committedReceipt(targetPath, validatedReceipt));
            settled = true;
        },
        abort: async () => {
            if (settled) return;
            const currentTargetIdentity = await readObjectIdentityOrAbsent(targetPath);
            if (currentTargetIdentity) {
                const expectedTargetIdentity = validatedReceipt.promotedTargetIdentity ?? validatedReceipt.originalTargetIdentity;
                if (!expectedTargetIdentity
                    || !workspaceSyncRootObjectIdentitiesEqual(currentTargetIdentity, expectedTargetIdentity)) {
                    throw materializationRecoveryError('Target pathname is occupied by another filesystem object');
                }
            }
            if (previousTargetPath) {
                if (!validatedReceipt.expectedBackupIdentity) {
                    throw materializationRecoveryError('Backup identity is unavailable');
                }
                await assertObjectIdentity(previousTargetPath, validatedReceipt.expectedBackupIdentity);
            }
            if (currentTargetIdentity) {
                await rm(targetPath, { recursive: true, force: true });
            }
            if (previousTargetPath) {
                await rename(previousTargetPath, targetPath);
            }
            if (input.receiptPath) await rm(input.receiptPath, { force: true });
            settled = true;
        },
    });
}

/** Sole committed-copy evidence comes from this materialization owner's settled promotion. */
export async function inspectCommittedWorkspaceTargetMaterialization(input: Readonly<{
    targetPath: string;
    /** Omitted only for passive discovery; the physical root still must match committed custody. */
    rootFingerprint?: string;
    /** Display-only observed bytes, never stored in committed custody. */
    measureSize?: true;
    /** Worker retirement must match original physical creation, not only its reviewed input. */
    workerCopyCreation?: WorkspaceTargetMaterializationWorkerCopyCreation;
}> & ({ receiptPath: string; receipt?: never } | { receipt: WorkspaceTargetMaterializationReceiptV1; receiptPath?: never })): Promise<WorkspaceTargetMaterializationReceiptV1 & Readonly<{
    committed: NonNullable<WorkspaceTargetMaterializationReceiptV1['committed']>;
    sizeBytes?: number;
}>> {
    const receipt = input.receipt ?? await readMaterializationReceipt(input.receiptPath);
    if (!receipt?.committed || !receipt.promotedTargetIdentity) {
        throw Object.assign(new Error('Workspace target has no committed owned-copy evidence'), { code: 'workspace_copy_not_owned' });
    }
    if (input.workerCopyCreation) assertWorkspaceTargetMaterializationWorkerCopyCreation(receipt, input.workerCopyCreation);
    const targetPath = resolve(input.targetPath);
    if (receipt.removalTargetName) {
        throw Object.assign(new Error('Workspace copy removal requires inspection'), {
            code: 'workspace_copy_removal_unknown',
            targetPath: receipt.committed.canonicalRoot,
            removalPath: join(dirname(receipt.committed.canonicalRoot), receipt.removalTargetName),
        });
    }
    if (targetPath === parse(targetPath).root) throw materializationRecoveryError('Workspace copy root is unsafe');
    await assertObjectIdentity(targetPath, receipt.promotedTargetIdentity);
    const canonicalRoot = await realpath(targetPath);
    if (canonicalRoot !== receipt.committed.canonicalRoot
        || (input.rootFingerprint !== undefined && input.rootFingerprint !== receipt.committed.rootFingerprint)
        || await computeWorkspaceSyncRootFingerprint(canonicalRoot) !== receipt.committed.rootFingerprint) {
        throw Object.assign(new Error('Workspace copy removal approval is stale'), { code: 'root_changed' });
    }
    if (!input.measureSize) return { ...receipt, committed: receipt.committed };
    const { measureSize: _measureSize, ...identityInput } = input;
    const committedRootFingerprint = receipt.committed.rootFingerprint;
    const inspectCurrent = async () => await inspectCommittedWorkspaceTargetMaterialization({
        ...identityInput, rootFingerprint: committedRootFingerprint,
    });
    let sizeBytes: number | undefined;
    try {
        sizeBytes = await measureWorkspaceSyncRegularFileBytesAtRoot({
            rootPath: dirname(canonicalRoot), relativePath: basename(canonicalRoot),
            expectedRootIdentity: receipt.promotedTargetIdentity,
            assertCurrentAuthority: async () => { await inspectCurrent(); },
        });
    } catch {
        // Incomplete or unsupported observations are unknown, not a fabricated zero.
    }
    const current = await inspectCurrent();
    return { ...current, ...(sizeBytes === undefined ? {} : { sizeBytes }) };
}

/** Explicit reviewed removal is distinct from ownership release and pre-commit rollback. */
export async function removeCommittedWorkspaceTargetMaterialization(input: Readonly<{
    targetPath: string;
    receiptPath: string;
    rootFingerprint: string;
    signal?: AbortSignal;
    workerCopyCreation?: WorkspaceTargetMaterializationWorkerCopyCreation;
}>, dependencies: Readonly<{ removeTarget?: typeof rm }> = {}): Promise<void> {
    input.signal?.throwIfAborted();
    const receipt = await inspectCommittedWorkspaceTargetMaterialization(input);
    input.signal?.throwIfAborted();
    const canonicalRoot = receipt.committed!.canonicalRoot;
    const removalPath = join(dirname(canonicalRoot), `.happier-sync-backup.${randomUUID()}`);
    await writeJsonAtomic(input.receiptPath, { ...receipt, removalTargetName: basename(removalPath) } satisfies WorkspaceTargetMaterializationReceiptV1);
    await rename(canonicalRoot, removalPath);
    // Verify the moved object before recursive deletion. A replacement raced at
    // the old name stays inspectable rather than being mistaken for our copy.
    await assertObjectIdentity(removalPath, receipt.promotedTargetIdentity!);
    await (dependencies.removeTarget ?? rm)(removalPath, { recursive: true });
    await rm(input.receiptPath);
}

/**
 * Aborts an interrupted pre-READY materialization using only the receipt
 * written before mutation. A missing named backup means the rename never
 * happened; the original target is therefore left untouched.
 */
export async function recoverInterruptedWorkspaceTargetMaterialization(input: Readonly<{
    targetPath: string;
    backupDirectoryPrefix: string;
    receiptPath: string;
}>): Promise<boolean> {
    const receipt = await readMaterializationReceipt(input.receiptPath);
    if (!receipt) return false;

    const custody = await rehydrateWorkspaceTargetMaterialization({
        targetPath: input.targetPath,
        backupDirectoryPrefix: input.backupDirectoryPrefix,
        receipt,
        receiptPath: input.receiptPath,
    });
    await custody?.abort();
    return true;
}

/** Rebuilds READY-but-unsettled custody from the sole durable receipt. */
export async function rehydrateWorkspaceTargetMaterializationFromReceiptPath(input: Readonly<{
    targetPath: string;
    backupDirectoryPrefix: string;
    receiptPath: string;
}>): Promise<WorkspaceExportMaterializationCustody | null> {
    const receipt = await readMaterializationReceipt(input.receiptPath);
    if (!receipt) return null;
    return await rehydrateWorkspaceTargetMaterialization({
        targetPath: input.targetPath,
        backupDirectoryPrefix: input.backupDirectoryPrefix,
        receipt,
        receiptPath: input.receiptPath,
    });
}

export async function materializeWorkspaceExportArtifactsWithScmWorkspace(params: Readonly<{
    workspaceExportArtifacts: ScmWorkspaceIntegrationWorkspaceExportArtifacts;
    targetPath: string;
    conflictPolicy: ScmWorkspaceIntegrationWorkspaceTransferConflictPolicy;
    blobProvider: WorkspaceExportBlobProvider;
    registry?: ScmBackendRegistry;
    sourcePath?: string;
    naming: WorkspaceExportMaterializationNaming;
    materializationReceiptPath?: string;
    originalTargetExists?: boolean;
    targetFence?: WorkspaceTargetMaterializationFence;
    assertCanContinue?: () => Promise<void>;
}>): Promise<WorkspaceExportMaterializationResult> {
    if (!params.registry) {
        return await runWithScmBackendRegistryLease(undefined, async (registry) =>
            await materializeWorkspaceExportArtifactsWithScmWorkspace({
                ...params,
                registry,
            }));
    }

    const targetPath = await resolveWorkspaceExportMaterializationTargetPath({
        targetPath: params.targetPath,
        conflictPolicy: params.conflictPolicy,
        naming: params.naming,
    });
    await assertPortableWorkspaceEntriesWithScmWorkspace({
        entries: params.workspaceExportArtifacts.manifest.entries,
        registry: params.registry,
    });

    const stagingRoot = await createWorkspaceStagingRoot({
        parentDirectory: dirname(targetPath),
        stagingId: `${params.naming.stagingIdPrefix}-${randomUUID()}`,
    });

    let targetMaterialization: Awaited<ReturnType<typeof beginWorkspaceTargetMaterialization>> | undefined;
    try {
        for (const entry of params.workspaceExportArtifacts.manifest.entries) {
            const materializedEntryPath = resolveContainedWorkspaceMaterializationPath({
                workspaceRoot: stagingRoot.workspaceDirectory,
                candidatePath: entry.relativePath,
                errorMessage: `Workspace transfer path escapes target: ${entry.relativePath}`,
            });
            if (entry.kind !== 'symlink') continue;
            assertWorkspaceMaterializationSymlinkTarget({
                workspaceRoot: stagingRoot.workspaceDirectory,
                linkPath: materializedEntryPath,
                target: entry.target,
            });
        }

        const staged = await stageWorkspaceEntries({
            stagingRoot,
            expectedManifest: params.workspaceExportArtifacts.manifest,
            blobProvider: params.blobProvider,
            scmRegistry: params.registry,
            assertCanContinue: params.assertCanContinue,
        });
        if (!staged.verification.isVerified) {
            throw new Error(`Workspace transfer integrity check failed for ${targetPath}`);
        }

        await params.assertCanContinue?.();

        targetMaterialization = await beginWorkspaceTargetMaterialization({
            targetPath,
            backupDirectoryPrefix: params.naming.backupDirectoryPrefix,
            ...(params.materializationReceiptPath ? { receiptPath: params.materializationReceiptPath } : {}),
            ...(params.originalTargetExists === undefined ? {} : { originalTargetExists: params.originalTargetExists }),
            ...(params.targetFence ? { targetFence: params.targetFence } : {}),
        });
        await promoteStagedWorkspace({
            stagingRoot,
            targetWorkspaceDirectory: targetPath,
            expectedManifest: params.workspaceExportArtifacts.manifest,
            scmRegistry: params.registry,
        });
        await targetMaterialization.custody.bindPromotedTarget();

        await params.assertCanContinue?.();
        await reconcilePostMaterializationWithScmWorkspace({
            targetPath,
            previousTargetPath: targetMaterialization.previousTargetPath,
            sourcePath: params.sourcePath,
            workspaceIntegrationMetadata: params.workspaceExportArtifacts.workspaceIntegrationMetadata,
            registry: params.registry,
        });
        await params.assertCanContinue?.();
    } catch (error) {
        let rollbackError: unknown;
        try {
            await targetMaterialization?.custody.abort();
        } catch (cause) {
            rollbackError = cause;
        }
        await cleanupWorkspaceStaging({ rootDirectory: stagingRoot.rootDirectory }).catch(() => undefined);
        if (rollbackError !== undefined) {
            const rollbackCode = (rollbackError as { code?: unknown }).code;
            throw Object.assign(
                new AggregateError(
                    [error, rollbackError],
                    rollbackError instanceof Error
                        ? rollbackError.message
                        : 'Workspace target rollback requires manual recovery',
                    { cause: error },
                ),
                {
                    code: typeof rollbackCode === 'string'
                        ? rollbackCode
                        : 'workspace_target_materialization_manual_recovery',
                },
            );
        }
        throw error;
    }

    await cleanupWorkspaceStaging({ rootDirectory: stagingRoot.rootDirectory }).catch(() => undefined);

    return {
        targetPath,
        custody: targetMaterialization!.custody,
    };
}
