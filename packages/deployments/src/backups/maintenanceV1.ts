import { DeploymentBackupSnapshotV1Schema, type DeploymentBackupConfigurationV1 } from '@happier-dev/deployment-protocol';
import { isResticSnapshotBoundToManifestV1, readResticRepositoryConfigV1, readResticSnapshotsV1 } from './manifestV1.js';
import { selectResticForgetCandidatesV1 } from './retentionV1.js';
import { backupOperationFailureV1, backupOperationStepV1, executeBackupOperationStepV1,
    type DeploymentBackupReadInputV1, type DeploymentBackupVerificationV1 } from './verificationV1.js';

export type DeploymentBackupPruneInputV1 = DeploymentBackupReadInputV1 & Readonly<{
    configuration: DeploymentBackupConfigurationV1;
    /** Resolved by the host from an existing successful exact verification operation, never from Action input. */
    verification: DeploymentBackupVerificationV1;
    /** Existing unsettled restore/Move receipts own protection; there is no protection registry. */
    protectedSnapshotIds: readonly string[];
}>;
export type DeploymentBackupPruneResultV1 = Readonly<{
    kind: 'pruned' | 'kept'; removedSnapshotIds: readonly string[];
}>;
export type DeploymentBackupMaintenanceFailureEvidenceV1 = Readonly<{
    removedSnapshotIds: readonly string[]; uncertainSnapshotIds: readonly string[];
}>;

/** The Action failure presenter may disclose these native identities, never arbitrary thrown details or payloads. */
export function readDeploymentBackupMaintenanceFailureEvidenceV1(error: unknown): DeploymentBackupMaintenanceFailureEvidenceV1 | undefined {
    if (!error || typeof error !== 'object' || !('details' in error)) return undefined;
    const details = error.details;
    if (!details || typeof details !== 'object' || Array.isArray(details)
        || !('removedSnapshotIds' in details) || !('uncertainSnapshotIds' in details)) return undefined;
    const readIds = (value: unknown): string[] | undefined => {
        if (!Array.isArray(value)) return undefined;
        const ids: string[] = [];
        for (const item of value) {
            const parsed = DeploymentBackupSnapshotV1Schema.shape.snapshotId.safeParse(item);
            if (!parsed.success) return undefined;
            ids.push(parsed.data);
        }
        return ids;
    };
    const removedSnapshotIds = readIds(details.removedSnapshotIds), uncertainSnapshotIds = readIds(details.uncertainSnapshotIds);
    return removedSnapshotIds && uncertainSnapshotIds ? { removedSnapshotIds, uncertainSnapshotIds } : undefined;
}

/** Restic owns policy grouping/locking/compaction. This owner deletes only proven-owned, unprotected exact ids. */
export async function pruneDeploymentBackupsV1(input: DeploymentBackupPruneInputV1): Promise<DeploymentBackupPruneResultV1> {
    const manifest = input.verification.manifest;
    if (manifest.environmentId !== input.environmentId || manifest.configRevision !== input.configuration.configRevision) {
        return backupOperationFailureV1('stale_input', 'verification');
    }
    if (input.configuration.retention.kind === 'keepEverything') return { kind: 'kept', removedSnapshotIds: [] };
    let removedSnapshotIds: string[] = [], uncertainSnapshotIds: string[] = [];
    try {
        const config = await executeBackupOperationStepV1(input, { kind: 'config' }, 'repository');
        await backupOperationStepV1('repository', () => {
            if (readResticRepositoryConfigV1(config.stdout, config.exitCode, config.stdoutTruncated).repositoryId !== manifest.repositoryId) {
                return backupOperationFailureV1('backup_integrity_failed', 'repository');
            }
        });
        const inventory = await executeBackupOperationStepV1(input, { kind: 'snapshots', snapshotId: manifest.snapshot.snapshotId }, 'inventory');
        const snapshots = await backupOperationStepV1('inventory', () => readResticSnapshotsV1(inventory.stdout, inventory.exitCode, inventory.stdoutTruncated));
        if (!snapshots.some(snapshot => isResticSnapshotBoundToManifestV1(snapshot, manifest))) {
            return backupOperationFailureV1('backup_integrity_failed', 'verification');
        }
        const decision = await executeBackupOperationStepV1(input, { kind: 'forget', retention: input.configuration.retention, dryRun: true }, 'retention');
        const candidates = await backupOperationStepV1('retention', () => {
            if (decision.stdoutTruncated) return backupOperationFailureV1('outcome_unknown', 'retention');
            return selectResticForgetCandidatesV1({ stdout: decision.stdout, exitCode: decision.exitCode, environmentId: input.environmentId,
                protectedSnapshotIds: [manifest.snapshot.snapshotId, ...input.protectedSnapshotIds] });
        });
        if (!candidates.length) return { kind: 'kept', removedSnapshotIds: [] };
        // Candidates are native dry-run facts, not client-selected deletion operands.
        if (input.signal.aborted) return backupOperationFailureV1('cancelled', 'forget');
        uncertainSnapshotIds = candidates;
        await executeBackupOperationStepV1(input, { kind: 'forgetExact', snapshotIds: [candidates[0]!, ...candidates.slice(1)] }, 'forget');
        removedSnapshotIds = candidates;
        uncertainSnapshotIds = [];
        await executeBackupOperationStepV1(input, { kind: 'prune' }, 'prune');
        await executeBackupOperationStepV1(input, { kind: 'check' }, 'repositoryCheck');
        return { kind: 'pruned', removedSnapshotIds };
    } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'outcome_unknown';
        const step = error && typeof error === 'object' && 'step' in error && typeof error.step === 'string' ? error.step : 'retention';
        throw Object.assign(new Error(code), { code, step, details: { removedSnapshotIds, uncertainSnapshotIds } });
    }
}
