import { isDeepStrictEqual } from 'node:util';
import { DEPLOYMENT_DEPLOY_ACTION_ID_V1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import type { DeploymentEnvironmentDetailV1, DeploymentOwnServerContentV1, DeploymentTargetLinkHeaderV1 } from '@happier-dev/deployment-protocol';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { projectDeploymentFailureRecoveryV1 } from '@happier-dev/protocol/deployments/deploymentFailureRecoveryV1';
import { OWN_SERVER_DEPLOYMENT_TARGET_V1, readDeploymentTargetV1 } from '../deploymentTargetCatalog';

import type { OwnServerDeploymentReceipt, OwnServerDeploymentRuntimeRequest } from './ownServerDeploymentTarget';

export { admitDeploymentSourceIntent as admitOwnServerDeploymentSource } from '@/deployments/deploymentSourceAdmission';

/** Add deploys the exact serving receipt, even when the editor now holds an undeployed change.
 * The receipt reader owns lineage; image/platform usability stays with native materialization. */
export function selectOwnServerRetainedServingSource(input: Readonly<{
    actionId: OwnServerDeploymentRuntimeRequest['actionId'];
    environmentId: string;
    link: DeploymentTargetLinkHeaderV1;
    sourceIntent: DeploymentOwnServerContentV1['sourceIntent'];
    servingReceipt: OwnServerDeploymentReceipt | null | undefined;
}>): DeploymentOwnServerContentV1['sourceIntent'] | null {
    const serving = input.servingReceipt;
    return input.actionId === DEPLOYMENT_DEPLOY_ACTION_ID_V1 && input.link.members.some(member => member.state === 'joining')
        && serving && serving.deployment.id === input.link.activeDeploymentId
        && serving.deployment.environmentId === input.environmentId
        && (serving.deployment.state === 'succeeded' || serving.deployment.state === 'running_unverified')
        && isDeepStrictEqual(input.sourceIntent, serving.content.sourceIntent)
        ? serving.content.sourceIntent : null;
}

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
