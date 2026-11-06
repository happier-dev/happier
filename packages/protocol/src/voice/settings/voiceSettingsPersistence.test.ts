import { describe, expect, it } from 'vitest';

import { accountSettingsParse } from '../../account/settings/accountSettings.js';
import { VoiceCredentialBindingV1Schema } from '../realtime/providerSettings.js';
import { createVoiceSettingsOwner } from './voiceSettings.js';
import { createVoiceSettingsPersistenceOwner } from './voiceSettingsPersistence.js';

describe('Voice settings persistence', () => {
  it.each([false, true])('retains a saved provider credential through an unrelated write and read (derived root omitted: %s)', omitDerivedRoot => {
    const owner = createVoiceSettingsPersistenceOwner({
      voiceOwner: createVoiceSettingsOwner({ bundledContributions: [] }),
    });
    const binding = VoiceCredentialBindingV1Schema.parse({
      contribution: { pluginId: 'happier.voice.xai', localId: 'realtime-grok' },
      credentialSlotId: 'api_key',
      credentialSource: { kind: 'savedSecret' },
      credentialBindings: { account: { api_key: 'saved-xai-key' } },
    });
    const raw = { voiceSettingsV1: { assistantLanguage: 'en', credentialBindings: [binding] } };
    const runtime = owner.projectVoiceSettingsIntoRuntimeSettings({ parsed: accountSettingsParse(raw), raw });
    const { voice: _derivedVoice, ...withoutDerivedRoot } = runtime;
    const current = omitDerivedRoot ? withoutDerivedRoot : runtime;

    const localDelta = owner.normalizeVoiceSettingsLocalDelta({
      voice: { ...runtime.voice, assistantLanguage: 'fr' },
    }, current);
    const persisted = owner.normalizeVoiceSettingsServerDelta(localDelta, current);
    expect(persisted).toMatchObject({ voiceSettingsV1: { credentialBindings: [binding] } });

    const { voice: _persistedDerivedVoice, ...canonicalRoots } = persisted;
    const saved = JSON.parse(JSON.stringify(omitDerivedRoot ? canonicalRoots : persisted));
    const reread = owner.projectVoiceSettingsIntoRuntimeSettings({ parsed: accountSettingsParse(saved), raw: saved });
    expect(reread.voiceSettingsV1.credentialBindings).toEqual([binding]);
    expect(reread.voice.assistantLanguage).toBe('fr');
    const normalized = owner.normalizeVoiceSettingsServerDelta(reread, saved);
    expect(normalized).toMatchObject({ voiceSettingsV1: { credentialBindings: [binding] } });
  });
});
