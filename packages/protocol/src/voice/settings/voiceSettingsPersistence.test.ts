import { describe, expect, it } from 'vitest';

import { accountSettingsParse } from '../../account/settings/accountSettings.js';
import { applyAccountSettingMutationV1 } from '../../account/settings/accountSettingMutationV1.js';
import { VoiceCredentialBindingV1Schema } from '../realtime/providerSettings.js';
import { createVoiceSettingsOwner } from './voiceSettings.js';
import { createVoiceSettingsPersistenceOwner } from './voiceSettingsPersistence.js';

describe('Voice settings persistence', () => {
  it('fans out all 65 legacy slots while retaining the first canonical binding for a duplicate identity', () => {
    const owner = createVoiceSettingsPersistenceOwner({
      voiceOwner: createVoiceSettingsOwner({ bundledContributions: [] }),
    });
    const canonical = VoiceCredentialBindingV1Schema.parse({
      contribution: { pluginId: 'happier.voice.xai', localId: 'realtime-grok' },
      credentialSlotId: 'slot_0',
      credentialSource: { kind: 'savedSecret' },
      credentialBindings: { account: { slot_0: 'canonical-secret' } },
    });
    const raw = { voiceSettingsV1: { credentialBindings: [canonical, {
      providerId: 'happier.voice.xai/realtime-grok',
      credentialBindings: { account: Object.fromEntries(
        Array.from({ length: 65 }, (_, index) => [`slot_${index}`, `legacy-secret-${index}`]),
      ) },
    }, canonical] } };
    const runtime = owner.projectVoiceSettingsIntoRuntimeSettings({ parsed: accountSettingsParse(raw), raw });

    expect(runtime.voiceSettingsV1.credentialBindings).toHaveLength(65);
    expect(runtime.voiceSettingsV1.credentialBindings[0]).toEqual(canonical);
    expect(runtime.voiceSettingsV1.credentialBindings[64]).toMatchObject({
      credentialSlotId: 'slot_64', credentialBindings: { account: { slot_64: 'legacy-secret-64' } },
    });
  });

  it.each([false, true])('retains 65 saved provider credentials through an unrelated write and read (derived root omitted: %s)', omitDerivedRoot => {
    const owner = createVoiceSettingsPersistenceOwner({
      voiceOwner: createVoiceSettingsOwner({ bundledContributions: [] }),
    });
    const bindings = Array.from({ length: 65 }, (_, index) => VoiceCredentialBindingV1Schema.parse({
      contribution: { pluginId: 'happier.voice.xai', localId: 'realtime-grok' },
      credentialSlotId: `api_key_${index}`,
      credentialSource: { kind: 'savedSecret' },
      credentialBindings: { account: { [`api_key_${index}`]: `saved-xai-key-${index}` } },
    }));
    const raw = { voiceSettingsV1: { assistantLanguage: 'en', credentialBindings: bindings } };
    const runtime = owner.projectVoiceSettingsIntoRuntimeSettings({ parsed: accountSettingsParse(raw), raw });
    const { voice: _derivedVoice, ...withoutDerivedRoot } = runtime;
    const current = omitDerivedRoot ? withoutDerivedRoot : runtime;

    const localDelta = owner.normalizeVoiceSettingsLocalDelta({
      voice: { ...runtime.voice, assistantLanguage: 'fr' },
    }, current);
    const persisted = owner.normalizeVoiceSettingsServerDelta(localDelta, current);
    expect(persisted).toMatchObject({ voiceSettingsV1: { credentialBindings: bindings } });

    const { voice: _persistedDerivedVoice, ...canonicalRoots } = persisted;
    const saved = JSON.parse(JSON.stringify(omitDerivedRoot ? canonicalRoots : persisted));
    const reread = owner.projectVoiceSettingsIntoRuntimeSettings({ parsed: accountSettingsParse(saved), raw: saved });
    expect(reread.voiceSettingsV1.credentialBindings).toEqual(bindings);
    expect(reread.voice.assistantLanguage).toBe('fr');
    const normalized = owner.normalizeVoiceSettingsServerDelta(reread, saved);
    expect(normalized).toMatchObject({ voiceSettingsV1: { credentialBindings: bindings } });
  });

  it.each([false, true])('removes an obsolete predecessor carrier when a mutation consumer persists a canonical privacy edit (canonical-only: %s)', canonicalOnly => {
    const owner = createVoiceSettingsPersistenceOwner({ voiceOwner: createVoiceSettingsOwner({ bundledContributions: [] }) });
    const raw = { favoriteMachines: ['neighbor'], voice: { assistantLanguage: 'fr', privacy: { shareSessionSummary: true } } };
    const runtime = owner.projectVoiceSettingsIntoRuntimeSettings({ parsed: accountSettingsParse(raw), raw });
    const local = owner.normalizeVoiceSettingsLocalDelta({
      voice: { ...runtime.voice, privacy: { ...runtime.voice.privacy, shareSessionSummary: false } },
    }, runtime);
    const { voice: _runtimeVoice, ...canonicalDelta } = local;
    const projection = owner.projectVoiceSettingsServerDelta(canonicalOnly ? canonicalDelta : local, raw);
    expect(projection.removedPersistedKeys).toEqual(['voice']);
    const applied = applyAccountSettingMutationV1(raw, { operations: [
      ...Object.entries(projection.delta).map(([key, value]) => ({ op: 'set', key, value })),
      ...projection.removedPersistedKeys.map(key => ({ op: 'reset', key })),
    ] });
    if (applied.status === 'invalid') throw new Error(applied.reason);
    expect(applied.raw).not.toHaveProperty('voice');
    expect(applied.raw.favoriteMachines).toEqual(['neighbor']);
    const reread = owner.projectVoiceSettingsIntoRuntimeSettings({ parsed: accountSettingsParse(applied.raw), raw: applied.raw });
    expect(reread.voice.privacy.shareSessionSummary).toBe(false);
    expect(reread.voice.assistantLanguage).toBe('fr');
  });

  it.each([false, true])('does not remove the retained transcript reset source during a preference edit (canonical-only: %s)', canonicalOnly => {
    const owner = createVoiceSettingsPersistenceOwner({ voiceOwner: createVoiceSettingsOwner({ bundledContributions: [] }) });
    const raw = { voice: { providerId: 'local_conversation', adapters: { local_conversation: {
      agent: { transcript: { persistenceMode: 'persistent', epoch: 4 } },
    } } } };
    const runtime = owner.projectVoiceSettingsIntoRuntimeSettings({ parsed: accountSettingsParse(raw), raw });
    const local = owner.normalizeVoiceSettingsLocalDelta({ voice: { ...runtime.voice, assistantLanguage: 'fr' } }, runtime);
    const { voice: _runtimeVoice, ...canonicalDelta } = local;
    const proposed = canonicalOnly ? canonicalDelta : local;
    const projection = owner.projectVoiceSettingsServerDelta(proposed, raw);
    expect(projection.removedPersistedKeys).toEqual([]);
    expect(projection.delta).toMatchObject({ voice: { adapters: { local_conversation: {
      agent: { transcript: { persistenceMode: 'persistent', epoch: 4 } },
    } } } });
    expect(owner.normalizeVoiceSettingsServerDelta(proposed, raw)).toEqual(projection.delta);
  });
});
