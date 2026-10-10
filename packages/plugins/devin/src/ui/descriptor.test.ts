import { describe, expect, it } from 'vitest';

import { DEVIN_UI_DESCRIPTOR } from './descriptor.js';
import { DEVIN_UI_TRANSLATIONS } from './translations.js';

describe('Devin UI projection source', () => {
  it('uses the supplied theme-safe logo and complete localized provider labels', () => {
    expect(DEVIN_UI_DESCRIPTOR.display).toMatchObject({
      nameKey: 'agentInput.agent.devin',
      subtitleKey: 'profiles.aiBackend.devinSubtitleExperimental',
      permissions: { modeGroup: 'codexLike', promptProtocol: 'codexDecision' },
      localControl: true,
      picker: { iconName: 'cpu', cliGlyph: 'DV' },
    });
    expect(DEVIN_UI_DESCRIPTOR.assets.svgIcon).toMatchObject({
      assetId: 'devin',
      viewBox: '0 0 256 294',
      paths: [{
        fillToken: 'text.primary',
        d: expect.stringMatching(/^M0,98\.5741786/),
      }],
    });
    expect(DEVIN_UI_DESCRIPTOR.capabilityStates.mcpDelivery).toBe('supported');
    for (const messages of Object.values(DEVIN_UI_TRANSLATIONS)) {
      expect(messages).toMatchObject({
        'agentInput.agent.devin': 'Devin',
        'settingsAgents.plugins.devin.title': 'Devin',
      });
      expect(messages['sessionInfo.devinSessionId']).toBeTruthy();
      expect(messages['sessionInfo.devinSessionIdCopied']).toBeTruthy();
    }
    expect(JSON.parse(JSON.stringify(DEVIN_UI_DESCRIPTOR))).toEqual(DEVIN_UI_DESCRIPTOR);
  });
});
