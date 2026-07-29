import { describe, expect, it } from 'vitest';

import { GROK_UI_DESCRIPTOR } from './descriptor.js';
import { GROK_UI_TRANSLATIONS } from './translations.js';

describe('Grok UI projection source', () => {
  it('owns its bounded CLI glyph, picker scale, translations, and theme-safe official icon', () => {
    expect(GROK_UI_DESCRIPTOR.display.picker).toMatchObject({
      iconScale: 1.25, cliGlyph: 'G', cliGlyphScale: 1.25,
    });
    expect(GROK_UI_TRANSLATIONS.en['agentInput.agent.grok']).toBe('Grok');
    expect(GROK_UI_DESCRIPTOR.assets.svgIcon).toMatchObject({
      assetId: 'grok', viewBox: '0 0 1024 1024',
      paths: [{ fillToken: 'text.primary' }, { fillToken: 'text.primary' }],
    });
  });
});
