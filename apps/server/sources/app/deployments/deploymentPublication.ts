import { markAccountsChanged } from '@/app/changes/markAccountChanged';
import { lockMachinePublicationInTx } from '@/app/machines/machineAccess';
import { getDbProviderFromEnv, resolveDbSqlDialect } from '@/config/databaseProvider';
import type { Tx } from '@/storage/inTx';
import type { DeploymentSourceAdmission } from './deploymentAdmission';
import { buildDeploymentAccountChangeV1 } from '@happier-dev/protocol';
import { buildDeploymentReceiptCompletionWakeV1, type DeploymentReceiptCompletionV1 } from '@happier-dev/protocol/plugins/events/hostReferencesV1';
import { resolveProjectSourceAudienceInTx } from '@/app/projects/sources/projectSourceService';
import { readMachineAudienceAccountIdsForMachinesInTx } from '@/app/machines/machineRecipientWork';

function readDeploymentTelemetryMachineAudiencesInTx(tx: Tx, machineIds: readonly (string | null)[]) {
    return readMachineAudienceAccountIdsForMachinesInTx(tx, machineIds.filter((id): id is string => id !== null));
}

export async function readDeploymentTelemetryPublicationAccountIdsInTx(tx: Tx, machineIds: readonly (string | null)[]): Promise<string[]> {
    const audiences = await readDeploymentTelemetryMachineAudiencesInTx(tx, machineIds);
    return [...audiences.values()].flat();
}

export const clearedDeploymentTelemetryPendingAssignment = {
    telemetryPendingTokenHash: null,
    telemetryPendingTargetLinkId: null,
    telemetryPendingTargetLinkRevision: null,
} as const;

export class DeploymentTelemetryAssignmentConflictError extends Error {
    constructor() {
        super('The collector already has this bearer assigned to another Environment');
    }
}

/** The caller holds the Environment lock and has admitted this collector selection. */
export async function stampDeploymentTelemetryAssignmentInTx(tx: Tx, environmentId: string,
    stamp: Readonly<{ machineId: string; tokenHash: string }>): Promise<void> {
    // Environment locks do not serialize stamps from other Environments. Use the
    // collector's Machine row so the duplicate lookup and stamp commit together.
    const dialect = resolveDbSqlDialect(getDbProviderFromEnv(process.env, 'postgres'));
    if (dialect === 'mysql') {
        await tx.$queryRawUnsafe('SELECT `id` FROM `Machine` WHERE `id` = ? FOR UPDATE', stamp.machineId);
    } else {
        await lockMachinePublicationInTx(tx, stamp.machineId);
    }
    const duplicate = await tx.deploymentEnvironment.findFirst({
        where: { id: { not: environmentId }, telemetryMachineId: stamp.machineId, telemetryTokenHash: stamp.tokenHash,
            deletedAt: null },
        select: { id: true },
    });
    // Throw inside the transaction to roll back the Link or Receipt write.
    if (duplicate) throw new DeploymentTelemetryAssignmentConflictError();
    const changed = await tx.deploymentEnvironment.updateMany({ where: { id: environmentId, telemetryMachineId: stamp.machineId },
        data: { telemetryTokenHash: stamp.tokenHash } });
    if (changed.count !== 1) throw new Error('Locked deployment telemetry collector changed during assignment write');
}

/** Assignment changes invalidate the existing Machine projection for every affected collector audience. */
export async function publishDeploymentTelemetryMachinesInTx(tx: Tx, machineIds: readonly (string | null)[]): Promise<void> {
    for (const [id, accountIds] of await readDeploymentTelemetryMachineAudiencesInTx(tx, machineIds)) {
        await markAccountsChanged(tx, { accountIds, kind: 'machine', entityId: id });
    }
}

/** Source-admitted ids and revisions are the complete public invalidation; private content stays in Artifacts. */
export async function publishDeploymentChangesInTx(tx: Tx, admission: Pick<DeploymentSourceAdmission, 'source'>, environmentId: string,
    revision: number, deploymentId?: string, activityChanged = false, knownAccountIds?: readonly string[],
    completion: DeploymentReceiptCompletionV1 | null = null): Promise<void> {
    const accountIds = knownAccountIds ?? await resolveProjectSourceAudienceInTx(tx, [admission.source]);
    await markAccountsChanged(tx, { accountIds, ...buildDeploymentAccountChangeV1({ projectSourceId: admission.source.id, environmentId, revision,
        ...(deploymentId ? { deploymentId } : {}) }),
        ...(deploymentId ? { wakeEntityId: buildDeploymentReceiptCompletionWakeV1(environmentId, deploymentId, completion) } : {}),
    });
    if (activityChanged) await markAccountsChanged(tx, { accountIds, ...buildDeploymentAccountChangeV1({
        projectSourceId: admission.source.id, environmentId, revision, activityChanged: true,
    }) });
}
