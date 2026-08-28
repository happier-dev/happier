import { describe, expect, it } from 'vitest';

import {
  PluginUiHostApiSurfaceContextV1Schema,
  PluginUiMountContextV1Schema,
  PluginUiSurfaceContextV1Schema,
  PluginUiSurfacePlacementV1Schema,
} from './surfaceContext.js';
import { PLUGIN_UI_DESTINATION_BINDING_SLOTS_V1 } from '../contributions/ui/surfaceRegistry.js';

describe('plugin UI surface context', () => {
  it('owns the complete strict author-facing Host API context separately from the private request key', () => {
    const surface = {
      mount: {
        kind: 'destination',
        destination: { pluginId: 'acme.preview', localId: 'details' },
        container: 'detailsPane',
      },
      target: { kind: 'session', sessionId: 'session-1', agentId: 'codex' },
      accountEncryptionMode: 'e2ee',
      platform: 'web',
      locale: 'en-GB',
      direction: 'ltr',
      colorScheme: 'dark',
      contrast: 'normal',
      textScale: 1,
      reducedMotion: false,
      screenReaderEnabled: false,
      safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 },
      theme: {
        version: 1,
        colors: {
          canvas: '#101010', surface: '#202020', elevatedSurface: '#303030', text: '#f0f0f0',
          secondaryText: '#c0c0c0', mutedText: '#909090', border: '#404040', divider: '#353535',
          focus: '#5599ff', accent: '#2277ee', onAccent: '#ffffff', success: '#34c759',
          warning: '#ff9500', danger: '#ff3b30', info: '#5856d6', control: '#252525',
          controlDisabled: '#454545', overlay: 'rgba(0, 0, 0, 0.5)',
        },
        spacing: { xsmall: 4, small: 8, medium: 12, large: 16, xlarge: 20 },
        radii: { small: 4, control: 8, panel: 12, pill: 999 },
        typography: {
          body: { fontSize: 13, lineHeight: 17, fontWeight: '400' },
          label: { fontSize: 11, lineHeight: 14, fontWeight: '500' },
          title: { fontSize: 15, lineHeight: 20, fontWeight: '500' },
          caption: { fontSize: 12, lineHeight: 16, fontWeight: '400' },
          code: { fontSize: 12, lineHeight: 16, fontFamily: 'IBMPlexMono-Regular' },
        },
      },
      translations: { 'plugin.title': 'Preview' },
      targetedContributions: {
        target: { pluginId: 'acme.preview', immutableGenerationId: 'target-generation-a' },
        points: [],
      },
    } as const;

    expect(PluginUiSurfaceContextV1Schema.safeParse(surface).success).toBe(false);
    expect(PluginUiHostApiSurfaceContextV1Schema.parse(surface)).toEqual(surface);
    expect(PluginUiHostApiSurfaceContextV1Schema.safeParse({
      ...surface,
      unexpected: true,
    }).success).toBe(false);
    expect(PluginUiHostApiSurfaceContextV1Schema.safeParse({
      ...surface,
      target: { kind: 'browser', targetId: 'browser-1', origin: 'https://happier.dev', extra: true },
    }).success).toBe(false);
  });

  it('models one closed public destination-or-embedded mount context', () => {
    expect(PluginUiMountContextV1Schema.parse({
      kind: 'destination',
      destination: { pluginId: 'acme.preview', localId: 'details' },
      container: 'detailsPane',
    })).toEqual({
      kind: 'destination',
      destination: { pluginId: 'acme.preview', localId: 'details' },
      container: 'detailsPane',
    });
    expect(PluginUiMountContextV1Schema.parse({
      kind: 'embedded',
      role: 'detail',
      presentation: 'content',
    })).toEqual({
      kind: 'embedded',
      role: 'detail',
      presentation: 'content',
    });
    expect(PluginUiMountContextV1Schema.safeParse({
      kind: 'destination',
      destination: { pluginId: 'acme.preview', localId: 'details' },
      container: 'detailsPane',
      role: 'detail',
    }).success).toBe(false);
    expect(PluginUiMountContextV1Schema.safeParse({
      kind: 'embedded',
      role: 'detail',
      presentation: 'content',
      destination: { pluginId: 'acme.preview', localId: 'invented' },
    }).success).toBe(false);
  });

  it('models concrete placement contexts for every generic plugin surface family', () => {
    expect(PluginUiSurfacePlacementV1Schema.options).toEqual([
      'structuredMessage',
      'sessionPane',
      'sessionHeaderAction',
      'projectSurface',
      'appSurface',
      'browserSurface',
      'rightSidebarSurface',
      'servicesSurface',
      'composerSurface',
      'ephemeralSurface',
      'unknown',
    ]);

    for (const placement of [
      'projectSurface',
      'appSurface',
      'browserSurface',
      'rightSidebarSurface',
      'servicesSurface',
      'sessionPane',
      'composerSurface',
      'ephemeralSurface',
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

  it('keeps direct destination contexts registry-derived and semantic contexts outside mounted slots', () => {
    const destinationPlacements = new Set(
      PLUGIN_UI_DESTINATION_BINDING_SLOTS_V1.map((slot) => slot.surfaceContextPlacement),
    );

    expect(destinationPlacements).toEqual(new Set([
      'sessionPane',
      'projectSurface',
      'appSurface',
      'browserSurface',
      'rightSidebarSurface',
      'servicesSurface',
    ]));
    expect(destinationPlacements.has('structuredMessage')).toBe(false);
    expect(destinationPlacements.has('sessionHeaderAction')).toBe(false);
    expect(destinationPlacements.has('unknown')).toBe(false);
  });
});
