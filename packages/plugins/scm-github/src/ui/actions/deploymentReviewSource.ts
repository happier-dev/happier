import type { PluginActionResultById } from '@happier-dev/plugin-sdk/actions';
import { normalizeScmHostingRepositoryIdentity } from '@happier-dev/plugin-sdk/scm';
import { GITHUB_PLUGIN_ID, parseGithubDeploymentMonitoringSourceConfig } from '../../observations/githubProviderContracts.js';
import { GITHUB_AUTOMATION_EVENT_LOCAL_IDS } from '../../githubAutomationEvents.js';
import type { GithubDeploymentReviewLocationV1 } from '../../actions/deploymentReviewProtocol.js';

type Source = Extract<PluginActionResultById['automation.event.sources.list'], { kind: 'page' }>['definitions'][number];

/** Consume the host's current source catalog; a locator grants no Account or Machine authority. */
export function selectGithubDeploymentReviewSourceV1(definitions: readonly Source[], location: GithubDeploymentReviewLocationV1) {
  const matches = [];
  for (const definition of definitions) {
    if (definition.eventRef.pluginId !== GITHUB_PLUGIN_ID || definition.eventRef.localId !== GITHUB_AUTOMATION_EVENT_LOCAL_IDS.deploymentReview
      || definition.sourceContractVersion !== 1 || definition.observationTransport.kind !== 'checkpointedPull') continue;
    try {
      const config = parseGithubDeploymentMonitoringSourceConfig(definition.sourceConfig);
      if (config.repository.repositoryId !== location.repositoryId
        || definition.sourceInstanceId !== `github:repository:${location.repositoryId}:deployment-review`
        || definition.observationTransport.watcherMaterializationRef.machineId !== config.deploymentReview.monitoringMachineId) continue;
      const repository = normalizeScmHostingRepositoryIdentity({ kind: 'github', deployment: 'https://github.com', repository: config.repository.nameWithOwner });
      if (repository) matches.push({ definition, config, repository });
    } catch { /* An incompatible source cannot admit a review target. */ }
  }
  if (matches.length !== 1) return { kind: 'unavailable' as const, code: matches.length > 1 ? 'github_deployment_source_ambiguous' : 'github_deployment_source_unavailable' };
  return { kind: 'ready' as const, ...matches[0]! };
}
