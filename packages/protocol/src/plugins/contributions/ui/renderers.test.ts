import { describe, expect, it } from 'vitest';

import {
  PLUGIN_HOST_PLACEMENT_RENDERER_IDS,
  PluginHostPlacementRendererIdV1Schema,
  PluginSessionSurfaceRendererIdV1Schema,
  isRenderableHostRendererId,
} from './renderers.js';

describe('plugin host placement renderer ids', () => {
  it('exposes a frozen, non-empty set of renderable host renderer ids', () => {
    expect(PLUGIN_HOST_PLACEMENT_RENDERER_IDS.length).toBeGreaterThan(0);
    expect(Object.isFrozen(PLUGIN_HOST_PLACEMENT_RENDERER_IDS)).toBe(true);
  });

  it('treats every declared host renderer id as renderable', () => {
    for (const rendererId of PLUGIN_HOST_PLACEMENT_RENDERER_IDS) {
      expect(isRenderableHostRendererId(rendererId)).toBe(true);
      expect(PluginHostPlacementRendererIdV1Schema.safeParse(rendererId).success).toBe(true);
    }
  });

  it('fails closed for unknown, empty, or non-string renderer ids', () => {
    expect(isRenderableHostRendererId('settingsDescriptorPanel')).toBe(false);
    expect(isRenderableHostRendererId('')).toBe(false);
    expect(isRenderableHostRendererId('   ')).toBe(false);
    expect(isRenderableHostRendererId(undefined)).toBe(false);
    expect(isRenderableHostRendererId(null)).toBe(false);
    expect(isRenderableHostRendererId(42)).toBe(false);
  });

  it('renders the canonical generic descriptor panel renderer id', () => {
    expect(isRenderableHostRendererId('descriptorPanel')).toBe(true);
  });

  it('Phase 1.4: unifies the 8 session-surface renderer ids into the one host-placement set', () => {
    for (const rendererId of PluginSessionSurfaceRendererIdV1Schema.options) {
      expect(PLUGIN_HOST_PLACEMENT_RENDERER_IDS).toContain(rendererId);
      expect(isRenderableHostRendererId(rendererId)).toBe(true);
    }
    expect(PLUGIN_HOST_PLACEMENT_RENDERER_IDS).toContain('descriptorPanel');
  });
});
