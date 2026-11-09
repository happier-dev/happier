import type { ActionExecutorContext, ActionExecuteFailure, ActionExecutorDeps } from '@happier-dev/protocol/actions';
import { isRecord } from '@happier-dev/protocol/common/records';
import {
    DeploymentBackupRestoreResultV1Schema, DeploymentBackupActionResultSchemasV1,
    type DeploymentBackupActionIdV1, type DeploymentBackupActionInputV1,
    type DeploymentBackupActionResultV1,
    type DeploymentBackupInventoryInputV1,
} from '@happier-dev/protocol/deployments/deploymentActionsV1';
import type { DeploymentBackupRecordedHealthV1 } from '@happier-dev/protocol';
import type { DeploymentBackupConfigurationV1 } from '@happier-dev/deployment-protocol';
import { readInstallationIdentityIfExistsSync } from '@/daemon/identity/store';
import { readDeploymentBackupMaintenanceFailureEvidenceV1 } from '@happier-dev/deployments';
import type { HostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import type { OwnServerDeploymentTargetForHost } from '../targets/ownServer/ownServerDeploymentTarget';
import { OwnServerRestorePreparationForHostSchema } from '../targets/ownServer/restorePreparation';
import { projectDeploymentBackupHistory } from './backupHistory';
import { projectDeploymentFailure } from '../deploymentFailure';
import { isDeploymentBackupReadActionIdV1, DEPLOYMENT_BACKUP_RUN_ACTION_ID_V1, DEPLOYMENT_BACKUP_TEST_ACTION_ID_V1,
    DEPLOYMENT_BACKUP_HISTORY_ACTION_ID_V1, DEPLOYMENT_BACKUP_INVENTORY_ACTION_ID_V1, DEPLOYMENT_BACKUP_VERIFY_ACTION_ID_V1,
    DEPLOYMENT_BACKUP_RESTORE_ACTION_ID_V1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';

const failure = (code: string, step: string): ActionExecuteFailure => ({
    ok: false, errorCode: code, error: code, details: { step, code },
});

/** Read the incumbent operation receipts only. Scheduled verification owns freshness; this
 * projection neither acquires repository credentials nor executes a native backup Action. */
export function createDeploymentBackupRecordedHealthForHost(host: Readonly<{
    machineId: string;
    readBackupOperations?(target: Parameters<HostActionOperationRuntime['readDeploymentBackupOperations']>[0]['target'],
        context: ActionExecutorContext): ReturnType<HostActionOperationRuntime['readDeploymentBackupOperations']>;
}>) {
    return async (input: DeploymentBackupInventoryInputV1, configuration: DeploymentBackupConfigurationV1,
        context: ActionExecutorContext): Promise<DeploymentBackupRecordedHealthV1 | ActionExecuteFailure> => {
        // The incumbent operation authority is daemon-local. A controller cannot infer
        // an empty history for a different target whose receipts it cannot reach.
        if (input.machineId !== host.machineId) return failure('service_operation_unavailable', 'capture');
        const operations = await host.readBackupOperations?.(input, context);
        if (!operations) return failure('service_operation_unavailable', 'capture');
        const { backups, captures, verifications } = projectDeploymentBackupHistory(operations);
        const latestBackup = captures[0];
        const allVerified = configuration.sources.every(source => {
            const capture = captures.find(item => item.manifests.some(manifest => manifest.sourceId === source.sourceId
                && manifest.kind === source.kind && manifest.configRevision === configuration.configRevision));
            const latest = verifications.find(item => item.manifest?.sourceId === source.sourceId
                && item.manifest.kind === source.kind && item.evidence.configRevision === configuration.configRevision);
            return capture && latest?.evidence.result === 'verified'
                && latest.evidence.backupOperationId === capture.snapshot.operationId;
        });
        return { status: allVerified ? 'ready' : 'actionNeeded',
            reason: allVerified ? 'configured_sources_verified' : !latestBackup ? 'no_verified_backup_yet' : 'backup_verification_required',
            backups };
    };
}

/** Public calls consume the incumbent operation's exact scoped capture and verification evidence.
 * No preparation Action, backup index, credential value or caller-provided manifest is introduced. */
export function createDeploymentBackupActionForHost(host: Readonly<{
    serverId: string;
    machineId: string;
    assertCurrent(context: ActionExecutorContext): Promise<void>;
    readBackupOperations?(target: Parameters<HostActionOperationRuntime['readDeploymentBackupOperations']>[0]['target'],
        context: ActionExecutorContext): ReturnType<HostActionOperationRuntime['readDeploymentBackupOperations']>;
    backup: OwnServerDeploymentTargetForHost['backup'];
}>): NonNullable<ActionExecutorDeps['deploymentBackupAction']> {
    return async <TId extends DeploymentBackupActionIdV1>(actionId: TId, input: DeploymentBackupActionInputV1<TId>,
        context: ActionExecutorContext): Promise<DeploymentBackupActionResultV1<TId> | ActionExecuteFailure> => {
        try {
            await host.assertCurrent(context);
            if (input.serverId !== host.serverId || input.machineId !== host.machineId
                || readInstallationIdentityIfExistsSync()?.installationId !== input.installationId) return failure('target_mismatch', 'admission');
            if (!isDeploymentBackupReadActionIdV1(actionId) && context.operationAcceptance?.actionId !== actionId) {
                return failure('service_operation_unavailable', 'admission');
            }
            if (actionId === DEPLOYMENT_BACKUP_RUN_ACTION_ID_V1) {
                const result = await host.backup({ actionId: 'deployments.backups.run', input, context });
                return DeploymentBackupActionResultSchemasV1[actionId].parse(result) as DeploymentBackupActionResultV1<TId>;
            }
            if (actionId === DEPLOYMENT_BACKUP_TEST_ACTION_ID_V1) {
                const result = await host.backup({ actionId: 'deployments.backups.test', input, context });
                return DeploymentBackupActionResultSchemasV1[actionId].parse(result) as DeploymentBackupActionResultV1<TId>;
            }
            const operations = await host.readBackupOperations?.(input, context);
            if (!operations) return failure('service_operation_unavailable', 'capture');
            const recorded = projectDeploymentBackupHistory(operations);
            if (actionId === DEPLOYMENT_BACKUP_HISTORY_ACTION_ID_V1) {
                return DeploymentBackupActionResultSchemasV1[actionId].parse({ kind: 'history',
                    environmentId: input.environmentId, configRevision: input.configRevision, ...recorded.backups }) as DeploymentBackupActionResultV1<TId>;
            }
            const captures = recorded.captures.flatMap(({ snapshot, manifests }) => manifests
                .map(manifest => ({ backupOperationId: snapshot.operationId, manifest })));
            if (actionId === DEPLOYMENT_BACKUP_INVENTORY_ACTION_ID_V1) {
                const result = await host.backup({ actionId: 'deployments.backups.inventory', input, context, verificationEvidence: captures });
                return DeploymentBackupActionResultSchemasV1[actionId].parse(result) as DeploymentBackupActionResultV1<TId>;
            }
            if (actionId === DEPLOYMENT_BACKUP_VERIFY_ACTION_ID_V1) {
                // The canonical schema narrows this generic input at the Action boundary.
                const selected = 'backupOperationId' in input && 'snapshotId' in input ? captures.find(capture =>
                    capture.backupOperationId === input.backupOperationId
                    && capture.manifest.snapshot.snapshotId === input.snapshotId
                    && capture.manifest.configRevision === input.configRevision) : undefined;
                if (!selected || !('level' in input)) return failure('backup_required', 'capture');
                const result = await host.backup({ actionId: 'deployments.backups.verify', input: { ...input,
                    backupOperationId: selected.backupOperationId, snapshotId: selected.manifest.snapshot.snapshotId,
                    level: input.level }, context, manifest: selected.manifest });
                return DeploymentBackupActionResultSchemasV1[actionId].parse(result) as DeploymentBackupActionResultV1<TId>;
            }
            const proof = recorded.verifications.find(item => item.evidence.result === 'verified'
                && item.evidence.configRevision === input.configRevision && item.manifest);
            const verified = proof?.manifest ? { kind: 'verified' as const,
                level: proof.evidence.level, manifest: proof.manifest } : undefined;
            if (!verified || !('retention' in input)) return failure('backup_required', 'verification');
            const completedPreparations = new Set<string>();
            for (const { snapshot, input: authoredInput } of operations) {
                if (snapshot.actionId !== DEPLOYMENT_BACKUP_RESTORE_ACTION_ID_V1 || snapshot.state !== 'succeeded'
                    || !('mode' in authoredInput) || authoredInput.mode !== 'confirm') continue;
                const result = DeploymentBackupRestoreResultV1Schema.safeParse(snapshot.result);
                if (result.success && result.data.kind === 'restored' && result.data.verified && result.data.nextAction === 'none') {
                    completedPreparations.add(authoredInput.prepareOperationId);
                }
            }
            const protectedSnapshotIds = new Set<string>();
            for (const { snapshot } of operations) {
                if (snapshot.actionId !== DEPLOYMENT_BACKUP_RESTORE_ACTION_ID_V1 || snapshot.state !== 'succeeded'
                    || completedPreparations.has(snapshot.operationId)) continue;
                const result = DeploymentBackupRestoreResultV1Schema.safeParse(snapshot.result);
                if (!result.success || result.data.kind !== 'prepared') continue;
                const evidence = result.data.evidence;
                if (!isRecord(evidence)) continue;
                const native = OwnServerRestorePreparationForHostSchema.safeParse(evidence.native);
                if (!native.success) continue;
                protectedSnapshotIds.add(native.data.prepared.source.snapshot.snapshotId);
                for (const manifest of native.data.prepared.safetyBackup?.manifests ?? []) {
                    protectedSnapshotIds.add(manifest.snapshot.snapshotId);
                }
            }
            const result = await host.backup({ actionId: 'deployments.backups.prune', input: { ...input,
                retention: input.retention }, context, verification: verified, protectedSnapshotIds: [...protectedSnapshotIds] });
            return DeploymentBackupActionResultSchemasV1[actionId].parse(result) as DeploymentBackupActionResultV1<TId>;
        } catch (error) {
            const code = context.signal?.aborted ? 'cancelled' : error && typeof error === 'object'
                && 'code' in error && typeof error.code === 'string' ? error.code : 'deployment_unavailable';
            const step = error && typeof error === 'object' && 'step' in error && typeof error.step === 'string'
                ? error.step : 'native';
            const partial = readDeploymentBackupMaintenanceFailureEvidenceV1(error);
            const projected = projectDeploymentFailure(code, error, `deployment.backup.${step}`);
            return { ...projected, details: { ...(isRecord(projected.details) ? projected.details : {}), step, code, ...partial } };
        }
    };
}
