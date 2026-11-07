import type { DeploymentEnvironmentDeployerPrincipalV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import type { Tx } from '@/storage/inTx';
import { portableQueryChunks } from '@/storage/portableQueryChunks';
import { admitProjectSourcePrincipalSelectionInTx } from '@/app/projects/sources/projectSourcePrincipalAccess';
import type { DeploymentSourceAdmission } from './deploymentAdmission';

const key = (principal: Readonly<{ principalKind: string; principalId: string }>) => JSON.stringify([principal.principalKind, principal.principalId]);

/** Policy editing consumes the Source owner's live structural principal admission. */
export function admitDeploymentDeployerPrincipalsInTx(tx: Tx, admission: DeploymentSourceAdmission,
    principals: readonly DeploymentEnvironmentDeployerPrincipalV1[],
): Promise<boolean> {
    return admitProjectSourcePrincipalSelectionInTx(tx, { owner: admission.owner, audience: admission.source.audience,
        accountIds: principals.filter(principal => principal.principalKind === 'account').map(principal => principal.principalId),
        groupIds: principals.filter(principal => principal.principalKind === 'teamGroup').map(principal => principal.principalId) });
}

export function sameDeploymentDeployerPrincipals(
    previous: readonly Readonly<{ principalKind: string; principalId: string }>[],
    next: readonly DeploymentEnvironmentDeployerPrincipalV1[],
): boolean {
    const keys = new Set(previous.map(key));
    return keys.size === next.length && next.every(principal => keys.has(key(principal)));
}

/** Apply the selected relation delta inside the existing Environment CAS transaction, preserving retained attribution. */
export async function replaceDeploymentDeployerPrincipalsInTx(tx: Tx, environmentId: string, actorAccountId: string,
    previous: readonly Readonly<{ principalKind: string; principalId: string }>[],
    next: readonly DeploymentEnvironmentDeployerPrincipalV1[],
): Promise<void> {
    const previousKeys = new Set(previous.map(key));
    const nextKeys = new Set(next.map(key));
    const removed = previous.filter(principal => !nextKeys.has(key(principal)));
    for (const principals of portableQueryChunks({ values: removed, bindingsPerValue: 2, fixedBindings: 1 })) {
        await tx.deploymentEnvironmentDeployer.deleteMany({ where: { environmentId,
            OR: principals.map(({ principalKind, principalId }) => ({ principalKind, principalId })) } });
    }
    const added = next.filter(principal => !previousKeys.has(key(principal)));
    for (const principals of portableQueryChunks({ values: added, bindingsPerValue: 4 })) {
        await tx.deploymentEnvironmentDeployer.createMany({ data: principals.map(principal =>
            ({ ...principal, environmentId, createdByAccountId: actorAccountId })) });
    }
}
