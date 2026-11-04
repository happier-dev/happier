import type { DeploymentBackupConfigurationV1 } from '@happier-dev/deployment-protocol';
import { isResticSnapshotBoundToManifestV1, isResticSnapshotOwnedV1, readResticRepositoryConfigV1,
    readResticSnapshotInventoryV1, type BackupManifestV1, type ResticSnapshotV1 } from './manifestV1.js';
import { backupOperationFailureV1, backupOperationStepV1, executeBackupOperationStepV1,
    type DeploymentBackupReadInputV1 } from './verificationV1.js';

export type DeploymentBackupInventoryEntryV1 = Readonly<{
    snapshot: ResticSnapshotV1; sourceId: string; kind: 'dump' | 'volume';
    totalBytesProcessed?: number; totalFilesProcessed?: number; verified: boolean; manifest?: BackupManifestV1;
}>;
export type DeploymentBackupInventoryInputV1 = DeploymentBackupReadInputV1 & Readonly<{
    configuration: DeploymentBackupConfigurationV1; verificationEvidence?: readonly BackupManifestV1[];
}>;
export type DeploymentBackupInventoryResultV1 = Readonly<{ kind: 'listed'; repositoryId: string; entries: readonly DeploymentBackupInventoryEntryV1[] }>;

/** Demand-driven selected-repository inventory; history is the existing operation store, not another backup ledger. */
export async function inventoryDeploymentBackupsV1(input: DeploymentBackupInventoryInputV1): Promise<DeploymentBackupInventoryResultV1> {
    const config = await executeBackupOperationStepV1(input, { kind: 'config' }, 'repository');
    const { repositoryId } = await backupOperationStepV1('repository', () =>
        readResticRepositoryConfigV1(config.stdout, config.exitCode, config.stdoutTruncated));
    const result = await executeBackupOperationStepV1(input, { kind: 'snapshots' }, 'inventory');
    const rows = await backupOperationStepV1('inventory', () => readResticSnapshotInventoryV1(result.stdout, result.exitCode, result.stdoutTruncated));
    const manifests = new Map<string, BackupManifestV1>(input.verificationEvidence?.filter(manifest => manifest.repositoryId === repositoryId
        && manifest.environmentId === input.environmentId).map(manifest => [manifest.snapshot.snapshotId, manifest]));
    const entries = await backupOperationStepV1('inventory', () => rows.map<DeploymentBackupInventoryEntryV1>(row => {
        const { snapshot } = row;
        const sources = snapshot.tags.filter(tag => tag.startsWith('src:'));
        const kinds = snapshot.tags.filter(tag => tag.startsWith('kind:'));
        const kind = kinds[0] === 'kind:dump' ? 'dump' : kinds[0] === 'kind:volume' ? 'volume' : undefined;
        if (!isResticSnapshotOwnedV1(snapshot, input.environmentId) || sources.length !== 1 || !sources[0]?.slice(4)
            || kinds.length !== 1 || !kind) return backupOperationFailureV1('backup_integrity_failed', 'inventory');
        const receipt = manifests.get(snapshot.snapshotId);
        const manifest = receipt && isResticSnapshotBoundToManifestV1(snapshot, receipt) ? receipt : undefined;
        return { ...row, sourceId: sources[0].slice(4), kind, verified: manifest !== undefined,
            ...(row.totalBytesProcessed === undefined && manifest ? { totalBytesProcessed: manifest.totalBytesProcessed } : {}),
            ...(row.totalFilesProcessed === undefined && manifest ? { totalFilesProcessed: manifest.totalFilesProcessed } : {}),
            ...(manifest ? { manifest } : {}) };
    }));
    if (input.signal.aborted) return backupOperationFailureV1('cancelled', 'inventory');
    return { kind: 'listed', repositoryId, entries };
}
