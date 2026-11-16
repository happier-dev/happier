import { describe, expect, it } from 'vitest';
import { PluginUiViewV2Schema } from './v2.js';
import { projectPluginUiDeclarationEntriesV1 } from './declarationProjection.js';

describe('app page route aliases', () => {
  const page = { id: 'work', renderer: 'native', container: 'appPage', target: { kind: 'app' } };
  const routeAliases = [{ pathname: '/retired/[id]', subPath: 'entry,{id}' }];

  it('carries authored legacy routes through the admitted page projection', () => {
    const definition = PluginUiViewV2Schema.parse({ ...page, routeAliases });
    const pluginId = 'acme.work';
    const entries = projectPluginUiDeclarationEntriesV1({ registry: {
      uiRenderersV2: [{ pluginId, identity: { pluginId, localId: 'native' }, definition: {
        id: 'native', kind: 'declarative', root: { kind: 'text', text: 'Work' },
      } }],
      uiViewsV2: [{ pluginId, identity: { pluginId, localId: 'work' }, definition }],
    } });
    expect(entries['surfacePlacement:acme.work:work']).toHaveProperty('routeAliases', routeAliases);
  });

  it('keeps aliases closed and limited to app pages', () => {
    expect(PluginUiViewV2Schema.safeParse({ ...page, routeAliases: [{ pathname: '/retired', unknown: true }] }).success).toBe(false);
    expect(PluginUiViewV2Schema.safeParse({ ...page, routeAliases: [{ pathname: 'retired' }] }).success).toBe(false);
    expect(PluginUiViewV2Schema.safeParse({ ...page, container: 'detailsTab', target: { kind: 'session' }, routeAliases }).success).toBe(false);
    expect(PluginUiViewV2Schema.safeParse({ ...page, target: { kind: 'project' }, routeAliases }).success).toBe(false);
  });
});
