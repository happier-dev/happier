import type { DeploymentBackupManifestV1, DeploymentPreMigrationBackupV1, DeploymentBackupRestoreCaptureV1, DeploymentReceiptDetailV1 } from '@happier-dev/deployment-protocol';
import { isResticSnapshotOwnedV1 } from './manifestV1.js';
import { deploymentBackupDumpFilenameV1 } from '../actions/backups.js';
import type { DeploymentRestoreDestinationV1 } from './restoreLifecycle.js';

export type DeploymentRestoreResolvedCaptureV1 = Readonly<Pick<DeploymentBackupRestoreCaptureV1,
    'source' | 'sourceFormat' | 'configuration' | 'repository'> & { destination: DeploymentRestoreDestinationV1 }>;
export type DeploymentRestoreCaptureResolutionV1 =
    | Readonly<{ kind: 'resolved'; capture: DeploymentRestoreResolvedCaptureV1 }>
    | Readonly<{ kind: 'refused'; code: 'backup_required' | 'stale_input' | 'unsupported_action' }>;

/** Home admits Manage on both Environments. This mapping selects native identities;
 * it supplies neither credential authority nor permission to mutate the source. */
export type DeploymentRestoreCopyMappingV1 = Readonly<{
    source: DeploymentBackupRestoreCaptureV1['target'] & Readonly<{ environmentId: string }>;
    destination: DeploymentBackupRestoreCaptureV1['target'] & Readonly<{ environmentId: string }>;
}>;

function sameTarget(left: DeploymentRestoreCopyMappingV1['source'],
    right: DeploymentRestoreCopyMappingV1['destination']) {
    return left.environmentId === right.environmentId && left.service === right.service && left.adapter === right.adapter
        && (left.adapter === 'postgres-v1' && right.adapter === 'postgres-v1' ? left.database === right.database
            : left.adapter === 'sqlite-v1' && right.adapter === 'sqlite-v1' ? left.path === right.path
            : left.adapter === 'volume-v1' && right.adapter === 'volume-v1' && left.volume === right.volume);
}

/** One selection from admitted receipt evidence. A legacy manifest keeps its original
 * revision; its configured repository and CURRENT native destination are separate operands.
 * Native prepare must verify the exact repository/snapshot/payload before any safety or restore effect. */
export function resolveDeploymentRestoreCaptureV1(input: Readonly<{
    environmentId: string; restoreBackupId: string;
    destination: DeploymentRestoreDestinationV1;
    copy?: DeploymentRestoreCopyMappingV1;
}> & (Readonly<{ receipt: DeploymentReceiptDetailV1 }> | Readonly<{ capture: DeploymentBackupRestoreCaptureV1 }>
    | Readonly<{ manifest: DeploymentBackupManifestV1; configuration: DeploymentPreMigrationBackupV1['configuration'];
        repository: DeploymentPreMigrationBackupV1['repository'] }>)): DeploymentRestoreCaptureResolutionV1 {
    const { environmentId, destination, copy } = input;
    const sourceEnvironmentId = copy?.source.environmentId ?? environmentId;
    if (destination.environmentId !== environmentId
        || copy && (!sameTarget(copy.destination, destination) || sourceEnvironmentId === environmentId)
        || 'receipt' in input && input.receipt.deployment.environmentId !== sourceEnvironmentId) {
        return { kind: 'refused', code: 'stale_input' };
    }
    // Legacy manifest-only recovery has no captured source database identity.
    // A copy must retain the original producer's target rather than invent it.
    if (copy && 'manifest' in input) return { kind: 'refused', code: 'backup_required' };
    if ('receipt' in input && !input.receipt.content.ownServer) return { kind: 'refused', code: 'unsupported_action' };
    const backup: DeploymentBackupRestoreCaptureV1 | undefined = 'receipt' in input ? input.receipt.content.ownServer?.preMigrationBackup
        : 'capture' in input ? input.capture : destination.adapter !== 'postgres-v1' ? undefined : { source: input.manifest, configuration: input.configuration,
            repository: input.repository, sourceFormat: 'postgresCustom', target: {
                service: destination.service, adapter: destination.adapter, database: destination.database } };
    if (!backup || backup.source.snapshot.snapshotId !== input.restoreBackupId) return { kind: 'refused', code: 'backup_required' };
    const { source, target, configuration } = backup;
    if (source.environmentId !== sourceEnvironmentId || configuration.ownership.environmentId !== sourceEnvironmentId
        || !('manifest' in input) && configuration.configRevision !== source.configRevision
        || !sameTarget({ environmentId: sourceEnvironmentId, ...target }, copy?.source ?? destination)) {
        return { kind: 'refused', code: 'stale_input' };
    }
    // The sole backup producer emits this exact filename only for PostgreSQL custom
    // archives; other engines and foreign source mappings cannot use legacy recovery.
    if ('manifest' in input && (source.snapshot.paths.length !== 1
        || source.snapshot.paths[0] !== `/${deploymentBackupDumpFilenameV1('postgres-v1', destination.service)}`)) {
        return { kind: 'refused', code: 'unsupported_action' };
    }
    const kind = target.adapter === 'volume-v1' ? 'volume' : 'dump';
    if (source.kind !== kind || !isResticSnapshotOwnedV1(source.snapshot, sourceEnvironmentId)
        || !source.snapshot.tags.includes(`src:${source.sourceId}`) || !source.snapshot.tags.includes(`kind:${kind}`)
        || !configuration.sources.some(selected => selected.kind === kind && selected.sourceId === source.sourceId && selected.service === target.service
            && (target.adapter !== 'volume-v1' || selected.kind === 'volume' && selected.volume === target.volume))) {
        return { kind: 'refused', code: 'backup_required' };
    }
    return { kind: 'resolved', capture: { source, sourceFormat: backup.sourceFormat, destination,
        configuration, repository: backup.repository } };
}
