import { describe, expect, it } from 'vitest';

import { voiceSettingsDefaults } from '@/sync/domains/settings/voiceSettings';
import { applyVoiceWelcomeSelection, resolveVoiceWelcomeSelection } from './welcome';

describe('voice welcome settings view model', () => {
  it('maps the shared setting to one provider-neutral selection', () => {
    expect(resolveVoiceWelcomeSelection({ enabled: false, mode: 'immediate', templateId: null })).toBe('off');
    expect(resolveVoiceWelcomeSelection({ enabled: true, mode: 'immediate', templateId: null })).toBe('immediate');
    expect(resolveVoiceWelcomeSelection({ enabled: true, mode: 'on_first_turn', templateId: null })).toBe('on_first_turn');
  });

  it('updates only the shared welcome setting and preserves provider envelopes', () => {
    const next = applyVoiceWelcomeSelection(voiceSettingsDefaults, 'on_first_turn');
    expect(next.welcome).toEqual({ enabled: true, mode: 'on_first_turn', templateId: null });
    expect(next.providers).toBe(voiceSettingsDefaults.providers);
    expect(JSON.stringify(next)).not.toContain('"adapters"');
  });
});
