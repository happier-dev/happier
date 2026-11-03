import { prepareFilesystemPathAuthorizer } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemPathAuthorization';
import { lstat } from 'node:fs/promises';
import { unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { access, readFile, readdir, realpath, rename, rm, rmdir } from 'node:fs/promises';
import { basename, dirname, join, parse, resolve } from 'node:path';
import { z } from 'zod/mini';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';

import type { ScmBackendRegistry } from '../registry';
import { writeJsonAtomic } from '@/utils/fs/writeJsonAtomic';
import { runWithScmBackendRegistryLease } from '../scmBackendCatalog';
import { cleanupWorkspaceStaging } from './workspaceExportStaging/cleanupWorkspaceStaging';
import {
    createWorkspaceStagingRoot,
    type WorkspaceStagingRoot,
} from './workspaceExportStaging/createWorkspaceStagingRoot';
import { promoteStagedWorkspace, type WorkspaceMaterializedEntryAccess } from './workspaceExportStaging/promoteStagedWorkspace';
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
    WorkspaceSyncRootObjectIdentityV1Schema,
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

const WorkerCopyCreationSchema = z.strictObject({
    serverId: z.string().check(z.minLength(1), z.refine(value => value === value.trim())),
    relationshipId: z.string().check(z.minLength(1), z.refine(value => value === value.trim())),
    sourceWorkspaceRefId: z.string().check(z.minLength(1), z.refine(value => value === value.trim())),
    targetWorkspaceRefId: z.string().check(z.minLength(1), z.refine(value => value === value.trim())),
}).check(z.refine(value => value.sourceWorkspaceRefId !== value.targetWorkspaceRefId));

const CommittedTargetSchema = z.strictObject({
    canonicalRoot: z.string().check(z.refine(value => value === resolve(value))),
    rootFingerprint: z.string().check(z.regex(/^[a-f0-9]{64}$/u)),
});
const RemovalTargetNameSchema = z.string().check(z.regex(/^\.happier-sync-backup\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu));
const MaterializationReceiptSchema = z.strictObject({
    v: z.literal(1),
    previousTargetName: z.nullable(z.string()),
    originalTargetIdentity: z.nullable(WorkspaceSyncRootObjectIdentityV1Schema),
    promotedTargetIdentity: z.nullable(WorkspaceSyncRootObjectIdentityV1Schema),
    expectedBackupIdentity: z.nullable(WorkspaceSyncRootObjectIdentityV1Schema),
    workerCopyCreation: z.optional(WorkerCopyCreationSchema),
    committed: z.optional(CommittedTargetSchema),
    removalTargetName: z.optional(RemovalTargetNameSchema),
});
const StoredMaterializationReceiptSchema = createStoredReadSchema(MaterializationReceiptSchema);

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
        return StoredMaterializationReceiptSchema.parse(JSON.parse(raw));
    } catch {
        throw materializationRecoveryError('Invalid or unsupported workspace target materialization receipt');
    }
}

function materializationRecoveryError(message: string): Error {
    return Object.assign(new Error(message), { code: 'workspace_target_materialization_manual_recovery' });
}

function isWorkerCopyCreation(value: unknown): boolean {
    return value === undefined || WorkerCopyCreationSchema.safeParse(value).success;
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

/**
 * The one rollback for a not-yet-committed materialization, shared by the live
 * custody and the one rebuilt from its receipt. Only the object this custody
 * left at the target (the bound promotion, or the original before anything
 * replaced it) is ever removed; anything else stays for manual recovery.
 * Rollback before the promotion was bound therefore restores the backup, or
 * the absence, without touching a foreign object.
 */
async function rollbackMaterializedTarget(input: Readonly<{
    targetPath: string;
    previousTargetPath?: string;
    receipt: WorkspaceTargetMaterializationReceiptV1;
    receiptPath?: string;
}>): Promise<void> {
    const { receipt } = input;
    const currentTargetIdentity = await readObjectIdentityOrAbsent(input.targetPath);
    if (currentTargetIdentity) {
        const expectedTargetIdentity = receipt.promotedTargetIdentity ?? receipt.originalTargetIdentity;
        if (!expectedTargetIdentity
            || !workspaceSyncRootObjectIdentitiesEqual(currentTargetIdentity, expectedTargetIdentity)) {
            throw materializationRecoveryError('Target pathname is occupied by another filesystem object');
        }
    }
    if (input.previousTargetPath) {
        if (!receipt.expectedBackupIdentity) {
            throw materializationRecoveryError('Backup identity is unavailable');
        }
        await assertObjectIdentity(input.previousTargetPath, receipt.expectedBackupIdentity);
    }
    if (currentTargetIdentity) {
        await rm(input.targetPath, { recursive: true, force: true });
    }
    if (input.previousTargetPath) {
        await rename(input.previousTargetPath, input.targetPath);
    }
    if (input.receiptPath) await rm(input.receiptPath, { force: true });
}

/**
 * Rolls a failed materialization back and reports the failure that caused it.
 * A rollback that itself needs manual recovery keeps its typed code, but never
 * replaces the original failure's message.
 */
export async function abortWorkspaceTargetMaterializationAfterFailure(
    custody: Pick<WorkspaceExportMaterializationCustody, 'abort'> | undefined,
    failure: unknown,
): Promise<void> {
    try {
        await custody?.abort();
    } catch (rollbackError) {
        const rollbackCode = (rollbackError as { code?: unknown }).code;
        throw Object.assign(
            new AggregateError(
                [failure, rollbackError],
                failure instanceof Error
                    ? failure.message
                    : rollbackError instanceof Error
                        ? rollbackError.message
                        : 'Workspace target rollback requires manual recovery',
                { cause: failure },
            ),
            {
                code: typeof rollbackCode === 'string'
                    ? rollbackCode
                    : 'workspace_target_materialization_manual_recovery',
            },
        );
    }
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
            await rollbackMaterializedTarget({
                targetPath: input.targetPath,
                ...(previousTargetPath ? { previousTargetPath } : {}),
                receipt,
                ...(input.receiptPath ? { receiptPath: input.receiptPath } : {}),
            });
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
    const parsedReceipt = MaterializationReceiptSchema.safeParse(input.receipt);
    if (!parsedReceipt.success) {
        throw materializationRecoveryError('Invalid workspace target materialization receipt identity');
    }
    const validatedReceipt = parsedReceipt.data;
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
            await rollbackMaterializedTarget({
                targetPath,
                ...(previousTargetPath ? { previousTargetPath } : {}),
                receipt: validatedReceipt,
                ...(input.receiptPath ? { receiptPath: input.receiptPath } : {}),
            });
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
    prepareEntryAccess?: WorkspaceMaterializedEntryAccess;
    /** An admitted release destination is exact and may never fall back to the user's home. */
    admittedTargetRoot?: string;
    conflictPolicy: ScmWorkspaceIntegrationWorkspaceTransferConflictPolicy;
    blobProvider: WorkspaceExportBlobProvider;
    registry?: ScmBackendRegistry;
    sourcePath?: string;
    naming: WorkspaceExportMaterializationNaming;
    materializationReceiptPath?: string;
    originalTargetExists?: boolean;
    targetFence?: WorkspaceTargetMaterializationFence;
    /** Host-only custody of one exact preexisting file; ordinary target fences are unchanged. */
    retainedTargetFile?: Readonly<{
        relativePath: string;
        assertInitialTarget(): Promise<void>;
        assertRetainedFile(): Promise<void>;
    }>;
    assertCanContinue?: () => Promise<void>;
}>): Promise<WorkspaceExportMaterializationResult> {
    if (!params.registry) {
        return await runWithScmBackendRegistryLease(undefined, async (registry) =>
            await materializeWorkspaceExportArtifactsWithScmWorkspace({
                ...params,
                registry,
            }));
    }

    const targetPath = params.admittedTargetRoot ? resolve(params.targetPath) : await resolveWorkspaceExportMaterializationTargetPath({
        targetPath: params.targetPath,
        conflictPolicy: params.conflictPolicy,
        naming: params.naming,
    });
    const authorizeTarget = params.admittedTargetRoot ? await prepareFilesystemPathAuthorizer({
        defaultDirectory: params.admittedTargetRoot,
        accessPolicy: { kind: 'restrictedRoots', roots: [params.admittedTargetRoot] },
    }) : undefined;
    const assertCanContinue = authorizeTarget ? async () => {
        await params.assertCanContinue?.();
        if (!(await authorizeTarget(targetPath)).valid) {
            throw Object.assign(new Error('Materialization escaped its admitted root'), { code: 'invalid_request' });
        }
    } : params.assertCanContinue;
    if (authorizeTarget) await assertCanContinue?.();
    await assertPortableWorkspaceEntriesWithScmWorkspace({
        entries: params.workspaceExportArtifacts.manifest.entries,
        registry: params.registry,
    });

    const stagingRoot = await createWorkspaceStagingRoot({
        parentDirectory: dirname(targetPath),
        stagingId: `${params.naming.stagingIdPrefix}-${randomUUID()}`,
    });

    let targetMaterialization: Awaited<ReturnType<typeof beginWorkspaceTargetMaterialization>>
        | Awaited<ReturnType<typeof beginWorkspaceTargetMaterializationRetainingFile>> | undefined;
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
            assertCanContinue,
        });
        if (!staged.verification.isVerified) {
            throw new Error(`Workspace transfer integrity check failed for ${targetPath}`);
        }
        for (const entry of staged.stagedSymlinks) {
            assertWorkspaceMaterializationSymlinkTarget({
                workspaceRoot: stagingRoot.workspaceDirectory,
                linkPath: entry.filePath,
                target: entry.target,
                installed: true,
            });
        }

        await assertCanContinue?.();

        targetMaterialization = params.retainedTargetFile
            ? await beginWorkspaceTargetMaterializationRetainingFile({ targetPath, retained: params.retainedTargetFile })
            : await beginWorkspaceTargetMaterialization({
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
            prepareEntryAccess: params.prepareEntryAccess,
            ...('existingTarget' in targetMaterialization ? { existingTarget: targetMaterialization.existingTarget } : {}),
        });
        await targetMaterialization.custody.bindPromotedTarget();

        await assertCanContinue?.();
        await reconcilePostMaterializationWithScmWorkspace({
            targetPath,
            previousTargetPath: targetMaterialization.previousTargetPath,
            sourcePath: params.sourcePath,
            workspaceIntegrationMetadata: params.workspaceExportArtifacts.workspaceIntegrationMetadata,
            registry: params.registry,
        });
        await assertCanContinue?.();
    } catch (error) {
        const rollback = await abortWorkspaceTargetMaterializationAfterFailure(targetMaterialization?.custody, error)
            .then(() => undefined, (rollbackFailure: unknown) => rollbackFailure);
        await cleanupWorkspaceStaging({ rootDirectory: stagingRoot.rootDirectory }).catch(() => undefined);
        throw rollback ?? error;
    }

    await cleanupWorkspaceStaging({ rootDirectory: stagingRoot.rootDirectory }).catch(() => undefined);

    return {
        targetPath,
        custody: targetMaterialization!.custody,
    };
}

async function beginWorkspaceTargetMaterializationRetainingFile(input: Readonly<{
    targetPath: string;
    retained: Readonly<{ relativePath: string; assertInitialTarget(): Promise<void>; assertRetainedFile(): Promise<void> }>;
}>) {
    await input.retained.assertInitialTarget();
    const rootIdentity = await readWorkspaceSyncRootObjectIdentity(input.targetPath);
    const assertCurrent = async () => {
        await assertObjectIdentity(input.targetPath, rootIdentity);
        await input.retained.assertRetainedFile();
    };
    const objectIdentity = async (path: string) => {
        const stat = await lstat(path, { bigint: true });
        return { device: stat.dev, inode: stat.ino, birthtime: stat.birthtimeNs,
            kind: stat.isDirectory() ? 'directory' : stat.isSymbolicLink() ? 'symlink' : 'file' } as const;
    };
    const created: { path: string; identity: Awaited<ReturnType<typeof objectIdentity>> }[] = [];
    let receipt: WorkspaceTargetMaterializationReceiptV1 = Object.freeze({ v: 1, previousTargetName: null,
        originalTargetIdentity: rootIdentity, promotedTargetIdentity: rootIdentity, expectedBackupIdentity: null });
    let settled = false;
    const custody: WorkspaceExportMaterializationCustody = {
        get receipt() { return receipt; },
        async bindPromotedTarget() { await assertCurrent(); },
        async commit() {
            if (settled) return;
            await assertCurrent();
            receipt = await committedReceipt(input.targetPath, receipt); settled = true;
        },
        async abort() {
            if (settled) return;
            await assertCurrent();
            // Validate the entire rollback set before removing anything. A replacement
            // is foreign even when it occupies an operation-created pathname.
            for (const entry of created) {
                const actual = await objectIdentity(entry.path);
                if (actual.device !== entry.identity.device || actual.inode !== entry.identity.inode
                    || actual.birthtime !== entry.identity.birthtime || actual.kind !== entry.identity.kind) {
                    throw materializationRecoveryError('Promoted workspace entry changed');
                }
            }
            for (const entry of [...created].reverse()) {
                await assertCurrent();
                const actual = await objectIdentity(entry.path);
                if (actual.device !== entry.identity.device || actual.inode !== entry.identity.inode
                    || actual.birthtime !== entry.identity.birthtime || actual.kind !== entry.identity.kind) {
                    throw materializationRecoveryError('Promoted workspace entry changed');
                }
                if (actual.kind === 'directory') await rmdir(entry.path);
                else await unlink(entry.path);
            }
            settled = true;
        },
    };
    return { previousTargetPath: undefined, custody,
        existingTarget: { retainedRelativePath: input.retained.relativePath, assertCurrent,
            async recordCreated(path: string) { created.push({ path, identity: await objectIdentity(path) }); } },
    };
}
