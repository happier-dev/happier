import { markAccountsChanged } from '@/app/changes/markAccountChanged';
import type { Tx } from '@/storage/inTx';
import type { DeploymentSourceAdmission } from './deploymentAdmission';
import { buildDeploymentAccountChangeV1 } from '@happier-dev/protocol';
import { resolveProjectSourceAudienceInTx } from '@/app/projects/sources/projectSourceService';
import { readMachineAudienceAccountIdsForMachinesInTx } from '@/app/machines/machineRecipientWork';

/** Assignment changes invalidate the existing Machine projection for every affected collector audience. */
export async function publishDeploymentTelemetryMachinesInTx(tx: Tx, machineIds: readonly (string | null)[]): Promise<void> {
    const ids = [...new Set(machineIds.filter((id): id is string => id !== null))];
    const audiences = await readMachineAudienceAccountIdsForMachinesInTx(tx, ids);
    for (const id of ids) {
        await markAccountsChanged(tx, { accountIds: audiences.get(id) ?? [], kind: 'machine', entityId: id });
    }
}

/** Source-admitted ids and revisions are the complete public invalidation; private content stays in Artifacts. */
export async function publishDeploymentChangesInTx(tx: Tx, admission: Pick<DeploymentSourceAdmission, 'source'>, environmentId: string,
    revision: number, deploymentId?: string, activityChanged = false, knownAccountIds?: readonly string[]): Promise<void> {
    const accountIds = knownAccountIds ?? await resolveProjectSourceAudienceInTx(tx, [admission.source]);
    await markAccountsChanged(tx, { accountIds, ...buildDeploymentAccountChangeV1({ projectSourceId: admission.source.id, environmentId, revision,
        ...(deploymentId ? { deploymentId } : {}) }) });
    if (activityChanged) await markAccountsChanged(tx, { accountIds, ...buildDeploymentAccountChangeV1({
        projectSourceId: admission.source.id, environmentId, revision, activityChanged: true,
    }) });
}
