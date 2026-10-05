import { describe, expect, it } from 'vitest';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { readLocalDirectVoiceSettings, writeLocalDirectVoiceSettings } from '@/sync/domains/settings/voiceSettings';
import { SETTING_VALUE_UNAVAILABLE } from '@/components/settings/catalog/settingDeclarations';
import { voiceAgentSelectionBinding, voiceLocalConversationBinding, voiceSettingBinding } from './voiceSettingBinding';
import { voiceMemoryRestoreBinding } from './memoryRestore';

describe('Voice nested declaration mutations', () => {
    it('changes reply language independently from recognition, output voice and Dictation', () => {
        const binding = voiceSettingBinding('assistantLanguage');
        if (!('kind' in binding) || binding.kind !== 'owner') throw new Error('Expected the reply-language owner');
        const parsed = binding.parse('fr');
        expect(parsed.success).toBe(true);
        if (!parsed.success) return;
        const settings = { ...settingsDefaults, voice: { ...settingsDefaults.voice, providerId: 'local_direct' } };
        const next = binding.mutate(settings, parsed.value);
        expect(next?.voice?.assistantLanguage).toBe('fr');
        expect(next?.voice?.dictation).toEqual(settingsDefaults.voice.dictation);
        expect(next?.voice?.providers).toEqual(settingsDefaults.voice.providers);
        expect(binding.parse(null)).toEqual({ success: true, value: null });
    });
    it('edits the selected direct-session speech settings rather than another adapter', () => {
        const directVoice = { ...settingsDefaults.voice, providerId: 'local_direct' as const };
        const voice = writeLocalDirectVoiceSettings(directVoice, { ...readLocalDirectVoiceSettings(directVoice),
            tts: { ...readLocalDirectVoiceSettings(directVoice).tts, localNeural: {
                ...readLocalDirectVoiceSettings(directVoice).tts.localNeural, speed: 1,
            } },
        });
        const binding = voiceLocalConversationBinding('tts.localNeural.speed');
        if (!('kind' in binding) || binding.kind !== 'owner') throw new Error('Expected the domain owner binding');
        const settings = { ...settingsDefaults, voice };
        expect(binding.read(settings)).toBe(1);
        const parsed = binding.parse(0.8);
        expect(parsed.success).toBe(true);
        if (!parsed.success) return;
        const next = binding.mutate(settings, parsed.value);
        expect(next?.voice && readLocalDirectVoiceSettings(next.voice).tts.localNeural.speed).toBe(0.8);
        expect(next?.voice?.providers.local_conversation).toEqual(voice.providers.local_conversation);
        expect(binding.parse(3).success).toBe(false);
    });
    it('applies the Dictation engine and binding mode together without changing Conversations', () => {
        const binding = voiceSettingBinding('dictation.stt.provider');
        if (!('kind' in binding) || binding.kind !== 'owner') throw new Error('Expected the domain owner binding');
        const initial = { ...settingsDefaults, voice: { ...settingsDefaults.voice, dictation: {
            ...settingsDefaults.voice.dictation, sttBinding: 'same_as_local' as const,
        } } };
        const explicit = binding.mutate(initial, 'device');
        expect(explicit).toMatchObject({ voice: { providerId: initial.voice.providerId, dictation: { sttBinding: 'explicit', stt: { provider: 'device' } } } });
        const linked = binding.parse('same_as_local');
        expect(linked.success).toBe(true);
        if (linked.success) expect(binding.mutate(initial, linked.value)).toMatchObject({ voice: { dictation: { sttBinding: 'same_as_local' } } });
    });
    it('selects the published service and billing option as one explicit choice', () => {
        const binding = voiceSettingBinding('providerId');
        if (!('kind' in binding) || binding.kind !== 'owner') throw new Error('Expected the domain owner binding');
        const choice = JSON.stringify({ providerId: 'happier.voice.elevenlabs/realtime-elevenlabs', optionId: 'byo' });
        const parsed = binding.parse(choice);
        expect(parsed.success).toBe(true);
        if (!parsed.success) return;
        expect(binding.mutate(settingsDefaults, parsed.value)).toMatchObject({ voice: {
            providerId: 'happier.voice.elevenlabs/realtime-elevenlabs',
            providers: { 'happier.voice.elevenlabs/realtime-elevenlabs': { config: { billingMode: 'byo' } } },
        } });
    });
    it('refuses to replace opaque newer local-conversation settings with readable defaults', () => {
        const settings = { ...settingsDefaults, voice: { ...settingsDefaults.voice, providers: {
            ...settingsDefaults.voice.providers,
            local_conversation: { schemaVersion: 99, config: { retained: true } },
        } } };
        const field = voiceLocalConversationBinding('handsFree.enabled');
        if (!('kind' in field) || field.kind !== 'owner') throw new Error('Expected the domain owner binding');
        expect(field.read(settings)).toBe(SETTING_VALUE_UNAVAILABLE);
        expect(field.mutate(settings, true)).toBeNull();
        if (!('kind' in voiceMemoryRestoreBinding) || voiceMemoryRestoreBinding.kind !== 'owner') throw new Error('Expected the memory owner binding');
        expect(voiceMemoryRestoreBinding.read(settings)).toBe(SETTING_VALUE_UNAVAILABLE);
        expect(voiceMemoryRestoreBinding.mutate(settings, 'recent_messages')).toBeNull();
        expect(settings.voice.providers.local_conversation).toEqual({ schemaVersion: 99, config: { retained: true } });
    });
    it('refuses Agent preparation against the same opaque local-conversation envelope', async () => {
        const settings = { ...settingsDefaults, voice: { ...settingsDefaults.voice, providers: {
            ...settingsDefaults.voice.providers,
            local_conversation: { schemaVersion: 99, config: { retained: true } },
        } } };
        if (!('kind' in voiceAgentSelectionBinding) || voiceAgentSelectionBinding.kind !== 'owner') throw new Error('Expected the domain owner binding');
        expect(voiceAgentSelectionBinding.read(settings)).toBe(SETTING_VALUE_UNAVAILABLE);
        expect(await voiceAgentSelectionBinding.prepare?.(settings, 'codex', {})).toBeNull();
    });
});
