import { DeploymentDomainAddAdmissionInputV1Schema, DeploymentDomainRemoveAdmissionInputV1Schema,
    DeploymentDomainTransitionInputV1Schema, DeploymentDomainPreparedContentInputV1Schema, isDeploymentDomainChildActionIdV1,
    type DeploymentDomainAddAdmissionInputV1, type DeploymentDomainRemoveAdmissionInputV1,
    type DeploymentDomainTransitionInputV1, type DeploymentDomainPreparedContentInputV1,
    deploymentChildEffectActionIdForRootV1 } from '@happier-dev/protocol';
import type { ExternalActionExecutionAuthorizationBindingV1, ReviewedActionChildHttpProofV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { projectDeploymentNativeAdmissionV1, isDeploymentDomainNativeAdmissionV1,
    matchesDeploymentDomainPreparedInputV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { isDeploymentDomainAddActionIdV1, isDeploymentDomainRemoveActionIdV1, isDeploymentMembershipActionIdV1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { EnvironmentSecretLaunchAdmissionInputV1Schema, type EnvironmentSecretLaunchAdmissionInputV1 } from '@happier-dev/deployment-protocol';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';

export type DomainHttpPurpose = Readonly<{ kind: 'transition'; input: DeploymentDomainTransitionInputV1 }>
    | Readonly<{ kind: 'secret-facts'; input: EnvironmentSecretLaunchAdmissionInputV1;
        materialization: Extract<EnvironmentSecretLaunchAdmissionInputV1['materialization'], { kind: 'domain' }> }>
    | Readonly<{ kind: 'prepared-content'; input: DeploymentDomainPreparedContentInputV1 }>
    | Readonly<{ kind: 'admission'; input: DeploymentDomainAddAdmissionInputV1 | DeploymentDomainRemoveAdmissionInputV1 }>;

/** The installed controller may submit only the existing Domain owner's typed operations. */
export function readExternalActionDeploymentDomainPurpose(binding: ExternalActionExecutionAuthorizationBindingV1,
    effectActionId: string, proof: Readonly<{ method: string; path: string; body: unknown; routeInput?: unknown; reviewedChild?: ReviewedActionChildHttpProofV1 }>,
): DomainHttpPurpose | null {
    const reviewedCreate = binding.actionId !== effectActionId && isDeploymentDomainAddActionIdV1(effectActionId)
        && proof.reviewedChild?.actionId === effectActionId
        && deploymentChildEffectActionIdForRootV1(binding.actionId, binding.deploymentPreparationAdmission, effectActionId) === effectActionId;
    const teardownRemoval = binding.actionId === 'deployments.teardown'
        && isDeploymentDomainRemoveActionIdV1(effectActionId)
        && deploymentChildEffectActionIdForRootV1(binding.actionId, binding.deploymentPreparationAdmission, effectActionId) === effectActionId;
    const membershipAdd = isDeploymentMembershipActionIdV1(binding.actionId, binding.deploymentPreparationAdmission)
        && isDeploymentDomainAddActionIdV1(effectActionId);
    if ((!isDeploymentDomainChildActionIdV1(binding.actionId) || effectActionId !== binding.actionId) && !reviewedCreate && !teardownRemoval && !membershipAdd
        || proof.method.toUpperCase() !== 'POST'
        || proof.routeInput !== undefined && !sameStrictJsonValue(proof.routeInput, proof.body)) return null;
    const projection = reviewedCreate ? proof.reviewedChild?.deploymentNativeAdmission : binding.deploymentNativeAdmission;
    const admitted = isDeploymentDomainNativeAdmissionV1(projection) ? projection : null;
    if (admitted && admitted.actionId !== effectActionId || !admitted && !reviewedCreate && !teardownRemoval && !membershipAdd) return null;
    const secret = EnvironmentSecretLaunchAdmissionInputV1Schema.safeParse(proof.body);
    if (isDeploymentDomainAddActionIdV1(effectActionId) && (admitted || membershipAdd) && secret.success
        && secret.data.materialization.kind === 'domain' && secret.data.materialization.use === undefined
        && secret.data.serverId === binding.serverIdentityId
        && secret.data.machineId === binding.machineId && secret.data.installationId === binding.installationId
        && (admitted ? secret.data.environmentId === admitted.environmentId && secret.data.materialization.domainId === admitted.domainId : membershipAdd)
        && (binding.environmentId === undefined || binding.environmentId === secret.data.environmentId)
        && secret.data.targetLinkId === secret.data.materialization.capture.placement.targetLinkId
        && proof.path === `/v1/deployments/environments/${encodeURIComponent(secret.data.environmentId)}/secret-launch-admission`) {
        return { kind: 'secret-facts', input: secret.data, materialization: secret.data.materialization };
    }
    const matchesOriginalInput = (input: DeploymentDomainAddAdmissionInputV1 | DeploymentDomainRemoveAdmissionInputV1) => {
        const { actionOperationId: _operation, requestId: _request, ...original } = input;
        const candidates: Readonly<Record<string, unknown>>[] = [original];
        if ('placements' in original) {
            const { placements: _derivedPlacements, ...withoutPlacements } = original;
            candidates.push(withoutPlacements);
        }
        if (admitted?.authoredMetadataDigest !== undefined) {
            return 'authoredInputDigest' in original && original.authoredInputDigest === admitted.inputDigest
                && matchesDeploymentDomainPreparedInputV1(input, { ...binding, deploymentNativeAdmission: admitted,
                    ...(reviewedCreate && proof.reviewedChild ? { reviewedChild: proof.reviewedChild } : {}) });
        }
        if ('authoredInputDigest' in original) return false;
        return candidates.some(candidate => {
            const projected = projectDeploymentNativeAdmissionV1(effectActionId, candidate);
            return isDeploymentDomainNativeAdmissionV1(projected) && projected.inputDigest === admitted?.inputDigest;
        });
    };
    const transition = DeploymentDomainTransitionInputV1Schema.safeParse(proof.body);
    if (transition.success && transition.data.serverId === binding.serverIdentityId
        && (admitted ? transition.data.domainId === admitted.domainId && transition.data.environmentId === admitted.environmentId : reviewedCreate || teardownRemoval || membershipAdd)
        && (binding.environmentId === undefined || binding.environmentId === transition.data.environmentId)
        && proof.path === `/v1/deployments/environments/${encodeURIComponent(transition.data.environmentId)}/domains/${encodeURIComponent(transition.data.domainId)}/transitions`) {
        return { kind: 'transition', input: transition.data };
    }
    if (effectActionId === 'deployments.domains.add') {
        const prepared = DeploymentDomainPreparedContentInputV1Schema.safeParse(proof.body);
        if (prepared.success && prepared.data.serverId === binding.serverIdentityId
            && (admitted ? prepared.data.domainId === admitted.domainId && prepared.data.environmentId === admitted.environmentId : reviewedCreate || membershipAdd)
            && (binding.environmentId === undefined || binding.environmentId === prepared.data.environmentId)
            && proof.path === `/v1/deployments/environments/${encodeURIComponent(prepared.data.environmentId)}/domains/${encodeURIComponent(prepared.data.domainId)}/prepared-content`) {
            return { kind: 'prepared-content', input: prepared.data };
        }
        const input = DeploymentDomainAddAdmissionInputV1Schema.safeParse(proof.body);
        const membership = membershipAdd && input.success && input.data.membershipDeploymentId !== undefined;
        if (reviewedCreate && admitted?.authoredMetadataDigest === undefined && !membership) return null;
        return input.success && input.data.serverId === binding.serverIdentityId && input.data.requestId === binding.requestId
            && (membership || matchesOriginalInput(input.data))
            && (binding.environmentId === undefined || binding.environmentId === input.data.environmentId)
            && proof.path === `/v1/deployments/environments/${encodeURIComponent(input.data.environmentId)}/domains`
            ? { kind: 'admission', input: input.data } : null;
    }
    if (binding.actionId === 'deployments.domains.remove') {
        const input = DeploymentDomainRemoveAdmissionInputV1Schema.safeParse(proof.body);
        return input.success && input.data.serverId === binding.serverIdentityId && input.data.requestId === binding.requestId
            && matchesOriginalInput(input.data)
            && (binding.environmentId === undefined || binding.environmentId === input.data.environmentId)
            && proof.path === `/v1/deployments/environments/${encodeURIComponent(input.data.environmentId)}/domains/${encodeURIComponent(input.data.domainId)}/remove`
            ? { kind: 'admission', input: input.data } : null;
    }
    return null;
}
