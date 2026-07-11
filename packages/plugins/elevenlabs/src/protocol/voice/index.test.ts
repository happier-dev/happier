import { describe, expect, it } from 'vitest';

import {
  BUNDLED_VOICE_UI_ENTRIES,
} from '../../ui/voice/index.js';
import {
  ElevenLabsVoiceProviderSettingsSchema,
} from './index.js';

describe('ElevenLabs versioned credential boundary', () => {
  it('keeps v1 secrets migration-readable while the v2 canonical schema rejects them', () => {
    const legacy = {
      billingMode: 'byo',
      byo: {
        agentId: 'agent_1',
        apiKey: { _isSecretValue: true, value: 'xi_secret' },
      },
    };

    expect(ElevenLabsVoiceProviderSettingsSchema.safeParse(legacy).success).toBe(false);
    const providerSettings = BUNDLED_VOICE_UI_ENTRIES[0].internal.providerSettings;
    expect(providerSettings.schemaVersion).toBe(2);
    expect(providerSettings.readLegacySecret(legacy)).toEqual(legacy.byo.apiKey);
    expect(providerSettings.migrateLegacy(legacy)?.config.byo).toEqual({ agentId: 'agent_1' });
    expect(JSON.stringify(providerSettings.projectAnalytics(legacy))).not.toContain('xi_secret');
    expect(JSON.stringify(providerSettings.defaultConfig)).not.toContain('apiKey');
  });
});
