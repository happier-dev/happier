import type { ActionExecutorContext, ActionExecuteFailure, ActionExecutorDeps } from '@happier-dev/protocol/actions';
import {
    DeploymentBackupRunResultV1Schema, DeploymentBackupVerifyResultV1Schema,
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
        const completed = operations.filter(({ snapshot }) => snapshot.settledAt !== undefined)
            .sort((a, b) => b.snapshot.settledAt! - a.snapshot.settledAt!);
        const captures = completed.flatMap(({ snapshot }) => {
            if (snapshot.actionId !== 'deployments.backups.run' || snapshot.state !== 'succeeded') return [];
            const result = DeploymentBackupRunResultV1Schema.safeParse(snapshot.result);
            return result.success && result.data.operationId === snapshot.operationId
                ? [{ snapshot, manifests: result.data.manifests }] : [];
        });
        const latestBackup = captures[0];
        const verifications = completed.flatMap(({ snapshot, input: authoredInput }) => {
            if (snapshot.actionId !== 'deployments.backups.verify' || !('backupOperationId' in authoredInput)
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
            const details = snapshot.result;
            const step = details && typeof details === 'object' && !Array.isArray(details)
                && 'step' in details && typeof details.step === 'string' ? details.step : undefined;
            return [{ manifest, evidence: {
                operationId: snapshot.operationId, completedAt: snapshot.settledAt!,
                configRevision: authoredInput.configRevision, backupOperationId: authoredInput.backupOperationId,
                snapshotId: authoredInput.snapshotId, level: authoredInput.level,
                result: verified ? 'verified' as const : snapshot.state === 'cancelled' ? 'cancelled' as const : 'failed' as const,
                ...(snapshot.error ? { code: snapshot.error.errorCode } : {}), ...(step ? { step } : {}),
            } }];
        });
        const backups: DeploymentBackupRecordedHealthV1['backups'] = {
            ...(latestBackup ? { lastSuccessfulBackup: { operationId: latestBackup.snapshot.operationId,
                completedAt: latestBackup.snapshot.settledAt!, configRevision: latestBackup.manifests[0]!.configRevision,
                snapshotIds: latestBackup.manifests.map(manifest => manifest.snapshot.snapshotId) } } : {}),
            ...(verifications[0] ? { lastVerification: verifications[0].evidence } : {}),
        };
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
            if (actionId !== 'deployments.backups.inventory' && context.operationAcceptance?.actionId !== actionId) {
                return failure('service_operation_unavailable', 'admission');
            }
            if (actionId === 'deployments.backups.run') {
                const result = await host.backup({ actionId: 'deployments.backups.run', input, context });
                return DeploymentBackupActionResultSchemasV1[actionId].parse(result) as DeploymentBackupActionResultV1<TId>;
            }
            const operations = await host.readBackupOperations?.(input, context);
            if (!operations) return failure('service_operation_unavailable', 'capture');
            const captures = operations.flatMap(({ snapshot }) => {
                if (snapshot.actionId !== 'deployments.backups.run' || snapshot.state !== 'succeeded') return [];
                const parsed = DeploymentBackupRunResultV1Schema.safeParse(snapshot.result);
                return parsed.success && parsed.data.operationId === snapshot.operationId
                    ? parsed.data.manifests.map(manifest => ({ backupOperationId: snapshot.operationId, manifest })) : [];
            });
            if (actionId === 'deployments.backups.inventory') {
                const result = await host.backup({ actionId: 'deployments.backups.inventory', input, context, verificationEvidence: captures });
                return DeploymentBackupActionResultSchemasV1[actionId].parse(result) as DeploymentBackupActionResultV1<TId>;
            }
            if (actionId === 'deployments.backups.verify') {
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
            const verified = operations.slice().sort((a, b) => (b.snapshot.settledAt ?? 0) - (a.snapshot.settledAt ?? 0))
                .flatMap(({ snapshot }) => {
                    if (snapshot.actionId !== 'deployments.backups.verify' || snapshot.state !== 'succeeded') return [];
                    const proof = DeploymentBackupVerifyResultV1Schema.safeParse(snapshot.result);
                    if (!proof.success || proof.data.operationId !== snapshot.operationId
                        || proof.data.configRevision !== input.configRevision) return [];
                    const capture = captures.find(entry => entry.backupOperationId === proof.data.backupOperationId
                        && entry.manifest.snapshot.snapshotId === proof.data.snapshotId
                        && entry.manifest.repositoryId === proof.data.repositoryId
                        && entry.manifest.configRevision === proof.data.configRevision);
                    return capture ? [{ kind: 'verified' as const, level: proof.data.level, manifest: capture.manifest }] : [];
                })[0];
            if (!verified || !('retention' in input)) return failure('backup_required', 'verification');
            const completedPreparations = new Set<string>();
            for (const { snapshot, input: authoredInput } of operations) {
                if (snapshot.actionId !== 'deployments.backups.restore' || snapshot.state !== 'succeeded'
                    || !('mode' in authoredInput) || authoredInput.mode !== 'confirm') continue;
                const result = DeploymentBackupRestoreResultV1Schema.safeParse(snapshot.result);
                if (result.success && result.data.kind === 'restored' && result.data.verified && result.data.nextAction === 'none') {
                    completedPreparations.add(authoredInput.prepareOperationId);
                }
            }
            const protectedSnapshotIds = new Set<string>();
            for (const { snapshot } of operations) {
                if (snapshot.actionId !== 'deployments.backups.restore' || snapshot.state !== 'succeeded'
                    || completedPreparations.has(snapshot.operationId)) continue;
                const result = DeploymentBackupRestoreResultV1Schema.safeParse(snapshot.result);
                if (!result.success || result.data.kind !== 'prepared') continue;
                const evidence = result.data.evidence;
                if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) continue;
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
            return { ...failure(code, step), details: { step, code, ...partial } };
        }
    };
}
