import { readPluginTranslationResources } from '../../../../../scripts/testing/readPluginTranslationResources.js';

import { describe, expect, it } from 'vitest';

import { GROK_UI_DESCRIPTOR } from './descriptor.js';

const PACKAGED_UI_TRANSLATIONS = readPluginTranslationResources(new URL('../../', import.meta.url));

describe('Grok UI projection source', () => {
  it('owns its bounded CLI glyph, picker scale, translations, and theme-safe official icon', () => {
    expect(GROK_UI_DESCRIPTOR.display.picker).toMatchObject({
      iconScale: 1.25, cliGlyph: 'G', cliGlyphScale: 1.25,
    });
    expect(PACKAGED_UI_TRANSLATIONS.en['agentInput.agent.grok']).toBe('Grok');
    expect(GROK_UI_DESCRIPTOR.assets.svgIcon).toMatchObject({
      path: 'assets/agent-mark.svg',
    });
  });
});
