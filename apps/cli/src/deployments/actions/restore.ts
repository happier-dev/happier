import { isDeepStrictEqual } from 'node:util';
import type { ActionExecutorContext, ActionExecuteFailure, ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions';
import { DeploymentBackupRestoreInputV1Schema, DeploymentBackupRestoreResultV1Schema,
    DeploymentRestoreStepV1Schema, DeploymentBackupRunResultV1Schema, readDeploymentBackupMaintenanceFailureEvidenceV1,
    type DeploymentBackupRestoreInputV1, type DeploymentBackupRestoreResultV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { normalizeStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { isRecord } from '@happier-dev/protocol/inputs/inputRecords';
import { readInstallationIdentityIfExistsSync } from '@/daemon/identity/store';
import type { OwnServerDeploymentTargetForHost } from '../targets/ownServer/ownServerDeploymentTarget';
import { OwnServerRestorePreparationForHostSchema } from '../targets/ownServer/restorePreparation';
import type { HostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { DEPLOYMENT_BACKUP_RUN_ACTION_ID_V1, DEPLOYMENT_BACKUP_RESTORE_ACTION_ID_V1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { projectDeploymentFailure } from '../deploymentFailure';

const failure = (errorCode: string): ActionExecuteFailure => ({ ok: false, errorCode, error: errorCode });

/** Public restore uses the retained prepare Action and the incumbent native
 * lifecycle. No caller-supplied native evidence or separate prepared-token store. */
export function createDeploymentRestoreActionForHost(host: Readonly<{
    serverId: string;
    machineId: string;
    assertCurrent(context: ActionExecutorContext): Promise<void>;
    readPreparation?(operationId: string, context: ActionExecutorContext): Promise<ActionOperationSnapshotV1 | null>;
    readBackupOperations?(target: Parameters<HostActionOperationRuntime['readDeploymentBackupOperations']>[0]['target'],
        context: ActionExecutorContext): ReturnType<HostActionOperationRuntime['readDeploymentBackupOperations']>;
    restore: OwnServerDeploymentTargetForHost['restore'];
}>): (input: DeploymentBackupRestoreInputV1, context: ActionExecutorContext) => Promise<DeploymentBackupRestoreResultV1 | ActionExecuteFailure> {
    return async (input, context) => {
        try {
            await host.assertCurrent(context);
            if (input.serverId !== host.serverId || input.machineId !== host.machineId
                || readInstallationIdentityIfExistsSync()?.installationId !== input.installationId) return failure('target_mismatch');
            const acceptance = context.operationAcceptance;
            if (!acceptance || acceptance.actionId !== DEPLOYMENT_BACKUP_RESTORE_ACTION_ID_V1) return failure('service_operation_unavailable');
            if (input.mode === 'prepare') {
                let backup: Parameters<typeof host.restore>[0]['backup'];
                if (input.backupOperationId) {
                    const operations = await host.readBackupOperations?.({ ...input, ...input.copy?.source }, context);
                    if (!operations) return failure('service_operation_unavailable');
                    const selected = operations.find(({ snapshot }) => snapshot.operationId === input.backupOperationId
                        && snapshot.actionId === DEPLOYMENT_BACKUP_RUN_ACTION_ID_V1 && snapshot.state === 'succeeded');
                    const result = DeploymentBackupRunResultV1Schema.safeParse(selected?.snapshot.result);
                    const manifest = result.success && result.data.operationId === input.backupOperationId
                        ? result.data.manifests.find(item => item.snapshot.snapshotId === input.restoreBackupId) : undefined;
                    if (!manifest) return failure('backup_required');
                    const capture = result.success ? result.data.restoreCaptures?.find(item =>
                        isDeepStrictEqual(item.source, manifest)) : undefined;
                    backup = { manifest, ...(capture ? { capture } : {}) };
                }
                const result = await host.restore({ input, context, ...(backup ? { backup } : {}) });
                if (result.kind !== 'prepared') return failure('restore_prepare_required');
                return { kind: 'prepared', operationId: acceptance.operationId,
                    ...(result.prepared.steps ? { steps: [...result.prepared.steps] } : {}),
                    evidence: normalizeStrictJsonValue({ input, native: { prepared: result.prepared, configuration: result.configuration } }) };
            }
            const operation = await host.readPreparation?.(input.prepareOperationId, context);
            const result = DeploymentBackupRestoreResultV1Schema.safeParse(operation?.result);
            if (operation?.actionId !== DEPLOYMENT_BACKUP_RESTORE_ACTION_ID_V1 || operation.state !== 'succeeded'
                || !result.success || result.data.kind !== 'prepared' || result.data.operationId !== input.prepareOperationId) {
                return failure('restore_prepare_required');
            }
            const evidence = result.data.evidence;
            if (!isRecord(evidence)) return failure('restore_prepare_required');
            const original = DeploymentBackupRestoreInputV1Schema.safeParse(evidence.input);
            const { prepareOperationId: _prepareOperationId, ...operands } = input;
            if (!original.success || original.data.mode !== 'prepare'
                || !isDeepStrictEqual(original.data, { ...operands, mode: 'prepare' })) return failure('stale_input');
            const native = OwnServerRestorePreparationForHostSchema.safeParse(evidence.native);
            if (!native.success || native.data.prepared.operationId !== input.prepareOperationId) return failure('restore_prepare_required');
            const confirmed = await host.restore({ input, context, prepared: native.data });
            if (confirmed.kind === 'prepared') return failure('restore_prepare_required');
            return DeploymentBackupRestoreResultV1Schema.parse({ kind: confirmed.kind,
                steps: confirmed.steps,
                verified: confirmed.verified, nextAction: confirmed.nextAction, evidence: normalizeStrictJsonValue(confirmed) });
        } catch (error) {
            const code = error instanceof Error && 'code' in error && typeof error.code === 'string'
                ? error.code : 'deployment_unavailable';
            const details = error && typeof error === 'object' && 'details' in error ? error.details : undefined;
            const steps = isRecord(details) && Array.isArray(details.steps)
                ? details.steps.flatMap(value => {
                    const step = DeploymentRestoreStepV1Schema.safeParse(value);
                    return step.success ? [step.data] : [];
                }) : [];
            const projected = projectDeploymentFailure(context.signal?.aborted ? 'cancelled' : code, error, 'deployment.restore');
            const nativeFailure = readDeploymentBackupMaintenanceFailureEvidenceV1(error)?.nativeFailure;
            return { ...projected, ...(steps.length || nativeFailure ? {
                details: { ...(isRecord(projected.details) ? projected.details : {}), steps,
                    ...(nativeFailure ? { nativeFailure } : {}) },
            } : {}) };
        }
    };
}
