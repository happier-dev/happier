import {
    DeploymentPreviewProvenanceV1ProtocolSchema as canonicalProvenance,
    DeploymentSourceIntentV1ProtocolSchema as canonicalSourceIntent,
    DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1,
    DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1,
    readDeploymentArtifactJsonBodyV1 as canonicalReadArtifact,
} from '@happier-dev/protocol/deployments/deploymentActionsV1';
import type {
    DeploymentPreviewProvenanceV1,
    DeploymentSourceIntentV1,
} from '@happier-dev/protocol/deployments/deploymentActionsV1';
import {
    readDeploymentReceiptArtifactV1 as canonicalReadReceipt,
    readDeploymentTargetLinkArtifactV1 as canonicalReadTargetLink,
} from '@happier-dev/deployment-protocol/v1';

import { projectProtocolValue } from './projectProtocolValue.js';
import type { ProtocolComposableSchema } from './protocolFacade.js';

export type {
    DeploymentPreviewProvenanceV1,
    DeploymentArtifactContentReferenceV1,
    DeploymentArtifactReadFailureV1,
    OpenedDeploymentArtifactV1,
    DeploymentSourceIntentV1,
} from '@happier-dev/protocol/deployments/deploymentActionsV1';

export { DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1 };

/** Protected correlation stays with the canonical deployment schema, never caller-authored policy. */
export const ProtocolDeploymentPreviewProvenanceV1Schema: ProtocolComposableSchema<DeploymentPreviewProvenanceV1> = canonicalProvenance;

/** Exact receipt source selection; this is the same schema used by deployment and pending intent. */
export const ProtocolDeploymentSourceIntentV1Schema: ProtocolComposableSchema<DeploymentSourceIntentV1> = canonicalSourceIntent;

/** The Artifact owner opens bytes; this shared reader checks exact identity, revisions, kind and JSON. */
export const readDeploymentArtifactJsonBodyV1: (
    ...args: Parameters<typeof canonicalReadArtifact>
) => ReturnType<typeof canonicalReadArtifact> = projectProtocolValue(canonicalReadArtifact);

/** Exact receipt content is read by the deployment protocol's canonical Artifact reader. */
export const readDeploymentReceiptArtifactV1: (
    ...args: Parameters<typeof canonicalReadReceipt>
) => ReturnType<typeof canonicalReadReceipt> = projectProtocolValue(canonicalReadReceipt);

/** Provider target-link content retains the deployment protocol's identity and schema checks. */
export const readDeploymentTargetLinkArtifactV1: (
    ...args: Parameters<typeof canonicalReadTargetLink>
) => ReturnType<typeof canonicalReadTargetLink> = projectProtocolValue(canonicalReadTargetLink);
