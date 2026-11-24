import { markAccountsChanged } from '@/app/changes/markAccountChanged';
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
