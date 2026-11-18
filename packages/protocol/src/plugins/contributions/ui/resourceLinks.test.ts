import { describe, expect, it } from 'vitest';
import { PluginUiViewV2Schema } from './v2.js';
import { projectPluginUiDeclarationEntriesV1 } from './declarationProjection.js';
import { PluginUiOpenResourceIntentV1Schema, PluginUiResourceIntentV1Schema } from './resourceLinks.js';

it('opens an Artifact by identity without accepting a caller-selected Home or widening provider URL lookups', () => {
    const artifact = { kind: 'artifact', artifactId: 'review/one' };
    expect(PluginUiOpenResourceIntentV1Schema.parse(artifact)).toEqual(artifact);
    expect(PluginUiOpenResourceIntentV1Schema.safeParse({ ...artifact, serverId: 'other-home' }).success).toBe(false);
    expect(PluginUiResourceIntentV1Schema.safeParse(artifact).success).toBe(false);
    expect(PluginUiOpenResourceIntentV1Schema.parse({ kind: 'pullRequest', url: 'https://forge.test/org/repo/pull/1' }))
        .toEqual({ kind: 'pullRequest', url: 'https://forge.test/org/repo/pull/1' });
});

describe('SCM resource link contribution', () => {
  it('admits typed URL handlers only on the SCM inline seam', () => {
    const view = { id: 'scm', renderer: 'native', container: 'scmPullRequest', target: { kind: 'session' },
      resourceLinks: [{ kind: 'pullRequest', urlPattern: '^https://forge.example/[^/]+/[^/]+/pull/[0-9]+$', destination: 'resource-details' }] };
    expect(PluginUiViewV2Schema.safeParse(view).success).toBe(true);
    expect(PluginUiViewV2Schema.safeParse({ ...view, container: 'sessionSubagentLaunch' }).success).toBe(false);
    expect(PluginUiViewV2Schema.safeParse({ ...view, resourceLinks: [{ ...view.resourceLinks[0], kind: 'repository' }] }).success).toBe(false);
    expect(PluginUiViewV2Schema.safeParse({ ...view, resourceLinks: [{ ...view.resourceLinks[0], urlPattern: '[' }] }).success).toBe(false);
  });

  it('retains resource handlers through canonical declaration projection', () => {
    const pluginId = 'acme.forge';
    const resourceLinks = [{ kind: 'pullRequest', urlPattern: '^https://forge.example/.+/pull/[0-9]+$', destination: 'details' }];
    const entries = projectPluginUiDeclarationEntriesV1({ registry: {
      uiRenderersV2: [{ pluginId, identity: { pluginId, localId: 'native' }, definition: {
        id: 'native', kind: 'declarative', root: { kind: 'text', text: 'Resource' },
      } }],
      uiViewsV2: [{ pluginId, identity: { pluginId, localId: 'scm' }, definition: PluginUiViewV2Schema.parse({
        id: 'scm', renderer: 'native', container: 'scmPullRequest', target: { kind: 'session' }, resourceLinks,
      }) }],
    } });
    expect(entries['surfacePlacement:acme.forge:scm']).toHaveProperty('resourceLinks', resourceLinks);
  });
});
