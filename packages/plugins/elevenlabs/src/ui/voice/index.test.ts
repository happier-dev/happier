import { describe, expect, it } from 'vitest';

import { BUNDLED_VOICE_UI_ENTRIES } from './index.js';

describe('ElevenLabs bundled voice UI contribution', () => {
  it('owns its versioned settings defaults, validation, and legacy root-field migration', () => {
    const internal = BUNDLED_VOICE_UI_ENTRIES[0]?.internal;
    expect(internal.providerSettings.schemaVersion).toBe(2);
    expect(internal.providerSettings.defaultConfig).toMatchObject({ billingMode: 'happier' });
    expect(internal.providerSettings.parseConfig({ billingMode: 'unsupported' })).toBeNull();
    expect(internal.providerSettings.parseConfig({ billingMode: 'byo', assistantLanguage: 'fr' })).toBeNull();
    expect(internal.providerSettings.migrateLegacy({
      assistantLanguage: 'fr',
      billingMode: 'byo',
      byo: { agentId: 'agent_1', apiKey: { _isSecretValue: true, value: 'xi_legacy' } },
      welcome: { enabled: true, mode: 'on_first_turn', templateId: 'hello' },
    })).toMatchObject({
      config: { billingMode: 'byo', byo: { agentId: 'agent_1' } },
      root: {
        assistantLanguage: 'fr',
        welcome: { enabled: true, mode: 'on_first_turn', templateId: 'hello' },
      },
    });
    expect(JSON.stringify(internal.providerSettings.migrateLegacy({
      billingMode: 'byo',
      byo: { agentId: 'agent_1', apiKey: { _isSecretValue: true, value: 'xi_legacy' } },
    })?.config)).not.toContain('xi_legacy');
  });

  it('owns its settings and daemon-client factories behind the internal first-party boundary', () => {
    const internal = BUNDLED_VOICE_UI_ENTRIES[0]?.internal;
    expect(typeof internal.createSettingsSection).toBe('function');
    expect(typeof internal.createDaemonClient).toBe('function');
  });

  it('owns the executable conversation-adapter factory instead of leaving it in the host', () => {
    const internal = BUNDLED_VOICE_UI_ENTRIES[0]?.internal;

    expect(internal).toEqual(expect.objectContaining({
      createAdapter: expect.any(Function),
    }));
  });
});
