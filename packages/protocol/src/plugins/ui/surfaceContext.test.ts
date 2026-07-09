import { describe, expect, it } from 'vitest';

import {
  PluginUiSurfaceContextV1Schema,
  PluginUiSurfacePlacementV1Schema,
  resolvePluginUiSurfaceContextPlacement,
} from './surfaceContext.js';

describe('plugin UI surface context', () => {
  it('models concrete placement contexts for every generic plugin surface family', () => {
    expect(PluginUiSurfacePlacementV1Schema.options).toEqual([
      'structuredMessage',
      'sessionPane',
      'sessionHeaderAction',
      'workspaceSurface',
      'projectSurface',
      'appSurface',
      'browserSurface',
      'rightSidebarSurface',
      'servicesSurface',
      'unknown',
    ]);

    for (const placement of [
      'workspaceSurface',
      'projectSurface',
      'appSurface',
      'browserSurface',
      'rightSidebarSurface',
      'servicesSurface',
      'sessionPane',
    ] as const) {
      expect(PluginUiSurfaceContextV1Schema.parse({
        pluginId: 'acme.preview',
        contributionId: 'panel',
        surfaceId: `surface:${placement}`,
        placement,
        platform: 'web',
        channel: 'internal',
      }).placement).toBe(placement);
    }
  });

  it('derives host-api placement from the registered surface descriptor', () => {
    expect(resolvePluginUiSurfaceContextPlacement('session.details')).toBe('sessionPane');
    expect(resolvePluginUiSurfaceContextPlacement('session.headerAction')).toBe('sessionHeaderAction');
    expect(resolvePluginUiSurfaceContextPlacement('session.structuredMessage')).toBe('structuredMessage');
    expect(resolvePluginUiSurfaceContextPlacement('project.rightSidebarTab')).toBe('rightSidebarSurface');
    expect(resolvePluginUiSurfaceContextPlacement('browser.panel')).toBe('browserSurface');
    expect(resolvePluginUiSurfaceContextPlacement('services.panel')).toBe('servicesSurface');
    expect(resolvePluginUiSurfaceContextPlacement('missing.surface')).toBe('unknown');
  });
});
