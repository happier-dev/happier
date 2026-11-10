import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { DeploymentDeployInputV1Schema, type DeploymentDeployInputV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { DeploymentArtifactContentReferenceV1Schema } from '@happier-dev/protocol/deployments/deploymentArtifactContentReferenceV1';

/** Fresh preparation may replace the candidate address, never the authored intent.
 * The operation owner separately requires a confirmed no-effect failure. */
export function hasEquivalentDeploymentOperationRetryInput(original: unknown, retry: unknown): boolean {
  const previous = DeploymentDeployInputV1Schema.safeParse(original);
  const next = DeploymentDeployInputV1Schema.safeParse(retry);
  if (!previous.success || !next.success) return false;
  const intent = (input: DeploymentDeployInputV1) => Object.fromEntries(Object.entries(input)
    .filter(([key]) => !Object.hasOwn(DeploymentArtifactContentReferenceV1Schema.shape, key)));
  return sameStrictJsonValue(intent(previous.data), intent(next.data));
}
