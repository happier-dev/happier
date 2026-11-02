import type { DeploymentEnvironmentDetailV1 } from '@happier-dev/deployment-protocol';
import { OWN_SERVER_DEPLOYMENT_TARGET_V1, readDeploymentTargetV1 } from '../deploymentTargetCatalog';

export { admitDeploymentSourceIntent as admitOwnServerDeploymentSource } from '@/deployments/deploymentSourceAdmission';

/** One placement decision for candidate preparation and admitted member execution.
 * A separate controller/builder is admitted by its current Environment role;
 * only a mounted ordered dispatcher can coordinate a multi-member effect. */
export function admitOwnServerDeploymentTargetLink(
    link: DeploymentEnvironmentDetailV1['targetLinks'][number]['targetLink'],
    machineId: string,
    admittedCoordinatorMachineId?: string,
): void {
    const refuse = (code: string): never => { throw Object.assign(new Error(code), { code }); };
    const target = readDeploymentTargetV1(link.source);
    if (target !== OWN_SERVER_DEPLOYMENT_TARGET_V1 || link.targetKind !== target.targetKind
        || !link.members.some(member => member.machineId === machineId) && admittedCoordinatorMachineId !== machineId) refuse('target_mismatch');
    if (link.members.length !== 1 && admittedCoordinatorMachineId === undefined) refuse('unsupported');
}
