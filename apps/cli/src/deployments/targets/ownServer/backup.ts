import { inventoryDeploymentBackupsV1, runDeploymentBackupV1, verifyDeploymentBackupV1,
    pruneDeploymentBackupsV1, testDeploymentBackupDestinationV1 } from '@happier-dev/deployments';
import type { DeploymentBackupActionResultV1 } from '@happier-dev/protocol/deployments/deploymentBackupActionsV1';
import { DEPLOYMENT_BACKUP_TEST_ACTION_ID_V1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import type { OwnServerBackupRequestForHost } from './ownServerDeploymentTarget';
import type { OwnServerBackupRepositoryOperandsForHost, OwnServerPreMigrationBackupOperandsForHost } from './backupDestination';
import { withOwnServerNativeBackup, type OwnServerNativeRestoreInput } from './nativeRestore';

/** Public Actions project the one backup owner through the existing native runner. */
export async function executeOwnServerBackupForHost(request: OwnServerBackupRequestForHost,
    input: OwnServerNativeRestoreInput,
    operands: OwnServerBackupRepositoryOperandsForHost | OwnServerPreMigrationBackupOperandsForHost,
    operationId: string): Promise<DeploymentBackupActionResultV1> {
    const destination = 'destination' in operands ? operands.destination : undefined;
    return withOwnServerNativeBackup<DeploymentBackupActionResultV1>(input, destination, async native => {
        const common = { environmentId: request.input.environmentId, configuration: operands.configuration,
            access: native.access, signal: native.signal, execute: native.executeBackup };
        switch (request.actionId) {
            case DEPLOYMENT_BACKUP_TEST_ACTION_ID_V1: return testDeploymentBackupDestinationV1({ ...common, operationId });
            case 'deployments.backups.run': {
                const result = await runDeploymentBackupV1({ ...common, ...('data' in operands
                    ? { data: operands.data, restoreTarget: operands.destination } : {}) });
                return { kind: 'verified', operationId, manifests: [...result.manifests],
                    ...(result.restoreCaptures ? { restoreCaptures: [...result.restoreCaptures] } : {}) };
            }
            case 'deployments.backups.inventory': {
                const evidence = request.verificationEvidence ?? [];
                const result = await inventoryDeploymentBackupsV1({ ...common, verificationEvidence: evidence.map(row => row.manifest) });
                const operations = new Map(evidence.map(row => [row.manifest.snapshot.snapshotId, row.backupOperationId]));
                return { kind: 'inventory', environmentId: common.environmentId,
                    configRevision: operands.configuration.configRevision, repositoryId: result.repositoryId,
                    snapshots: result.entries.map(entry => {
                        const backupOperationId = entry.verified ? operations.get(entry.snapshot.snapshotId) : undefined;
                        return { snapshot: entry.snapshot, source: { sourceId: entry.sourceId, kind: entry.kind },
                            ...(entry.totalBytesProcessed === undefined ? {} : { totalBytesProcessed: entry.totalBytesProcessed }),
                            verification: backupOperationId && entry.manifest ? { kind: 'verified' as const, backupOperationId,
                                configRevision: entry.manifest.configRevision }
                                : { kind: 'unknown' as const, reason: 'captureReceiptUnavailable' as const } };
                    }) };
            }
            case 'deployments.backups.verify': {
                const result = await verifyDeploymentBackupV1({ ...common, configRevision: request.input.configRevision,
                    manifest: request.manifest, level: request.input.level });
                return { kind: 'verified', operationId, backupOperationId: request.input.backupOperationId,
                    environmentId: common.environmentId, configRevision: result.manifest.configRevision,
                    repositoryId: result.manifest.repositoryId, snapshotId: result.manifest.snapshot.snapshotId,
                    level: result.level, verified: true };
            }
            case 'deployments.backups.prune': {
                const result = await pruneDeploymentBackupsV1({ ...common, verification: request.verification,
                    protectedSnapshotIds: request.protectedSnapshotIds });
                return { kind: result.kind === 'pruned' ? 'pruned' : 'noop', environmentId: common.environmentId,
                    configRevision: operands.configuration.configRevision, forgottenSnapshotIds: [...result.removedSnapshotIds] };
            }
        }
    });
}
