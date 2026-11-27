import type { EnvironmentSecretBindingProjectionV1 } from '@happier-dev/deployments';
import type { DeploymentVariableFactV1 } from '@happier-dev/protocol/deployments/storedAppInputV1';

import { t } from '@/text';

type VariableBinding = Extract<
  EnvironmentSecretBindingProjectionV1['binding'],
  { purpose: 'variable' }
>;

/**
 * What a variable reads, as people say it: a Saved Secret by its name, a value as itself, a reference by the
 * Environment it comes from, a deployment fact by its title. The Variables page and an Environment update's
 * approval read a source the same way.
 */
export function deploymentBindingSourceTitle(
  binding: Pick<VariableBinding, 'source'>,
  environmentName: (id: string) => string | null,
  secretName?: (ref: string) => string | null,
): string {
  const source = binding.source;
  switch (source.kind) {
    case 'secret':
      return (
        secretName?.(source.ref) ?? t('projects.deployments.sourceSavedSecret')
      );
    case 'value':
      return source.value.length > 0
        ? source.value
        : t('projects.deployments.sourceValue');
    case 'reference':
      return t('projects.deployments.sourceReference', {
        output: source.export,
        environment:
          environmentName(source.environmentId) ??
          t('projects.deployments.sourceAnotherEnvironment'),
      });
    case 'deploymentFact':
      return deploymentVariableFactTitle(source.fact);
  }
}

export function deploymentVariableFactTitle(
  fact: DeploymentVariableFactV1,
): string {
  switch (fact) {
    case 'primaryUrl':
      return t('projects.deployments.factPrimaryUrl');
    case 'commitSha':
      return t('projects.deployments.factCommitSha');
    case 'deploymentId':
      return t('projects.deployments.factDeploymentId');
    case 'environmentName':
      return t('projects.deployments.factEnvironmentName');
    case 'domainUrl':
      return t('projects.deployments.factDomainUrl');
  }
}
