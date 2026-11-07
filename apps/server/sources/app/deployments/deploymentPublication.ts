import { markAccountsChanged } from '@/app/changes/markAccountChanged';
import type { Tx } from '@/storage/inTx';
import type { DeploymentSourceAdmission } from './deploymentAdmission';
import { buildDeploymentAccountChangeV1 } from '@happier-dev/protocol';
import { resolveProjectSourceAudienceInTx } from '@/app/projects/sources/projectSourceService';

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
