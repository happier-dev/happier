import type { DeploymentEnvironmentDetailV1, DeploymentMachineReviewV1,
    OwnServerDeploymentInputBasisV1 } from '@happier-dev/deployment-protocol/v1';
import type { NativeComposeRuntimeReview } from '@/workspaces/projectSetup/nativeComposeReview';
import { projectDeploymentDowntimeClassV1, projectDeploymentReviewRevisionV1 } from '@happier-dev/deployment-protocol/v1';
import type { DeploymentReferenceAddressV1 } from '@happier-dev/protocol/deployments/deploymentReadsV1';
import { environmentSecretBindingIdentityV1 } from '@happier-dev/protocol/deployments/storedAppInputV1';
import { projectNativeComposeBuildSupport } from '@/daemon/local/services/launch/nativeComposeImagePreparation';

function referenceAddressesByBinding(addresses: readonly DeploymentReferenceAddressV1[]) {
    const result = new Map<string, { reference: DeploymentReferenceAddressV1; address: string | null }>();
    for (const reference of addresses) {
        const key = JSON.stringify([reference.machineId, reference.installationId,
            environmentSecretBindingIdentityV1({ purpose: 'variable', phase: reference.phase, name: reference.name }),
            reference.source.environmentId, reference.source.export, reference.source.via]);
        const previous = result.get(key);
        result.set(key, { reference, address: !previous || previous.address === reference.address ? reference.address : null });
    }
    return result;
}

/** Project admitted facts only. Never forward a stored document, binding source or secret value. */
export function projectOwnServerDeploymentReview(input: Readonly<{
    machineId: string;
    environment: DeploymentEnvironmentDetailV1;
    inputBasis: OwnServerDeploymentInputBasisV1;
    servingReceipt: import('./ownServerDeploymentTarget').OwnServerDeploymentReceipt | null;
    nativeReview: NativeComposeRuntimeReview;
    referenceAddresses?: readonly DeploymentReferenceAddressV1[];
    storage?: Readonly<{ warnings: readonly Readonly<NonNullable<DeploymentMachineReviewV1['storage']>['warnings'][number]>[] }>;
    target: DeploymentMachineReviewV1['target'];
    commitSubject?: string;
    onFailure?: DeploymentMachineReviewV1['onFailure'];
}>): DeploymentMachineReviewV1 {
    const { environment, inputBasis, servingReceipt } = input;
    const downtime = projectDeploymentDowntimeClassV1(environment.content.ownServer?.rollout, servingReceipt !== null);
    const buildPlatforms = (inputBasis.servicePlatforms ?? []).filter(pair => inputBasis.buildServices?.includes(pair.service))
        .map(pair => pair.platform);
    const secretBindingNames = [...new Set(inputBasis.bindings.flatMap(binding => binding.purpose === 'variable'
        && binding.source.kind === 'secret' && (binding.phase === 'runtime' || inputBasis.buildServices?.length)
        ? [binding.name] : []))];
    const runningReferences = referenceAddressesByBinding(servingReceipt?.content.ownServer?.referenceAddresses ?? []);
    const referenceChanges = [...referenceAddressesByBinding(input.referenceAddresses ?? [])].flatMap(([key, current]) => {
        const running = runningReferences.get(key);
        return current.address !== null && running && running.address !== null && current.address !== running.address
            ? [{ name: current.reference.name, phase: current.reference.phase,
                ...(current.reference.route ? { route: current.reference.route } : {}) }] : [];
    });
    const { composeVariableNames, ...nativeReview } = input.nativeReview;
    const boundNames = new Set(inputBasis.bindings.flatMap(binding => binding.purpose === 'variable' ? [binding.name] : []));
    const usedNames = new Set(composeVariableNames);
    const variableUseWarnings = composeVariableNames === undefined ? undefined : [
        ...[...boundNames].filter(name => !usedNames.has(name)).map(name => ({ kind: 'unusedBinding' as const, name })),
        ...composeVariableNames.filter(name => !boundNames.has(name)).map(name => ({ kind: 'unboundVariable' as const, name })),
    ];
    return { ...nativeReview, machineId: input.machineId,
        ...(variableUseWarnings?.length ? { variableUseWarnings } : {}),
        ...(inputBasis.health ? { health: inputBasis.health } : {}),
        environment: { id: environment.environment.id, name: environment.content.name,
            ...(environment.content.ingress ? { ingress: environment.content.ingress } : {}) },
        revision: projectDeploymentReviewRevisionV1(inputBasis.sourceIntent, input.commitSubject),
        replaces: servingReceipt ? { deploymentId: servingReceipt.deployment.id,
            revision: projectDeploymentReviewRevisionV1(servingReceipt.content.sourceIntent, servingReceipt.content.commitSubject) } : null,
        secretBindingNames,
        ...(buildPlatforms.length ? { buildSupport: projectNativeComposeBuildSupport(buildPlatforms) } : {}),
        ...(referenceChanges.length ? { referenceChanges } : {}),
        ...(input.onFailure === undefined ? {} : { onFailure: input.onFailure }),
        ...(downtime ? { downtime } : {}),
        rollbackStorage: { keepPreviousDeployments: environment.content.retainPreviousDeployments },
        ...(input.storage ? { storage: { warnings: [...input.storage.warnings] } } : {}),
        ...(environment.content.ownServer ? { ownServer: environment.content.ownServer } : {}),
        target: input.target };
}
