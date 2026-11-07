import { isDeepStrictEqual } from 'node:util';
import type { ActionExecutorContext, ActionExecuteFailure, ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions';
import { DeploymentBackupRestoreInputV1Schema, DeploymentBackupRestoreResultV1Schema,
    type DeploymentBackupRestoreInputV1, type DeploymentBackupRestoreResultV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { normalizeStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { isRecord } from '@happier-dev/protocol/inputs/inputRecords';
import { readInstallationIdentityIfExistsSync } from '@/daemon/identity/store';
import type { OwnServerDeploymentTargetForHost } from '../targets/ownServer/ownServerDeploymentTarget';
import { OwnServerRestorePreparationForHostSchema } from '../targets/ownServer/restorePreparation';

const failure = (errorCode: string): ActionExecuteFailure => ({ ok: false, errorCode, error: errorCode });

/** Public restore uses the retained prepare Action and the incumbent native
 * lifecycle. No caller-supplied native evidence or separate prepared-token store. */
export function createDeploymentRestoreActionForHost(host: Readonly<{
    serverId: string;
    machineId: string;
    assertCurrent(context: ActionExecutorContext): Promise<void>;
    readPreparation?(operationId: string, context: ActionExecutorContext): Promise<ActionOperationSnapshotV1 | null>;
    restore: OwnServerDeploymentTargetForHost['restore'];
}>): (input: DeploymentBackupRestoreInputV1, context: ActionExecutorContext) => Promise<DeploymentBackupRestoreResultV1 | ActionExecuteFailure> {
    return async (input, context) => {
        try {
            await host.assertCurrent(context);
            if (input.serverId !== host.serverId || input.machineId !== host.machineId
                || readInstallationIdentityIfExistsSync()?.installationId !== input.installationId) return failure('target_mismatch');
            const acceptance = context.operationAcceptance;
            if (!acceptance || acceptance.actionId !== 'deployments.backups.restore') return failure('service_operation_unavailable');
            if (input.mode === 'prepare') {
                const result = await host.restore({ input, context });
                if (result.kind !== 'prepared') return failure('restore_prepare_required');
                return { kind: 'prepared', operationId: acceptance.operationId,
                    evidence: normalizeStrictJsonValue({ input, native: { prepared: result.prepared, configuration: result.configuration } }) };
            }
            const operation = await host.readPreparation?.(input.prepareOperationId, context);
            const result = DeploymentBackupRestoreResultV1Schema.safeParse(operation?.result);
            if (operation?.actionId !== 'deployments.backups.restore' || operation.state !== 'succeeded'
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
                verified: confirmed.verified, nextAction: confirmed.nextAction, evidence: normalizeStrictJsonValue(confirmed) });
        } catch (error) {
            const code = error instanceof Error && 'code' in error && typeof error.code === 'string'
                ? error.code : 'deployment_unavailable';
            return failure(context.signal?.aborted ? 'cancelled' : code);
        }
    };
}
