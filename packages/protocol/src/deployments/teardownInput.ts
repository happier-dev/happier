import { DeploymentTeardownInputV1Schema, type DeploymentTeardownInputV1,
  type DeploymentArtifactContentReferenceV1 } from './deploymentActionsV1.js';
import type { DeploymentTeardownRequestInputV1 } from './deploymentTeardownRequestV1.js';

/** UI, CLI and agent requests share the receiving controller's prepared input builder. */
export function buildDeploymentTeardownInputV1(
  input: DeploymentTeardownRequestInputV1 | Omit<DeploymentTeardownInputV1, keyof DeploymentArtifactContentReferenceV1>,
  prepared: Readonly<{
    requestKey: string; expectedRevision: number; targetLinkId: string; expectedTargetLinkRevision: number;
    candidate: DeploymentArtifactContentReferenceV1;
  }>,
): DeploymentTeardownInputV1 {
  const { candidate, ...selection } = prepared;
  return DeploymentTeardownInputV1Schema.parse({ ...input, ...selection, ...candidate });
}
