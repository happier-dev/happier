import type { DeploymentPromoteAdmissionInputV1 } from '@happier-dev/protocol';
import type { Tx } from '@/storage/inTx';
import { canDeployDeploymentEnvironment, canPromoteToDeploymentEnvironment, deploymentFailure, type DeploymentAuthentication } from './deploymentAdmission';
import { loadDeploymentEnvironmentInTx, lockDeploymentEnvironmentInTx } from './deploymentEnvironmentService';
import { createDeploymentInTx } from './deploymentService';
import type { ExternalActionExecutionAuthorizationBindingV1 } from '@happier-dev/protocol/actions/externalActionApi';

/** Admit source provenance; the receipt owner commits the candidate only after destination admission. */
export async function promoteDeploymentInTx(tx: Tx, actorAccountId: string, input: DeploymentPromoteAdmissionInputV1,
    authentication: DeploymentAuthentication = {},
    executionBinding?: ExternalActionExecutionAuthorizationBindingV1,
) {
    await lockDeploymentEnvironmentInTx(tx, input.environmentId);
    if (input.sourceEnvironmentId === input.environmentId) return deploymentFailure('deployment_invalid');
    const source = await loadDeploymentEnvironmentInTx(tx, actorAccountId, input.serverId, input.sourceEnvironmentId, authentication);
    if (!source.ok) return source;
    if (!canDeployDeploymentEnvironment(source.admission, source.row)) {
        return deploymentFailure('deployment_access_denied');
    }
    const destination = await loadDeploymentEnvironmentInTx(tx, actorAccountId, input.serverId, input.environmentId, authentication);
    if (!destination.ok) return destination;
    if (!canPromoteToDeploymentEnvironment(source.row, destination.row, destination.admission)) {
        return deploymentFailure('deployment_access_denied');
    }
    const repeated = await tx.deployment.findUnique({ where: { environmentId_requestKey: {
        environmentId: input.environmentId, requestKey: input.requestKey } } });
    if (repeated) return createDeploymentInTx(tx, actorAccountId, input, 'promote', authentication, executionBinding, destination);
    const retained = await tx.deployment.findFirst({ where: { id: input.sourceDeploymentId, environmentId: source.row.id } });
    if (!retained || (retained.state !== 'succeeded' && retained.state !== 'running_unverified')) return deploymentFailure('deployment_conflict');
    return createDeploymentInTx(tx, actorAccountId, input, 'promote', authentication, executionBinding, destination);
}
