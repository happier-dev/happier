import { z } from 'zod/mini';
import { DeploymentArtifactContentReferenceV1Schema, readDeploymentArtifactHeaderV1, readDeploymentArtifactJsonBodyV1,
    DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1, DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1 } from '@happier-dev/protocol';
import { ArtifactDocumentV1Schema } from '@happier-dev/protocol/artifacts/artifactActionsV1';
import { DeploymentEnvironmentContentV1Schema } from './environment.js';
import { DeploymentDomainContentV1Schema } from './domain.js';
import { DeploymentTargetLinkContentV1Schema } from './target.js';
import { DeploymentContentV1Schema, DeploymentStepV1Schema, type DeploymentContentV1, type DeploymentStepV1 } from './deployment.js';

export { DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1, DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1,
    DEPLOYMENT_ENVIRONMENT_ARTIFACT_STORED_KIND_V1, DEPLOYMENT_TARGET_LINK_ARTIFACT_STORED_KIND_V1, DEPLOYMENT_RECEIPT_ARTIFACT_STORED_KIND_V1 } from '@happier-dev/protocol';
export const DeploymentEnvironmentArtifactHeaderV1Schema = z.strictObject({ kind: z.literal(DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1), title: z.string() });
export const DeploymentTargetLinkArtifactHeaderV1Schema = z.strictObject({ kind: z.literal(DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1), title: z.string() });
export const DeploymentReceiptArtifactHeaderV1Schema = z.strictObject({ kind: z.literal(DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1), title: z.string(),
    steps: z.optional(z.array(DeploymentStepV1Schema)) });
export type DeploymentReceiptArtifactHeaderV1 = z.infer<typeof DeploymentReceiptArtifactHeaderV1Schema>;

/** A private, atomic header projection of the receipt's canonical content. */
export function createDeploymentReceiptArtifactHeaderV1(title: string, content: Pick<DeploymentContentV1, 'steps'>): DeploymentReceiptArtifactHeaderV1 {
    return DeploymentReceiptArtifactHeaderV1Schema.parse({ kind: DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1, title, steps: content.steps });
}

/** Already opened by the canonical Artifact owner; this boundary never decrypts content. */
export type DeploymentArtifactDocumentV1 = Pick<z.infer<typeof ArtifactDocumentV1Schema>, 'artifactId' | 'body' | 'revision'> & {
    header: Readonly<Record<string, unknown>>;
};
export type DeploymentArtifactHeaderV1 = Omit<DeploymentArtifactDocumentV1, 'body'>;
type ContentReference = z.infer<typeof DeploymentArtifactContentReferenceV1Schema>;
type ReadFailure = { ok: false; error: 'deployment_content_unavailable' | 'deployment_conflict' };
export type DeploymentArtifactReadResultV1<T> = { ok: true; content: T; title: string } | ReadFailure;

export function readDeploymentEnvironmentArtifactHeaderV1(reference: ContentReference, artifact: DeploymentArtifactHeaderV1 | null): { ok: true; title: string } | ReadFailure {
    return readDeploymentArtifactHeaderV1(reference, artifact, DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1);
}

export function readDeploymentReceiptArtifactHeaderV1(reference: ContentReference, artifact: DeploymentArtifactHeaderV1 | null): { ok: true; title: string; steps: DeploymentStepV1[] | null } | ReadFailure {
    const header = readDeploymentArtifactHeaderV1(reference, artifact, DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1);
    if (!header.ok) return header;
    const steps = DeploymentReceiptArtifactHeaderV1Schema.shape.steps.safeParse(artifact?.header.steps);
    return steps.success ? { ...header, steps: steps.data ?? null } : { ok: false, error: 'deployment_content_unavailable' };
}

function readContent<T>(reference: ContentReference, artifact: DeploymentArtifactDocumentV1 | null,
    expectedKind: string, contentSchema: z.ZodMiniType<T>): DeploymentArtifactReadResultV1<T> {
    const opened = readDeploymentArtifactJsonBodyV1(reference, artifact, expectedKind);
    if (!opened.ok) return opened;
    const content = contentSchema.safeParse(opened.body);
    return content.success ? { ok: true, content: content.data, title: opened.title } : { ok: false, error: 'deployment_content_unavailable' };
}

export function readDeploymentEnvironmentArtifactV1(reference: ContentReference, artifact: DeploymentArtifactDocumentV1 | null): DeploymentArtifactReadResultV1<z.infer<typeof DeploymentEnvironmentContentV1Schema>> {
    return readContent(reference, artifact, DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, DeploymentEnvironmentContentV1Schema);
}
export function readDeploymentDomainArtifactV1(reference: ContentReference, artifact: DeploymentArtifactDocumentV1 | null): DeploymentArtifactReadResultV1<z.infer<typeof DeploymentDomainContentV1Schema>> {
    return readContent(reference, artifact, 'deployment-domain.v1', DeploymentDomainContentV1Schema);
}
export function readDeploymentTargetLinkArtifactV1(reference: ContentReference, artifact: DeploymentArtifactDocumentV1 | null): DeploymentArtifactReadResultV1<z.infer<typeof DeploymentTargetLinkContentV1Schema>> {
    return readContent(reference, artifact, DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1, DeploymentTargetLinkContentV1Schema);
}
export function readDeploymentReceiptArtifactV1(reference: ContentReference, artifact: DeploymentArtifactDocumentV1 | null): DeploymentArtifactReadResultV1<z.infer<typeof DeploymentContentV1Schema>> {
    return readContent(reference, artifact, DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1, DeploymentContentV1Schema);
}
