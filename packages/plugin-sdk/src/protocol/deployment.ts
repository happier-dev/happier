import { projectZodProtocolSchema } from '@happier-dev/protocol/plugins/actions/internalProtocolZodAdapter';
import { DeploymentDeploySemanticInputV1Schema, type DeploymentDeploySemanticInputV1 } from '@happier-dev/protocol/deployments/deploymentDeployIntentV1';
import { DeploymentCorrelationV1Schema, type DeploymentCorrelationV1 } from '@happier-dev/protocol/deployments/deploymentReceiptContentV1';
import { DeploymentEnvironmentHeaderV1Schema, type DeploymentEnvironmentHeaderV1, DeploymentReceiptHeaderV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { EnvironmentVariableBindingV1Schema, type EnvironmentVariableBindingV1, DeploymentSecretBindingSourceV1Schema, type DeploymentSecretBindingSourceV1 } from '@happier-dev/protocol/deployments/storedAppInputV1';
import { deploymentRevisionShortLabelV1 as canonicalRevisionLabel } from '@happier-dev/protocol/deployments/storedAppInputV1';
import { readDeploymentFailureRecoveryV1 as canonicalReadFailureRecovery } from '@happier-dev/protocol/deployments/deploymentFailureRecoveryV1';
import { formatSharedSavedSecretRefV1 as canonicalFormatSavedSecretRef } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1 } from '@happier-dev/protocol/artifacts/deploymentArtifactKindsV1';

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

export { DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1, DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1 };

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

export type { DeploymentDeploySemanticInputV1, DeploymentCorrelationV1, DeploymentEnvironmentHeaderV1, DeploymentReceiptHeaderV1, EnvironmentVariableBindingV1, DeploymentSecretBindingSourceV1 };
export type { DeploymentContentV1 } from '@happier-dev/protocol/deployments/deploymentReceiptContentV1';
export type { DeploymentReceiptFailureV1 } from '@happier-dev/protocol/deployments/deploymentReceiptEventsV1';

/** Portable declarations use the original owners for parsing and JSON Schema. */
export const ProtocolDeploymentDeploySemanticInputV1Schema: ProtocolComposableSchema<unknown, DeploymentDeploySemanticInputV1> = projectZodProtocolSchema(DeploymentDeploySemanticInputV1Schema);
export const ProtocolDeploymentCorrelationV1Schema: ProtocolComposableSchema<unknown, DeploymentCorrelationV1> = projectZodProtocolSchema(DeploymentCorrelationV1Schema);
export const ProtocolDeploymentEnvironmentHeaderV1Schema: ProtocolComposableSchema<unknown, DeploymentEnvironmentHeaderV1> = projectZodProtocolSchema(DeploymentEnvironmentHeaderV1Schema);
export const ProtocolDeploymentReceiptHeaderV1Schema: ProtocolComposableSchema<unknown, DeploymentReceiptHeaderV1> = projectZodProtocolSchema(DeploymentReceiptHeaderV1Schema);
export const ProtocolDeploymentVariableBindingV1Schema: ProtocolComposableSchema<unknown, EnvironmentVariableBindingV1> = projectZodProtocolSchema(EnvironmentVariableBindingV1Schema);
export const ProtocolDeploymentSecretBindingSourceV1Schema: ProtocolComposableSchema<unknown, DeploymentSecretBindingSourceV1> = projectZodProtocolSchema(DeploymentSecretBindingSourceV1Schema);

/** Presentation derives from captured revision and failure facts without opening the host store. */
export const deploymentRevisionShortLabelV1: typeof canonicalRevisionLabel = projectProtocolValue(canonicalRevisionLabel);
export const readDeploymentFailureRecoveryV1: typeof canonicalReadFailureRecovery = projectProtocolValue(canonicalReadFailureRecovery);

/** Formats the shared opaque resource reference; it never accesses the secret itself. */
export const formatSharedSavedSecretRefV1: typeof canonicalFormatSavedSecretRef = projectProtocolValue(canonicalFormatSavedSecretRef);
