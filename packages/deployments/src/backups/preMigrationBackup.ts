import type { DeploymentBackupManifestV1, DeploymentPreMigrationBackupV1, DeploymentReceiptDetailV1 } from '@happier-dev/deployment-protocol';
import { isResticSnapshotOwnedV1 } from './manifestV1.js';
import { deploymentBackupDumpFilenameV1 } from '../actions/backups.js';
import type { DeploymentRestoreDestinationV1 } from './restoreLifecycle.js';

export type DeploymentRestoreResolvedCaptureV1 = Readonly<Pick<DeploymentPreMigrationBackupV1,
    'source' | 'sourceFormat' | 'configuration' | 'repository'> & { destination: DeploymentRestoreDestinationV1 }>;
export type DeploymentRestoreCaptureResolutionV1 =
    | Readonly<{ kind: 'resolved'; capture: DeploymentRestoreResolvedCaptureV1 }>
    | Readonly<{ kind: 'refused'; code: 'backup_required' | 'stale_input' | 'unsupported_action' }>;

/** One selection from admitted receipt evidence. A legacy manifest keeps its original
 * revision; its configured repository and CURRENT native destination are separate operands.
 * Native prepare must verify the exact repository/snapshot/payload before any safety or restore effect. */
export function resolveDeploymentRestoreCaptureV1(input: Readonly<{
    environmentId: string; restoreBackupId: string;
    destination: DeploymentRestoreDestinationV1;
}> & (Readonly<{ receipt: DeploymentReceiptDetailV1 }> | Readonly<{ capture: DeploymentPreMigrationBackupV1 }>
    | Readonly<{ manifest: DeploymentBackupManifestV1; configuration: DeploymentPreMigrationBackupV1['configuration'];
        repository: DeploymentPreMigrationBackupV1['repository'] }>)): DeploymentRestoreCaptureResolutionV1 {
    const { environmentId, destination } = input;
    if (destination.environmentId !== environmentId
        || 'receipt' in input && input.receipt.deployment.environmentId !== environmentId) {
        return { kind: 'refused', code: 'stale_input' };
    }
    if ('receipt' in input && !input.receipt.content.ownServer) return { kind: 'refused', code: 'unsupported_action' };
    const backup: DeploymentPreMigrationBackupV1 | undefined = 'receipt' in input ? input.receipt.content.ownServer?.preMigrationBackup
        : 'capture' in input ? input.capture : { source: input.manifest, configuration: input.configuration,
            repository: input.repository, sourceFormat: 'postgresCustom', target: {
                service: destination.service, adapter: destination.adapter, database: destination.database } };
    if (!backup || backup.source.snapshot.snapshotId !== input.restoreBackupId) return { kind: 'refused', code: 'backup_required' };
    const { source, target, configuration } = backup;
    if (source.environmentId !== environmentId || configuration.ownership.environmentId !== environmentId
        || !('manifest' in input) && configuration.configRevision !== source.configRevision
        || target.service !== destination.service || target.adapter !== destination.adapter || target.database !== destination.database) {
        return { kind: 'refused', code: 'stale_input' };
    }
    // The sole backup producer emits this exact filename only for PostgreSQL custom
    // archives; other engines and foreign source mappings cannot use legacy recovery.
    if ('manifest' in input && (source.snapshot.paths.length !== 1
        || source.snapshot.paths[0] !== `/${deploymentBackupDumpFilenameV1('postgres-v1', destination.service)}`)) {
        return { kind: 'refused', code: 'unsupported_action' };
    }
    if (source.kind !== 'dump' || !isResticSnapshotOwnedV1(source.snapshot, environmentId)
        || !source.snapshot.tags.includes(`src:${source.sourceId}`) || !source.snapshot.tags.includes('kind:dump')
        || !configuration.sources.some(selected => selected.kind === 'dump' && selected.sourceId === source.sourceId && selected.service === target.service)) {
        return { kind: 'refused', code: 'backup_required' };
    }
    return { kind: 'resolved', capture: { source, sourceFormat: backup.sourceFormat, destination,
        configuration, repository: backup.repository } };
}
