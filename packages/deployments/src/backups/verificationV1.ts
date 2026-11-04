import { DeploymentBackupManifestV1Schema, DeploymentBackupSnapshotV1Schema } from '@happier-dev/deployment-protocol';
import type { DeploymentBackupRunInputV1 } from '../actions/backups.js';
import { isResticSnapshotBoundToManifestV1, readResticNativeJsonV1, readResticNativeRecordV1,
    readResticRepositoryConfigV1, readResticSnapshotsV1, type BackupManifestV1 } from './manifestV1.js';
import { buildResticRequestV1, type ResticCommandV1 } from './resticExecutor.js';

export type DeploymentBackupReadInputV1 = Pick<DeploymentBackupRunInputV1, 'environmentId' | 'access' | 'signal' | 'execute'>;
export type DeploymentBackupVerificationV1 = Readonly<{
    kind: 'verified'; level: 'manifestReadBack' | 'repositoryCheck'; manifest: BackupManifestV1;
}>;
export type DeploymentBackupVerifyInputV1 = DeploymentBackupReadInputV1 & Readonly<{
    configRevision: number; manifest: BackupManifestV1; level: DeploymentBackupVerificationV1['level'];
}>;

export function backupOperationFailureV1(code: string, step: string): never {
    throw Object.assign(new Error(code), { code, step });
}

/** Strip native payloads/secrets while retaining the producing boundary's exact code and step. */
export async function backupOperationStepV1<T>(step: string, effect: () => T | Promise<T>): Promise<T> {
    try { return await effect(); } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
            ? error.code : 'outcome_unknown';
        return backupOperationFailureV1(code, step);
    }
}

/** Consumes the already-admitted native adapter; this does not own processes or credentials. */
export async function executeBackupOperationStepV1(input: DeploymentBackupReadInputV1, command: ResticCommandV1, step: string) {
    return backupOperationStepV1(step, async () => {
        if (input.signal.aborted) return backupOperationFailureV1('cancelled', step);
        const result = await input.execute(buildResticRequestV1({ environmentId: input.environmentId, access: input.access, command }));
        if (result.kind === 'outcome_unknown') return backupOperationFailureV1('outcome_unknown', step);
        if (result.exitCode !== 0) return backupOperationFailureV1('backup_failed', step);
        return result;
    });
}

/** Shared by a just-created backup and exact receipt verification. Repository/snapshot binding precedes this read. */
export async function readBackDeploymentBackupManifestV1(input: DeploymentBackupReadInputV1 & Readonly<{ manifest: BackupManifestV1 }>): Promise<void> {
    const { manifest } = input;
    if (manifest.kind !== 'dump') return backupOperationFailureV1('unsupported_action', 'manifest');
    const path = manifest.snapshot.paths[0];
    if (manifest.snapshot.paths.length !== 1 || !path || !path.startsWith('/') || path.slice(1).includes('/')
        || manifest.totalFilesProcessed !== 1) return backupOperationFailureV1('backup_integrity_failed', 'manifest');
    const tree = await executeBackupOperationStepV1(input, { kind: 'tree', treeId: manifest.snapshot.treeId }, 'tree');
    await backupOperationStepV1('tree', () => {
        if (tree.stdoutTruncated) return backupOperationFailureV1('outcome_unknown', 'tree');
        const nativeTree = readResticNativeRecordV1(readResticNativeJsonV1(tree.stdout));
        if (!Array.isArray(nativeTree.nodes) || nativeTree.nodes.length !== 1) return backupOperationFailureV1('backup_integrity_failed', 'tree');
        const file = readResticNativeRecordV1(nativeTree.nodes[0]);
        if (file.name !== path.slice(1) || file.type !== 'file'
            || file.size !== manifest.totalBytesProcessed) return backupOperationFailureV1('backup_integrity_failed', 'tree');
    });
    const payload = await executeBackupOperationStepV1(input, { kind: 'dump', snapshotId: manifest.snapshot.snapshotId, path }, 'payload');
    await backupOperationStepV1('payload', () => {
        // Native stdout may be omitted/truncated; its stream checksum/count are the evidence, not captured text.
        const checksum = DeploymentBackupSnapshotV1Schema.shape.snapshotId.parse(payload.stdoutChecksumSha256);
        const bytes = DeploymentBackupManifestV1Schema.shape.totalBytesProcessed.parse(payload.stdoutBytes);
        if (checksum !== manifest.producerChecksumSha256 || bytes !== manifest.totalBytesProcessed) {
            return backupOperationFailureV1('backup_integrity_failed', 'payload');
        }
    });
    if (input.signal.aborted) return backupOperationFailureV1('cancelled', 'payload');
}

/** Read-only integrity operation: no restore preparation, backup, deletion, activation or metadata writes. */
export async function verifyDeploymentBackupV1(input: DeploymentBackupVerifyInputV1): Promise<DeploymentBackupVerificationV1> {
    const { manifest } = input;
    if (manifest.environmentId !== input.environmentId || manifest.configRevision !== input.configRevision) {
        return backupOperationFailureV1('stale_input', 'manifest');
    }
    const config = await executeBackupOperationStepV1(input, { kind: 'config' }, 'repository');
    await backupOperationStepV1('repository', () => {
        if (readResticRepositoryConfigV1(config.stdout, config.exitCode, config.stdoutTruncated).repositoryId !== manifest.repositoryId) {
            return backupOperationFailureV1('backup_integrity_failed', 'repository');
        }
    });
    const inventory = await executeBackupOperationStepV1(input, { kind: 'snapshots', snapshotId: manifest.snapshot.snapshotId }, 'snapshot');
    await backupOperationStepV1('snapshot', () => {
        const snapshots = readResticSnapshotsV1(inventory.stdout, inventory.exitCode, inventory.stdoutTruncated);
        if (snapshots.length !== 1 || !snapshots[0] || !isResticSnapshotBoundToManifestV1(snapshots[0], manifest)) {
            return backupOperationFailureV1('backup_integrity_failed', 'snapshot');
        }
    });
    await readBackDeploymentBackupManifestV1(input);
    if (input.level === 'repositoryCheck') await executeBackupOperationStepV1(input, { kind: 'check' }, 'repositoryCheck');
    if (input.signal.aborted) return backupOperationFailureV1('cancelled', input.level === 'repositoryCheck' ? 'repositoryCheck' : 'payload');
    return { kind: 'verified', level: input.level, manifest };
}
