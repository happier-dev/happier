import { artifactHtmlBundleFromBodyV1 } from '@happier-dev/protocol/artifacts/artifactHtmlV1';
import { describe, expect, it } from 'vitest';
import { definePlugin } from './definePlugin.js';
import { createPluginTestkit } from './testing/host.js';
import { parsePluginManifest } from './manifest.js';
import { repositoryInputTypes, repositoryResources } from '../examples/public-authoring/inputTypes.js';
import { externalAuthoringPlugin } from '../../plugin-ui/fixtures/external-authoring/src/index.js';

describe('public author input types', () => {
  it('loads the external author’s top-level input descriptor and its Resource options', async () => {
    const parsed = parsePluginManifest(externalAuthoringPlugin.manifest);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
    expect(parsed.manifest.contributes.inputTypes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'review', semantic: 'external-review', options: { resource: 'review-options' } }),
    ]));
    const testkit = await createPluginTestkit({ manifest: externalAuthoringPlugin.manifest, module: externalAuthoringPlugin });
    try {
      const resource = testkit.registration('resources', 'review-options');
      if (!resource) throw new Error('Expected the external author’s options Resource');
      const value = await resource.read({ signal: new AbortController().signal, context: { kind: 'global' } });
      expect(JSON.parse(typeof value === 'string' ? value : new TextDecoder().decode(value))).toEqual([
        { value: { reviewId: 'current' }, label: 'Current review' },
      ]);
    } finally { await testkit.dispose(); }
  });

  it('projects the descriptor and activates only its declared genuine Resource leaf', async () => {
    const plugin = definePlugin({ id: 'examples.public-sdk-review-assistant', version: '1.0.0',
      inputTypes: repositoryInputTypes, resources: repositoryResources,
      ui: { renderers: [{ id: 'review-native', kind: 'hostedHtml', source: artifactHtmlBundleFromBodyV1('<main>Repository picker</main>') }] },
    });
    const parsed = parsePluginManifest(plugin.manifest);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
    expect(parsed).toMatchObject({ ok: true, manifest: { contributes: {
      inputTypes: [{ id: 'repository', semantic: 'repository', options: { resource: 'review-repositories' }, picker: 'review-native' }],
    } } });
    const testkit = await createPluginTestkit({ manifest: plugin.manifest, module: plugin });
    try {
      expect(testkit.registrations()).toEqual([{ family: 'resources', localId: 'review-repositories' }]);
      const resource = testkit.registration('resources', 'review-repositories');
      if (!resource) throw new Error('Expected declared Resource registration');
      const value = await resource.read({ signal: new AbortController().signal, context: { kind: 'global' } });
      expect(JSON.parse(typeof value === 'string' ? value : new TextDecoder().decode(value))).toEqual([
        { value: { repositoryId: 'example/review-assistant' }, label: 'Review assistant' },
      ]);
    } finally { await testkit.dispose(); }
  });
});
