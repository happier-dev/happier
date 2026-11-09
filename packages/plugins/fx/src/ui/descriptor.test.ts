import { readPluginTranslationResources } from '../../../../../scripts/testing/readPluginTranslationResources.js';

import { describe, expect, it } from 'vitest';

import { FX_UI_DESCRIPTOR } from './descriptor.js';

const PACKAGED_UI_TRANSLATIONS = readPluginTranslationResources(new URL('../../', import.meta.url));

describe('FX UI projection source', () => {
  /**
   * The descriptor is the single source of truth for the FX mark: the bundled
   * plugin generator renders `assets.svgIcon` into the UI projection, so a
   * placeholder here ships as the product logo. These assertions pin the
   * supplied artwork's own viewBox and glyph geometry rather than "some path
   * exists", because a wrong-but-well-formed path passes the latter.
   */
  it('carries the supplied FX mark as theme-colored descriptor geometry', () => {
    expect(FX_UI_DESCRIPTOR.assets.svgIcon.assetId).toBe('fx');
    expect(FX_UI_DESCRIPTOR.assets.svgIcon.viewBox).toBe('0 0 24 24');
    expect(FX_UI_DESCRIPTOR.assets.svgIcon.paths).toHaveLength(1);

    const [glyph] = FX_UI_DESCRIPTOR.assets.svgIcon.paths;
    // The supplied artwork hardcodes `fill="#000000"`, which is invisible on a
    // dark theme; the descriptor must carry the theme token instead.
    expect(glyph.fillToken).toBe('text.primary');
    expect(glyph).not.toHaveProperty('fill');
    // The supplied group declares `fill-rule="nonzero"`; the inner triangle is
    // a second subpath that an `evenodd` rule would punch out. `fillRule` is
    // the key the bundled-plugin generator reads, so a differently spelled
    // field would be silently dropped from the projection.
    expect(glyph.fillRule).toBe('nonzero');
    expect(glyph.d.startsWith('M10.5626937,0 C11.3535073,0 12.2803588,0.21227889')).toBe(true);
    expect(glyph.d.endsWith('L14.0174579,12.2613483 L15.9593612,14.8116848 Z')).toBe(true);
    // The glyph's descender crosses the viewBox origin; a redrawn or
    // re-exported mark loses these negative coordinates.
    expect(glyph.d).toContain('-0.148420708,22.9500388');
  });

  it('declares complete localized provider labels', () => {
    expect(FX_UI_DESCRIPTOR.display).toMatchObject({
      nameKey: 'agentInput.agent.fx',
      subtitleKey: 'profiles.aiBackend.fxSubtitleExperimental',
      localControl: true,
      picker: { cliGlyph: 'FX' },
    });
    for (const messages of Object.values(PACKAGED_UI_TRANSLATIONS)) {
      expect(messages['agentInput.agent.fx']).toBeTruthy();
      expect(messages['sessionInfo.fxSessionId']).toBeTruthy();
      expect(messages['sessionInfo.fxSessionIdCopied']).toBeTruthy();
    }
    expect(JSON.parse(JSON.stringify(FX_UI_DESCRIPTOR))).toEqual(FX_UI_DESCRIPTOR);
  });
});
