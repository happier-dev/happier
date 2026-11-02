import type { DeploymentPreMigrationBackupV1, DeploymentReceiptDetailV1 } from '@happier-dev/deployment-protocol';
import { isResticSnapshotOwnedV1 } from './manifestV1.js';
import type { DeploymentRestoreDestinationV1 } from './restoreLifecycle.js';

export type DeploymentRestoreResolvedCaptureV1 = Readonly<Pick<DeploymentPreMigrationBackupV1,
    'source' | 'sourceFormat' | 'configuration' | 'repository'> & { destination: DeploymentRestoreDestinationV1 }>;
export type DeploymentRestoreCaptureResolutionV1 =
    | Readonly<{ kind: 'resolved'; capture: DeploymentRestoreResolvedCaptureV1 }>
    | Readonly<{ kind: 'refused'; code: 'backup_required' | 'stale_input' | 'unsupported_action' }>;

/** ONE admission-time selection from an already-authorized, opened receipt.
 * No history/inventory lookup, credential acquisition or later-step recheck. */
export function resolveDeploymentRestoreCaptureV1(input: Readonly<{
    environmentId: string; restoreBackupId: string; receipt: DeploymentReceiptDetailV1;
    destination: DeploymentRestoreDestinationV1;
}>): DeploymentRestoreCaptureResolutionV1 {
    const { environmentId, receipt, destination } = input;
    if (receipt.deployment.environmentId !== environmentId || destination.environmentId !== environmentId) {
        return { kind: 'refused', code: 'stale_input' };
    }
    if (!receipt.content.ownServer) return { kind: 'refused', code: 'unsupported_action' };
    const backup = receipt.content.ownServer.preMigrationBackup;
    if (!backup || backup.source.snapshot.snapshotId !== input.restoreBackupId) return { kind: 'refused', code: 'backup_required' };
    const { source, target, configuration } = backup;
    if (source.environmentId !== environmentId || configuration.ownership.environmentId !== environmentId
        || configuration.configRevision !== source.configRevision
        || target.service !== destination.service || target.adapter !== destination.adapter || target.database !== destination.database) {
        return { kind: 'refused', code: 'stale_input' };
    }
    if (source.kind !== 'dump' || !isResticSnapshotOwnedV1(source.snapshot, environmentId)
        || !source.snapshot.tags.includes(`src:${source.sourceId}`) || !source.snapshot.tags.includes('kind:dump')
        || !configuration.sources.some(selected => selected.kind === 'dump' && selected.sourceId === source.sourceId && selected.service === target.service)) {
        return { kind: 'refused', code: 'backup_required' };
    }
    return { kind: 'resolved', capture: { source, sourceFormat: backup.sourceFormat, destination,
        configuration, repository: backup.repository } };
}
