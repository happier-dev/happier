import type { DeploymentEnvironmentDetailV1 } from '@happier-dev/deployment-protocol';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { projectDeploymentFailureRecoveryV1 } from '@happier-dev/protocol/deployments/deploymentFailureRecoveryV1';
import { OWN_SERVER_DEPLOYMENT_TARGET_V1, readDeploymentTargetV1 } from '../deploymentTargetCatalog';

export { admitDeploymentSourceIntent as admitOwnServerDeploymentSource } from '@/deployments/deploymentSourceAdmission';

/** Preparation requires the Environment's configured builder; it never selects one. */
export function requireOwnServerDeploymentBuildMachine(buildMachineId: string | null | undefined): string {
    if (buildMachineId) return buildMachineId;
    const errorCode = 'required_fact_unavailable';
    const failure: ActionExecuteFailure = { ok: false, errorCode, error: errorCode, effectAttempted: false,
        details: projectDeploymentFailureRecoveryV1({ requiredFact: 'buildMachineId' }, errorCode) };
    throw Object.assign(new Error(errorCode, { cause: failure }), { code: errorCode });
}

export function admitOwnServerDeploymentTargetSource(
    link: DeploymentEnvironmentDetailV1['targetLinks'][number]['targetLink'],
): void {
    const target = readDeploymentTargetV1(link.source);
    if (target !== OWN_SERVER_DEPLOYMENT_TARGET_V1 || link.targetKind !== target.targetKind)
        throw Object.assign(new Error('target_mismatch'), { code: 'target_mismatch' });
}

/** One placement decision for candidate preparation and admitted member execution.
 * A separate controller/builder is admitted by its current Environment role;
 * only a mounted ordered dispatcher can coordinate a multi-member effect. */
export function admitOwnServerDeploymentTargetLink(
    link: DeploymentEnvironmentDetailV1['targetLinks'][number]['targetLink'],
    machineId: string,
    admittedCoordinatorMachineId?: string,
): void {
    const refuse = (code: string): never => { throw Object.assign(new Error(code), { code }); };
    admitOwnServerDeploymentTargetSource(link);
    if (!link.members.some(member => member.machineId === machineId) && admittedCoordinatorMachineId !== machineId) refuse('target_mismatch');
    if (link.members.length !== 1 && admittedCoordinatorMachineId === undefined) refuse('unsupported');
}
