import { describe, expect, it } from 'vitest';

import * as ContributionUi from './index.js';
import { PluginUiRendererV2Schema } from './v2.js';
import * as PublicPluginUi from '../../ui/index.js';

describe('legacy host renderer vocabulary retirement', () => {
  it('does not expose unselectable host/session/structured renderer ids through either UI barrel', () => {
    for (const retiredExport of [
      'PluginStructuredMessageRendererIdV1Schema',
      'PluginSessionSurfaceRendererIdV1Schema',
      'PluginSessionHeaderActionRendererIdV1Schema',
      'PluginUiRendererFamilyV1Schema',
      'PLUGIN_HOST_PLACEMENT_RENDERER_IDS',
      'PluginHostPlacementRendererIdV1Schema',
      'isRenderableHostRendererId',
      'PluginSurfacePlacementDescriptorV1Schema',
      'PluginSurfacePlacementKindV1Schema',
      'PluginSurfaceRendererRefV1Schema',
      'PLUGIN_UI_LEGACY_SURFACE_PLACEMENT_BINDINGS_V1',
      'PluginUiLegacySurfacePlacementDestinationBindingInputV1Schema',
      'normalizePluginUiLegacySurfacePlacementDestinationBindingV1',
      'resolvePluginUiLegacySurfacePlacementBindingV1',
      'PLUGIN_SURFACE_REGISTRY',
      'PluginUiActionKindV1Schema',
      'PluginUiActionDescriptorV1Schema',
    ]) {
      expect(ContributionUi, retiredExport).not.toHaveProperty(retiredExport);
      expect(PublicPluginUi, retiredExport).not.toHaveProperty(retiredExport);
    }
  });

  it('keeps the public declarative actionPanel grammar while rejecting a private requirement list', () => {
    const publicDeclarative = {
      id: 'actions',
      kind: 'declarative',
      root: {
        kind: 'actionPanel',
        children: [{ kind: 'action', action: 'refresh', label: 'Refresh' }],
      },
    };
    expect(PluginUiRendererV2Schema.safeParse(publicDeclarative).success).toBe(true);
    expect(PluginUiRendererV2Schema.safeParse({
      ...publicDeclarative,
      requiredHostMethods: ['executeAction'],
    }).success).toBe(false);
  });
});
