import { z } from '../zodRuntimePolicy.js';
import { DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1 } from '../artifacts/deploymentArtifactKindsV1.js';
import { DeploymentTargetLinkProviderContentV1Schema } from '../plugins/contributions/deploymentTargetRolesV1.js';
import { DeploymentIdentifierV1Schema as id } from './deploymentIdentifiersV1.js';
import { readDeploymentArtifactContentV1, type DeploymentArtifactContentReferenceV1,
    type DeploymentArtifactDocumentV1, type DeploymentArtifactReadResultV1 } from './deploymentArtifactContentReferenceV1.js';

/** Target-host capture only; Machine and installation identity stay on link membership. */
export const DeploymentNativeComposeOriginV1Schema = z.strictObject({
    projectName: z.string().check(z.minLength(1)),
    dockerEndpoint: z.string().check(z.minLength(1)),
    workingDirectory: z.string().check(z.minLength(1)),
    capture: z.optional(z.strictObject({ installationId: id,
    })),
});
export type DeploymentNativeComposeOriginV1 = z.infer<typeof DeploymentNativeComposeOriginV1Schema>;
export const DeploymentOwnServerTargetLinkContentV1Schema = z.strictObject({
    nativeOrigin: z.optional(DeploymentNativeComposeOriginV1Schema),
});
export type DeploymentOwnServerTargetLinkContentV1 = z.infer<typeof DeploymentOwnServerTargetLinkContentV1Schema>;
export const DeploymentTargetLinkContentV1Schema = z.extend(DeploymentOwnServerTargetLinkContentV1Schema,
    z.partial(DeploymentTargetLinkProviderContentV1Schema).shape,
).check(z.refine(content => content.credentialPrincipal === undefined && content.providerEnvironment === undefined
    && content.repositoryAccess === undefined || content.credentialPrincipal !== undefined
        && content.providerEnvironment !== undefined && content.providerIdentity !== undefined,
{ message: 'Operational platform links require the complete recorded principal, identity and native scope.' }));
export type DeploymentTargetLinkContentV1 = z.infer<typeof DeploymentTargetLinkContentV1Schema>;

export function readDeploymentTargetLinkArtifactV1(reference: DeploymentArtifactContentReferenceV1, artifact: DeploymentArtifactDocumentV1 | null): DeploymentArtifactReadResultV1<z.infer<typeof DeploymentTargetLinkContentV1Schema>> {
    return readDeploymentArtifactContentV1(reference, artifact, DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1, DeploymentTargetLinkContentV1Schema);
}
