import { describe, expect, it } from 'vitest';
import { selectGithubDeploymentReviewSourceV1 } from './deploymentReviewSource.js';
import type { PluginActionResultById } from '@happier-dev/plugin-sdk/actions';

type Source = Extract<PluginActionResultById['automation.event.sources.list'], { kind: 'page' }>['definitions'][number];
const source: Source = {
  automationId: 'monitor', triggerId: 'review', triggerRevision: 1, eventRef: { pluginId: 'happier.scm.forge.github', localId: 'automation/deployment-review-v1' },
  sourceInstanceId: 'github:repository:77:deployment-review', sourceSelectorId: 'selected', sourceContractVersion: 1,
  sourceConfig: { v: 1, repository: { v: 1, repositoryId: '77', owner: 'acme', name: 'widgets', nameWithOwner: 'acme/widgets' },
    credentialRef: { service: { pluginId: 'happier.scm.forge.github', localId: 'github-account' }, accountId: 'exact-account' },
    deploymentReview: { monitoringMachineId: 'monitor-machine' } },
  observationTransport: { kind: 'checkpointedPull', watcherMaterializationRef: { pluginId: 'happier.scm.forge.github', machineId: 'monitor-machine', materializationId: 'monitor-install' } },
  filter: null, maximumObservationAgeMs: null,
};
const location = { repositoryId: '77', runId: '81', attempt: '2', environmentId: '42' };

describe('deployment review page source admission', () => {
  it('selects only the configured exact repository, credential and monitoring Machine without Project context', () => {
    expect(selectGithubDeploymentReviewSourceV1([source], location)).toMatchObject({ kind: 'ready',
      config: { repository: { repositoryId: '77' }, credentialRef: { accountId: 'exact-account' }, deploymentReview: { monitoringMachineId: 'monitor-machine' } },
      repository: { kind: 'github', repository: 'acme/widgets' } });
  });
  it('refuses missing, ambiguous and moved placement rather than choosing a source or account', () => {
    expect(selectGithubDeploymentReviewSourceV1([], location)).toMatchObject({ kind: 'unavailable' });
    expect(selectGithubDeploymentReviewSourceV1([source, { ...source, automationId: 'other-monitor' }], location)).toMatchObject({ kind: 'unavailable' });
    expect(selectGithubDeploymentReviewSourceV1([source], { ...location, repositoryId: '88' })).toMatchObject({ kind: 'unavailable' });
    const moved = { ...source, observationTransport: { kind: 'checkpointedPull' as const, watcherMaterializationRef: {
      pluginId: 'happier.scm.forge.github', machineId: 'another-machine', materializationId: 'another-install' } } };
    expect(selectGithubDeploymentReviewSourceV1([moved], location)).toMatchObject({ kind: 'unavailable' });
  });
});
