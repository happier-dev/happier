import { renderDeploymentGithubActionsStep as renderStep } from '@happier-dev/deployments';
import { DeploymentIdentifierV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';

/** The shared renderer owns quoting; the CLI boundary validates authored selectors. */
export function renderDeploymentGithubActionsStep(input: Readonly<{
  serverIdentityId: string; serverApiUrl: string; environmentId: string;
}>): string {
  return renderStep({ ...input, serverIdentityId: DeploymentIdentifierV1Schema.parse(input.serverIdentityId),
    environmentId: DeploymentIdentifierV1Schema.parse(input.environmentId) });
}
