import type { VoiceProviderSettingsPresentation } from '../../plugins/contributions/voiceProviders.js';
import { resolveVoiceProviderLanguagePreference } from '../../plugins/contributions/voiceProviders.js';
import type { VoiceSettings } from './voiceSettings.js';
import { projectVoiceProviderSettings, type VoiceSettingsRegistry } from './providerRegistry.js';

type ServiceLanguage = NonNullable<VoiceProviderSettingsPresentation['language']>;
export type ConversationLanguagePreference =
    | Readonly<{ kind: 'reply' }>
    | Readonly<{ kind: 'single_language'; supportedLanguageCodes: readonly string[] }>
    | Readonly<{ kind: 'unavailable' }>;

export function serviceLanguage(voice: VoiceSettings, registry: VoiceSettingsRegistry): ServiceLanguage | undefined {
    const entry = voice.providerId ? registry.get(voice.providerId) : null;
    if (entry?.kind !== 'voice.conversation-provider.v1' || !entry.providerSettings) return undefined;
    const envelope = voice.providers[entry.providerId];
    if (envelope && envelope.schemaVersion !== entry.providerSettings.schemaVersion) return undefined;
    if (!entry.providerSettings.parseConfig(envelope ? envelope.config : entry.providerSettings.defaultConfig)) return undefined;
    return entry.providerSettings.presentation?.language;
}

/** The root language belongs to the selected consumer's declared meaning. */
export function projectConversationLanguagePreference(voice: VoiceSettings, registry: VoiceSettingsRegistry): ConversationLanguagePreference {
    const providerId = voice.providerId;
    if (providerId === 'local_direct' || providerId === 'local_conversation') {
        const entry = registry.get(providerId);
        return entry?.kind === 'voice.conversation-provider.v1'
            && projectVoiceProviderSettings(entry, voice.providers[providerId] ?? null)?.status === 'ready'
            ? { kind: 'reply' } : { kind: 'unavailable' };
    }
    const language = serviceLanguage(voice, registry);
    return language?.kind === 'single_language' ? language : language ? { kind: 'reply' } : { kind: 'unavailable' };
}

export function updateConversationLanguagePreference(voice: VoiceSettings, value: string | null, registry: VoiceSettingsRegistry): VoiceSettings | null {
    const preference = projectConversationLanguagePreference(voice, registry);
    if (preference.kind === 'unavailable') return null;
    const language = preference.kind === 'single_language'
        ? resolveVoiceProviderLanguagePreference(value, preference.supportedLanguageCodes) : value;
    return value !== null && language === null ? null : { ...voice, assistantLanguage: language };
}
