import {
    DeploymentPreviewProvenanceV1ProtocolSchema as canonicalProvenance,
    DeploymentSourceIntentV1ProtocolSchema as canonicalSourceIntent,
    DeploymentReceiptOperationV1ProtocolSchema as canonicalReceiptOperation,
    DeploymentControllerAvailabilityV1ProtocolSchema as canonicalControllerAvailability,
    DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1,
    DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1,
    readDeploymentArtifactJsonBodyV1 as canonicalReadArtifact,
} from '@happier-dev/protocol/deployments/deploymentActionsV1';
import type {
    DeploymentPreviewProvenanceV1,
    DeploymentSourceIntentV1,
    DeploymentReceiptHeaderV1,
    DeploymentControllerAvailabilityV1,
} from '@happier-dev/protocol/deployments/deploymentActionsV1';
import {
    readDeploymentReceiptArtifactV1 as canonicalReadReceipt,
} from '@happier-dev/protocol/deployments/deploymentReceiptContentV1';
import { readDeploymentTargetLinkArtifactV1 as canonicalReadTargetLink } from '@happier-dev/protocol/deployments/deploymentTargetLinkContentV1';

import { projectProtocolValue } from './projectProtocolValue.js';
import { readDeploymentDomainServingUrlV1 as canonicalReadDomainServingUrl } from '@happier-dev/protocol/deployments/deploymentDomainContentV1';
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

/** Operation is copied verbatim from the canonical receipt, including rollback and promotion. */
export const ProtocolDeploymentReceiptOperationV1Schema: ProtocolComposableSchema<DeploymentReceiptHeaderV1['operation']> = canonicalReceiptOperation;

/** Controller reachability remains independent of receipt readiness. */
export const ProtocolDeploymentControllerAvailabilityV1Schema: ProtocolComposableSchema<DeploymentControllerAvailabilityV1> = canonicalControllerAvailability;

/** The Artifact owner opens bytes; this shared reader checks exact identity, revisions, kind and JSON. */
export const readDeploymentArtifactJsonBodyV1: (
    ...args: Parameters<typeof canonicalReadArtifact>
) => ReturnType<typeof canonicalReadArtifact> = projectProtocolValue(canonicalReadArtifact);

/** Exact receipt content is read by the canonical Receipt content validator. */
export const readDeploymentReceiptArtifactV1: (
    ...args: Parameters<typeof canonicalReadReceipt>
) => ReturnType<typeof canonicalReadReceipt> = projectProtocolValue(canonicalReadReceipt);

/** Provider target-link content retains its exact Artifact identity and schema checks. */
export const readDeploymentTargetLinkArtifactV1: (
    ...args: Parameters<typeof canonicalReadTargetLink>
) => ReturnType<typeof canonicalReadTargetLink> = projectProtocolValue(canonicalReadTargetLink);

export const readDeploymentDomainServingUrlV1: typeof canonicalReadDomainServingUrl = projectProtocolValue(canonicalReadDomainServingUrl);
