import { serviceLanguage, projectConversationLanguagePreference, updateConversationLanguagePreference } from '@happier-dev/protocol/voice/settings/conversationLanguage';
export { projectConversationLanguagePreference, updateConversationLanguagePreference, type ConversationLanguagePreference } from '@happier-dev/protocol/voice/settings/conversationLanguage';
import { type VoiceSettings } from '@/sync/domains/settings/voiceSettings';
import {
  parseLocalVoiceSttSettings,
  parseLocalVoiceTtsSettings,
  resolveLocalVoiceAdapterSettings,
  resolveLocalVoiceRecognitionLanguage,
} from '@/voice/local/localVoiceSettings';
import { resolveStoredVoiceProviderId, resolveVoiceProviderIdFromSettings } from '@/voice/settings/resolveVoiceProviderId';
import type { VoiceProviderSettingsPresentation } from '@happier-dev/protocol';
import { createDefaultVoiceProviderRegistry } from '@/voice/registry/defaultRegistry';
import type { VoiceProviderRegistry } from '@/voice/registry/providerRegistry';
import { getExternalVoiceProviderProjectionAuthority, getExternalVoiceProviderRegistration } from '@/voice/registry/externalVoiceProviderRegistrations';

const languageRegistry = createDefaultVoiceProviderRegistry();
type ServiceLanguage = NonNullable<VoiceProviderSettingsPresentation['language']>;

/** Capture the selected contribution's existing activation/projection authority, not a generation. */
export function captureConversationLanguagePreferenceOwner(providerId: string | null, registry: VoiceProviderRegistry): (current: VoiceSettings) => boolean {
  const entry = providerId ? registry.get(providerId) : null;
  const registration = providerId ? getExternalVoiceProviderRegistration(providerId) : null;
  const authority = getExternalVoiceProviderProjectionAuthority();
  const occurrence = providerId ? authority?.get(providerId) : undefined;
  return (current) => {
    if (current.providerId !== providerId || !providerId || registry.get(providerId) !== entry) return false;
    if (entry?.source.kind === 'built_in') return true;
    const latestAuthority = getExternalVoiceProviderProjectionAuthority();
    return getExternalVoiceProviderRegistration(providerId) === registration
      && (latestAuthority === null) === (authority === null)
      && latestAuthority?.get(providerId) === occurrence;
  };
}

/** The language the speech engine listens for, and where that comes from. */
export type VoiceRecognitionLanguage =
  | Readonly<{ kind: 'explicit'; language: string }>
  | Readonly<{ kind: 'engine_default' }>;

export type VoiceOutputVoice =
  | Readonly<{ kind: 'engine_voice'; voiceId: string | null }>
  | Readonly<{ kind: 'device' }>
  /** Chosen in the Speak engine's own settings. */
  | Readonly<{ kind: 'engine' }>;

export type ConversationLanguageProjection =
  | Readonly<{ mode: 'off' }>
  | Readonly<{ mode: 'unavailable' }>
  /** A realtime service contributes the meaning of Happier's one language preference. */
  | Readonly<{ mode: 'service'; language?: ServiceLanguage }>
  | Readonly<{
    mode: 'local';
    sttProvider: string;
    ttsProvider: string;
    recognition: VoiceRecognitionLanguage;
    outputVoice: VoiceOutputVoice;
  }>;

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Conversations → Language. "I speak" is recognition, "Reply in" is `assistantLanguage` (the reply
 * preference), "Voice" is the Speak engine's output voice. It reads the same facts the speech runtime
 * reads. An unset recognition language means the engine default, not the reply language.
 */
export function projectConversationLanguage(voice: VoiceSettings, registry: VoiceProviderRegistry = languageRegistry): ConversationLanguageProjection {
  const providerId = resolveStoredVoiceProviderId(voice.providerId);
  if (!providerId) return { mode: 'off' };
  if (providerId !== 'local_direct' && providerId !== 'local_conversation') {
    const language = serviceLanguage(voice, registry);
    return { mode: 'service', ...(language ? { language } : {}) };
  }

  if (resolveVoiceProviderIdFromSettings(voice, registry) !== providerId) return { mode: 'unavailable' };

  const { config } = resolveLocalVoiceAdapterSettings({ voice });
  const stt = parseLocalVoiceSttSettings(config?.stt);
  const tts = parseLocalVoiceTtsSettings(config?.tts);
  const language = resolveLocalVoiceRecognitionLanguage({ voice });
  const recognition: VoiceRecognitionLanguage = language
    ? { kind: 'explicit', language } : { kind: 'engine_default' };

  const outputVoice: VoiceOutputVoice = tts.provider === 'local_neural'
    ? { kind: 'engine_voice', voiceId: nonEmpty(tts.localNeural?.voiceId) }
    : tts.provider === 'device' ? { kind: 'device' } : { kind: 'engine' };

  return { mode: 'local', sttProvider: stt.provider, ttsProvider: tts.provider, recognition, outputVoice };
}
