import { DeploymentPromoteInputV1Schema, type DeploymentPromoteInputV1 } from './deploymentPromoteIntentV1.js';
import type { DeploymentArtifactContentReferenceV1 } from './deploymentArtifactContentReferenceV1.js';
import type { DeploymentPromoteIntentInputV1 } from './deploymentPromoteIntentV1.js';

/** UI, CLI and agent requests share the receiving controller's prepared input builder. */
export function buildDeploymentPromoteInputV1(input: DeploymentPromoteIntentInputV1, prepared: Readonly<{
  requestKey: string; expectedRevision: number; targetLinkId: string; expectedTargetLinkRevision: number;
  candidate: DeploymentArtifactContentReferenceV1; destinationContent: DeploymentArtifactContentReferenceV1;
}>): DeploymentPromoteInputV1 {
  const { candidate, ...selection } = prepared;
  return DeploymentPromoteInputV1Schema.parse({ ...input, ...selection, ...candidate });
}
