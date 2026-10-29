import { encodeArtifactKindV1 } from './artifactKindV1.js';

/** Private deployment content kinds shared by Artifact privacy and deployment readers. */
export const DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1 = 'deployment-environment.v1';
export const DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1 = 'deployment-target-link.v1';
export const DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1 = 'deployment-receipt.v1';
export const DEPLOYMENT_ENVIRONMENT_ARTIFACT_STORED_KIND_V1 = encodeArtifactKindV1({ kind: 'other', kindHint: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1 });
export const DEPLOYMENT_TARGET_LINK_ARTIFACT_STORED_KIND_V1 = encodeArtifactKindV1({ kind: 'other', kindHint: DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1 });
export const DEPLOYMENT_RECEIPT_ARTIFACT_STORED_KIND_V1 = encodeArtifactKindV1({ kind: 'other', kindHint: DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1 });
