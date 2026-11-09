import { readPluginTranslationResources } from '../../../../../scripts/testing/readPluginTranslationResources.js';

import { describe, expect, it } from 'vitest';

import { DROID_UI_DESCRIPTOR } from './descriptor.js';

const PACKAGED_UI_TRANSLATIONS = readPluginTranslationResources(new URL('../../', import.meta.url));

describe('Factory Droid UI projection source', () => {
  /**
   * The descriptor is the single source of truth for the Droid mark: the
   * bundled plugin generator renders `assets.svgIcon` into the UI projection,
   * so a placeholder here ships as the product logo. These assertions pin the
   * supplied artwork's own viewBox and glyph geometry rather than "some path
   * exists", because a wrong-but-well-formed path passes the latter.
   */
  it('carries the supplied Droid mark as theme-colored descriptor geometry', () => {
    expect(DROID_UI_DESCRIPTOR.assets.svgIcon.assetId).toBe('droid');
    expect(DROID_UI_DESCRIPTOR.assets.svgIcon.viewBox).toBe('0 0 67 65');
    expect(DROID_UI_DESCRIPTOR.assets.svgIcon.paths).toHaveLength(1);

    const [glyph] = DROID_UI_DESCRIPTOR.assets.svgIcon.paths;
    // The supplied artwork paints with `currentColor`; the descriptor carries
    // the resolved theme token because the generated projection sets `fill`
    // explicitly and inherits no color from its host.
    expect(glyph.fillToken).toBe('text.primary');
    expect(glyph.d.startsWith('M47.75 11.15a.867.867 0 0 1-.671-.806')).toBe(true);
    expect(glyph.d.endsWith('c4.797 1.377 12.37 4.359 11.672 6.762')).toBe(true);
    // The mark is one continuous sunburst outline; a redrawn placeholder loses
    // these interior sub-path moves.
    expect(glyph.d).toContain('m-5.546-4.518c.93 1.624-3.858 12.446-7.42 20.015');
  });

  it('declares complete localized provider labels', () => {
    expect(DROID_UI_DESCRIPTOR.display).toMatchObject({
      nameKey: 'agentInput.agent.droid',
      subtitleKey: 'profiles.aiBackend.droidSubtitleExperimental',
      localControl: true,
      picker: { cliGlyph: 'DR' },
    });
    for (const messages of Object.values(PACKAGED_UI_TRANSLATIONS)) {
      expect(messages['agentInput.agent.droid']).toBeTruthy();
      expect(messages['sessionInfo.droidSessionId']).toBeTruthy();
      expect(messages['sessionInfo.droidSessionIdCopied']).toBeTruthy();
    }
    expect(JSON.parse(JSON.stringify(DROID_UI_DESCRIPTOR))).toEqual(DROID_UI_DESCRIPTOR);
  });
});
