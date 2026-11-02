import type { DeploymentEnvironmentDetailV1, DeploymentMachineReviewV1,
    OwnServerDeploymentInputBasisV1 } from '@happier-dev/deployment-protocol/v1';
import type { NativeComposeRuntimeReview } from '@/workspaces/projectSetup/nativeComposeReview';
import { projectDeploymentDowntimeClassV1, projectDeploymentReviewRevisionV1 } from '@happier-dev/deployment-protocol/v1';

/** Project admitted facts only. Never forward a stored document, binding source or secret value. */
export function projectOwnServerDeploymentReview(input: Readonly<{
    machineId: string;
    environment: DeploymentEnvironmentDetailV1;
    inputBasis: OwnServerDeploymentInputBasisV1;
    servingReceipt: import('./ownServerDeploymentTarget').OwnServerDeploymentReceipt | null;
    nativeReview: NativeComposeRuntimeReview;
    storage?: Readonly<{ warnings: readonly Readonly<NonNullable<DeploymentMachineReviewV1['storage']>['warnings'][number]>[] }>;
    target: DeploymentMachineReviewV1['target'];
    commitSubject?: string;
}>): DeploymentMachineReviewV1 {
    const { environment, inputBasis, servingReceipt } = input;
    const downtime = projectDeploymentDowntimeClassV1(environment.content.ownServer?.rollout, servingReceipt !== null);
    const secretBindingNames = [...new Set(inputBasis.bindings.flatMap(binding => binding.purpose === 'variable'
        && binding.source.kind === 'secret' && (binding.phase === 'runtime' || inputBasis.buildServices?.length)
        ? [binding.name] : []))];
    return { ...input.nativeReview, machineId: input.machineId,
        ...(inputBasis.health ? { health: inputBasis.health } : {}),
        environment: { id: environment.environment.id, name: environment.content.name,
            ...(environment.content.ingress ? { ingress: environment.content.ingress } : {}) },
        revision: projectDeploymentReviewRevisionV1(inputBasis.sourceIntent, input.commitSubject),
        replaces: servingReceipt ? { deploymentId: servingReceipt.deployment.id,
            revision: projectDeploymentReviewRevisionV1(servingReceipt.content.sourceIntent, servingReceipt.content.commitSubject) } : null,
        secretBindingNames,
        ...(downtime ? { downtime } : {}),
        rollbackStorage: { keepPreviousDeployments: environment.content.retainPreviousDeployments },
        ...(input.storage ? { storage: { warnings: [...input.storage.warnings] } } : {}),
        ...(environment.content.ownServer ? { ownServer: environment.content.ownServer } : {}),
        target: input.target };
}
