import { z } from 'zod/mini';
import { DeploymentArtifactContentReferenceV1Schema, readDeploymentArtifactHeaderV1, readDeploymentArtifactContentV1,
    deploymentArtifactReadFailureV1, type DeploymentArtifactReadFailureV1,
    type DeploymentArtifactDocumentV1, type DeploymentArtifactHeaderV1, type DeploymentArtifactReadResultV1 } from '@happier-dev/protocol/deployments/deploymentArtifactContentReferenceV1';
import { DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1, DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1 } from '@happier-dev/protocol/artifacts/deploymentArtifactKindsV1';
import { DeploymentEnvironmentContentStoredReadV1Schema } from './environment.js';
import { DeploymentDomainContentV1Schema } from './domain.js';
import { DeploymentStepV1Schema, type DeploymentContentV1, type DeploymentStepV1 } from './deployment.js';

export { DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1, DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1, DEPLOYMENT_ENVIRONMENT_ARTIFACT_STORED_KIND_V1, DEPLOYMENT_TARGET_LINK_ARTIFACT_STORED_KIND_V1, DEPLOYMENT_RECEIPT_ARTIFACT_STORED_KIND_V1 } from '@happier-dev/protocol/artifacts/deploymentArtifactKindsV1';
export const DeploymentEnvironmentArtifactHeaderV1Schema = z.strictObject({ kind: z.literal(DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1), title: z.string() });
export const DeploymentTargetLinkArtifactHeaderV1Schema = z.strictObject({ kind: z.literal(DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1), title: z.string() });
export const DeploymentReceiptArtifactHeaderV1Schema = z.strictObject({ kind: z.literal(DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1), title: z.string(),
    steps: z.optional(z.array(DeploymentStepV1Schema)) });
export type DeploymentReceiptArtifactHeaderV1 = z.infer<typeof DeploymentReceiptArtifactHeaderV1Schema>;

/** A private, atomic header projection of the receipt's canonical content. */
export function createDeploymentReceiptArtifactHeaderV1(title: string, content: Pick<DeploymentContentV1, 'steps'>): DeploymentReceiptArtifactHeaderV1 {
    return DeploymentReceiptArtifactHeaderV1Schema.parse({ kind: DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1, title, steps: content.steps });
}

export type { DeploymentArtifactDocumentV1, DeploymentArtifactHeaderV1, DeploymentArtifactReadResultV1 }
    from '@happier-dev/protocol/deployments/deploymentArtifactContentReferenceV1';
type ContentReference = z.infer<typeof DeploymentArtifactContentReferenceV1Schema>;
type ReadFailure = DeploymentArtifactReadFailureV1;

export function readDeploymentEnvironmentArtifactHeaderV1(reference: ContentReference, artifact: DeploymentArtifactHeaderV1 | null): { ok: true; title: string } | ReadFailure {
    return readDeploymentArtifactHeaderV1(reference, artifact, DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1);
}

export function readDeploymentReceiptArtifactHeaderV1(reference: ContentReference, artifact: DeploymentArtifactHeaderV1 | null): { ok: true; title: string; steps: DeploymentStepV1[] | null } | ReadFailure {
    const header = readDeploymentArtifactHeaderV1(reference, artifact, DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1);
    if (!header.ok) return header;
    const steps = DeploymentReceiptArtifactHeaderV1Schema.shape.steps.safeParse(artifact?.header.steps);
    return steps.success ? { ...header, steps: steps.data ?? null } : deploymentArtifactReadFailureV1('steps');
}

export function readDeploymentEnvironmentArtifactV1(reference: ContentReference, artifact: DeploymentArtifactDocumentV1 | null): DeploymentArtifactReadResultV1<z.infer<typeof DeploymentEnvironmentContentStoredReadV1Schema>> {
    return readDeploymentArtifactContentV1(reference, artifact, DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, DeploymentEnvironmentContentStoredReadV1Schema);
}
export function readDeploymentDomainArtifactV1(reference: ContentReference, artifact: DeploymentArtifactDocumentV1 | null): DeploymentArtifactReadResultV1<z.infer<typeof DeploymentDomainContentV1Schema>> {
    return readDeploymentArtifactContentV1(reference, artifact, 'deployment-domain.v1', DeploymentDomainContentV1Schema);
}
export { readDeploymentTargetLinkArtifactV1 } from '@happier-dev/protocol/deployments/deploymentTargetLinkContentV1';
export { readDeploymentReceiptArtifactV1 } from '@happier-dev/protocol/deployments/deploymentReceiptContentV1';
