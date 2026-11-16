import { expect, it } from 'vitest';
import { GITLAB_PLUGIN } from '@happier-dev/plugins-scm-gitlab/manifest';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { resolvePublishTargetRecommendation, OWN_SERVER_DEPLOYMENT_TARGET_V1, projectDeploymentSuggestionTargetsV1 } from '@happier-dev/deployments';
import { createScmHostingProviderRegistry } from './registry';

it('exposes the activated GitLab publisher through the registry and recommends its own-server pairing', async () => {
  const kit = await createPluginTestkit({ manifest: GITLAB_PLUGIN.manifest, module: { activate: GITLAB_PLUGIN.activate } });
  try {
    const contribution = GITLAB_PLUGIN.manifest.contributes.scmHostingProviders[0];
    if (!contribution) throw new Error('Missing GitLab declaration');
    const adapter = kit.registration('scmHostingProviders', contribution.id);
    if (!adapter) throw new Error('Missing GitLab registration');
    const pluginId = GITLAB_PLUGIN.manifest.id;
    const registry = createScmHostingProviderRegistry({
      providers: [{ ...contribution, pluginId, displayName: 'GitLab' }],
      runtimeRegistrations: [{ pluginId, occurrenceId: 'gitlab-publishing-test', registration: { id: contribution.id, ...adapter } }],
    });
    const publishers = registry.providers.filter(row => registry.getRepositoryPublishing(row.id));
    expect(publishers.map(row => row.kind)).toContain('gitlab');
    const own = OWN_SERVER_DEPLOYMENT_TARGET_V1;
    expect(resolvePublishTargetRecommendation({ definition: null, deploy: { framework: 'html', output: 'static' },
      repositoryProviderKind: 'gitlab', publishProviderKinds: publishers.map(row => row.kind),
      targets: projectDeploymentSuggestionTargetsV1([own]).targets,
    }).offeredTargetIds).toContain(own.id);
  } finally { await kit.dispose(); }
});
