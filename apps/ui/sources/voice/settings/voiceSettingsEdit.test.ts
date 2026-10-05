import { describe, expect, it, onTestFinished } from 'vitest';
import { voiceSettingsParse, readLocalConversationVoiceSettings, writeLocalConversationVoiceSettings } from '@/sync/domains/settings/voiceSettings';
import { rebaseVoiceSettingsEdit, voiceSettingsEditRegistry } from './voiceSettingsEdit';
import { createDefaultVoiceProviderRegistry } from '@/voice/registry/defaultRegistry';
import { selectVoiceProviderOption } from '@/voice/registry/providerSelection';
import { captureConversationLanguagePreferenceOwner } from './language/conversationLanguage';
import { commitExternalVoiceProviderRegistration, removeExternalVoiceProviderRegistration } from '@/voice/registry/externalVoiceProviderRegistrations';

describe('Voice settings edit intent', () => {
    it('retires a captured language editor even when bundled fallback metadata has the same entry identity', () => {
        const providerId = 'happier.voice.elevenlabs/realtime-elevenlabs';
        const entry = voiceSettingsEditRegistry.get(providerId);
        if (!entry) throw new Error('Missing published conversation entry');
        const token = {};
        commitExternalVoiceProviderRegistration({ token, pluginId: entry.pluginId, localId: 'realtime-elevenlabs', providerId, descriptor: entry, adapter: null });
        onTestFinished(() => removeExternalVoiceProviderRegistration(token));
        const current = voiceSettingsParse({ providerId });
        const admitted = captureConversationLanguagePreferenceOwner(providerId, voiceSettingsEditRegistry);
        expect(admitted(current)).toBe(true);
        removeExternalVoiceProviderRegistration(token);
        expect(voiceSettingsEditRegistry.get(providerId)).toBe(entry);
        expect(admitted(current)).toBe(false);
    });
    it('does not apply a coupled language edit to a replacement conversation consumer', () => {
        const before = voiceSettingsParse({ providerId: 'happier.voice.elevenlabs/realtime-elevenlabs', assistantLanguage: 'de' });
        const next = { ...before, assistantLanguage: 'fr' };
        const current = { ...before, providerId: 'happier.voice.openai/realtime-openai', assistantLanguage: 'en' };
        expect(() => rebaseVoiceSettingsEdit(current, before, next)).toThrow('voice_settings_provider_changed');
        expect(current).toMatchObject({ providerId: 'happier.voice.openai/realtime-openai', assistantLanguage: 'en' });
    });
    it('keeps the explicit service billing choice during a concurrent settings rebase', () => {
        const registry = createDefaultVoiceProviderRegistry();
        const providerId = 'happier.voice.elevenlabs/realtime-elevenlabs';
        const configured = selectVoiceProviderOption(voiceSettingsParse({}), registry, providerId, 'byo');
        if (!configured) throw new Error('Expected the published BYO option');
        const before = { ...configured, providerId: null };
        const next = selectVoiceProviderOption(before, registry, providerId, 'byo');
        const concurrent = selectVoiceProviderOption(before, registry, providerId, 'happier');
        if (!next || !concurrent) throw new Error('Expected published service options');
        const current = { ...concurrent, providerId: null, assistantLanguage: 'fr' };
        expect(rebaseVoiceSettingsEdit(current, before, next)).toMatchObject({
            providerId, assistantLanguage: 'fr', providers: { [providerId]: { config: { billingMode: 'byo' } } },
        });
    });
    it('rejects a stale provider edit when the current provider schema has advanced', () => {
        const before = voiceSettingsParse({});
        const cfg = readLocalConversationVoiceSettings(before);
        const next = writeLocalConversationVoiceSettings(before, { ...cfg, handsFree: { ...cfg.handsFree, enabled: true } });
        const current = { ...before, providers: { ...before.providers, local_conversation: { schemaVersion: 99, config: { retained: true } } } };
        expect(() => rebaseVoiceSettingsEdit(current, before, next)).toThrow('voice_settings_provider_changed');
        expect(current.providers.local_conversation).toEqual({ schemaVersion: 99, config: { retained: true } });
    });
    it('rebases a stale field edit without replacing concurrent Voice preferences or opaque provider settings', () => {
        const before = voiceSettingsParse({});
        const current = { ...before, assistantLanguage: 'fr', providers: { ...before.providers, 'fixture.voice/future': { schemaVersion: 99, config: { retained: true } } } };
        const next = { ...before, privacy: { ...before.privacy, recentMessagesCount: 8 } };
        expect(rebaseVoiceSettingsEdit(current, before, next)).toMatchObject({ assistantLanguage: 'fr', privacy: { recentMessagesCount: 8 }, providers: { 'fixture.voice/future': { schemaVersion: 99, config: { retained: true } } } });
    });
    it('replaces every Agent routing fact together even when a cleared fact equals the stale baseline', () => {
        const before = voiceSettingsParse({});
        const cfg = readLocalConversationVoiceSettings(before);
        const current = writeLocalConversationVoiceSettings(before, { ...cfg, agent: { ...cfg.agent, agentId: 'fixture', agentTargetKey: 'plugin:fixture/agent', agentIdentity: { pluginId: 'fixture', localId: 'agent' }, agentProjectionGeneration: 3 } });
        const next = writeLocalConversationVoiceSettings(before, { ...cfg, agent: { ...cfg.agent, agentId: 'custom' } });
        expect(readLocalConversationVoiceSettings(rebaseVoiceSettingsEdit(current, before, next)).agent).toMatchObject({ agentId: 'custom', agentTargetKey: null, agentIdentity: null, agentProjectionGeneration: null });
    });
});
