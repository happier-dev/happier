import {
    DeploymentBackupRunResultV1Schema, DeploymentBackupVerifyResultV1Schema, DeploymentBackupPruneResultV1Schema,
    DEPLOYMENT_BACKUP_RUN_ACTION_ID_V1, DEPLOYMENT_BACKUP_VERIFY_ACTION_ID_V1, DEPLOYMENT_BACKUP_PRUNE_ACTION_ID_V1,
} from '@happier-dev/protocol/deployments/deploymentActionsV1';
import type { DeploymentBackupRecordedHealthV1 } from '@happier-dev/protocol';
import { readDeploymentBackupMaintenanceFailureEvidenceV1 } from '@happier-dev/deployments';
import type { DeploymentBackupOperation } from '@/daemon/actionOperations/actionOperationStore';

const readStep = (result: unknown): string | undefined => result && typeof result === 'object' && !Array.isArray(result)
    && 'step' in result && typeof result.step === 'string' ? result.step : undefined;

/** Both readiness and the target-host history Action consume this receipt projection.
 * Retention remains the operation store's existing policy; this is not a second ledger. */
export function projectDeploymentBackupHistory(operations: readonly DeploymentBackupOperation[]) {
    const completed = operations.filter(({ snapshot }) => snapshot.settledAt !== undefined)
        .sort((a, b) => b.snapshot.settledAt! - a.snapshot.settledAt!);
    const captures = completed.flatMap(({ snapshot }) => {
        if (snapshot.actionId !== DEPLOYMENT_BACKUP_RUN_ACTION_ID_V1 || snapshot.state !== 'succeeded') return [];
        const result = DeploymentBackupRunResultV1Schema.safeParse(snapshot.result);
        return result.success && result.data.operationId === snapshot.operationId
            ? [{ snapshot, manifests: result.data.manifests, restoreCaptures: result.data.restoreCaptures }] : [];
    });
    const verifications = completed.flatMap(({ snapshot, input: authoredInput }) => {
        if (snapshot.actionId !== DEPLOYMENT_BACKUP_VERIFY_ACTION_ID_V1 || !('backupOperationId' in authoredInput)
            || !('level' in authoredInput)) return [];
        const result = DeploymentBackupVerifyResultV1Schema.safeParse(snapshot.result);
        const verified = snapshot.state === 'succeeded' && result.success
            && result.data.operationId === snapshot.operationId
            && result.data.backupOperationId === authoredInput.backupOperationId
            && result.data.snapshotId === authoredInput.snapshotId
            && result.data.configRevision === authoredInput.configRevision;
        if (!verified && snapshot.state !== 'failed' && snapshot.state !== 'cancelled') return [];
        const capture = captures.find(item => item.snapshot.operationId === authoredInput.backupOperationId);
        const manifest = capture?.manifests.find(item => item.snapshot.snapshotId === authoredInput.snapshotId
            && item.configRevision === authoredInput.configRevision
            && (!verified || result.success && item.repositoryId === result.data.repositoryId));
        const step = readStep(snapshot.result);
        return [{ manifest, evidence: {
            operationId: snapshot.operationId, completedAt: snapshot.settledAt!,
            configRevision: authoredInput.configRevision, backupOperationId: authoredInput.backupOperationId,
            snapshotId: authoredInput.snapshotId, level: authoredInput.level,
            result: verified ? 'verified' as const : snapshot.state === 'cancelled' ? 'cancelled' as const : 'failed' as const,
            ...(snapshot.error ? { code: snapshot.error.errorCode } : {}), ...(step ? { step } : {}),
        } }];
    });
    const entries: NonNullable<DeploymentBackupRecordedHealthV1['backups']['history']>['entries'] = [];
    for (const { snapshot, input } of completed) {
        if (snapshot.state !== 'succeeded' && snapshot.state !== 'failed' && snapshot.state !== 'cancelled') continue;
        let action: 'backup' | 'verify' | 'prune';
        let snapshotIds: string[] = [];
        switch (snapshot.actionId) {
            case DEPLOYMENT_BACKUP_RUN_ACTION_ID_V1: {
                action = 'backup';
                const capture = captures.find(item => item.snapshot.operationId === snapshot.operationId);
                if (snapshot.state === 'succeeded' && !capture) continue;
                snapshotIds = capture?.manifests.map(manifest => manifest.snapshot.snapshotId) ?? [];
                break;
            }
            case DEPLOYMENT_BACKUP_VERIFY_ACTION_ID_V1: {
                action = 'verify';
                const verification = verifications.find(item => item.evidence.operationId === snapshot.operationId);
                if (!verification) continue;
                snapshotIds = [verification.evidence.snapshotId];
                break;
            }
            case DEPLOYMENT_BACKUP_PRUNE_ACTION_ID_V1: {
                action = 'prune';
                if (snapshot.state === 'succeeded') {
                    const result = DeploymentBackupPruneResultV1Schema.safeParse(snapshot.result);
                    if (!result.success || result.data.environmentId !== input.environmentId
                        || result.data.configRevision !== input.configRevision) continue;
                    snapshotIds = result.data.forgottenSnapshotIds;
                } else {
                    snapshotIds = [...(readDeploymentBackupMaintenanceFailureEvidenceV1({ details: snapshot.result })
                        ?.removedSnapshotIds ?? [])];
                }
                break;
            }
            default: continue;
        }
        const step = readStep(snapshot.result);
        entries.push({ operationId: snapshot.operationId, action, state: snapshot.state,
            configRevision: input.configRevision, startedAt: snapshot.startedAt ?? snapshot.createdAt,
            completedAt: snapshot.settledAt!, snapshotIds,
            ...(snapshot.error ? { code: snapshot.error.errorCode } : {}), ...(step ? { step } : {}) });
    }
    const latestBackup = captures[0];
    const backups: DeploymentBackupRecordedHealthV1['backups'] = {
        history: { entries },
        ...(latestBackup ? { lastSuccessfulBackup: { operationId: latestBackup.snapshot.operationId,
            completedAt: latestBackup.snapshot.settledAt!, configRevision: latestBackup.manifests[0]!.configRevision,
            snapshotIds: latestBackup.manifests.map(manifest => manifest.snapshot.snapshotId) } } : {}),
        ...(verifications[0] ? { lastVerification: verifications[0].evidence } : {}),
    };
    return { backups, captures, verifications };
}
