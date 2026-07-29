import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import {
  VoiceLocalSttSchema,
  type VoiceLocalSttSettings,
} from '@/sync/domains/settings/voiceLocalSttSettings';
import {
  VoiceLocalTtsSchema,
  type VoiceLocalTtsSettings,
} from '@/sync/domains/settings/voiceLocalTtsSettings';
import {
  DEFAULT_ADAPTIVE_INTERRUPTION_IGNORED_PHRASES,
  type AdaptiveInterruptionConfig,
} from '@/voice/runtime/input/resolveBackchannelDecision';
import {
  readLocalConversationVoiceSettings,
  readLocalDirectVoiceSettings,
  voiceSettingsParse,
} from '@/sync/domains/settings/voiceSettings';
import { resolveVoiceProviderIdFromSettings } from '@/voice/settings/resolveVoiceProviderId';

export function resolveLocalVoiceAdapterSettings(settings: any): {
  adapterId: 'local_direct' | 'local_conversation';
  config: any;
} {
  const voice = voiceSettingsParse(settings?.voice);
  const providerId = resolveVoiceProviderIdFromSettings(voice);
  if (providerId === 'local_direct') {
    return { adapterId: 'local_direct', config: readLocalDirectVoiceSettings(voice) };
  }
  if (providerId === 'local_conversation') {
    return { adapterId: 'local_conversation', config: readLocalConversationVoiceSettings(voice) };
  }
  return {
    adapterId: 'local_conversation',
    config: readLocalConversationVoiceSettings(voice),
  };
}

export function readLocalConversationSettingsFromAccountSettings(settings: any) {
  return readLocalConversationVoiceSettings(voiceSettingsParse(settings?.voice));
}

export function readLocalDirectSettingsFromAccountSettings(settings: any) {
  return readLocalDirectVoiceSettings(voiceSettingsParse(settings?.voice));
}

export function isLocalVoiceProviderSelected(settings: any): boolean {
  const providerId = resolveVoiceProviderIdFromSettings(voiceSettingsParse(settings?.voice));
  return providerId === 'local_direct' || providerId === 'local_conversation';
}

export function parseLocalVoiceSttSettings(value: unknown): VoiceLocalSttSettings {
  return VoiceLocalSttSchema.parse(value ?? {});
}

export function parseLocalVoiceTtsSettings(value: unknown): VoiceLocalTtsSettings {
  return VoiceLocalTtsSchema.parse(value ?? {});
}

export function resolveLocalSttProvider(settings: any): VoiceLocalSttSettings['provider'] {
  const { config } = resolveLocalVoiceAdapterSettings(settings);
  return parseLocalVoiceSttSettings(config?.stt).provider;
}

export function isHandsFreeDeviceSttEnabled(settings: any): boolean {
  const { config } = resolveLocalVoiceAdapterSettings(settings);
  return resolveLocalSttProvider(settings) === 'device' && config?.handsFree?.enabled === true;
}

export function isHandsFreeLocalNeuralSttEnabled(settings: any): boolean {
  const { config } = resolveLocalVoiceAdapterSettings(settings);
  return resolveLocalSttProvider(settings) === 'local_neural' && config?.handsFree?.enabled === true;
}

export function isVoiceBargeInEnabled(settings: any): boolean {
  const { config } = resolveLocalVoiceAdapterSettings(settings);
  return config?.tts?.bargeInEnabled === true;
}

export function resolveAdaptiveInterruptionConfig(): AdaptiveInterruptionConfig {
  // This is runtime policy, not a persisted setting. The local settings schema
  // intentionally has no adaptiveInterruption leaf or UI writer; keeping the
  // canonical defaults here avoids pretending an unknown, parsed-away field is
  // configurable.
  return {
    ignoredPhrases: DEFAULT_ADAPTIVE_INTERRUPTION_IGNORED_PHRASES,
  };
}

export function resolveLocalConversationControlSessionId(settings: any, sessionId: string): string {
  const { adapterId, config } = resolveLocalVoiceAdapterSettings(settings);
  if (adapterId === 'local_conversation' && (config?.conversationMode ?? 'direct_session') === 'agent') {
    return VOICE_AGENT_GLOBAL_SESSION_ID;
  }
  return sessionId;
}
