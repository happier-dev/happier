import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';
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

export function resolveLocalVoiceAdapterSettings(settings: any): {
  adapterId: 'local_direct' | 'local_conversation';
  config: any;
} {
  const voice = settings?.voice ?? null;
  const providerId = normalizeNonEmptyString(voice?.providerId);
  if (providerId === 'local_direct') {
    return { adapterId: 'local_direct', config: voice?.adapters?.local_direct ?? {} };
  }
  if (providerId === 'local_conversation') {
    return { adapterId: 'local_conversation', config: voice?.adapters?.local_conversation ?? {} };
  }
  return {
    adapterId: 'local_conversation',
    config: voice?.adapters?.local_conversation ?? voice?.adapters?.local_direct ?? {},
  };
}

export function isLocalVoiceProviderSelected(settings: any): boolean {
  const providerId = normalizeNonEmptyString(settings?.voice?.providerId) ?? '';
  return providerId.length === 0 || providerId === 'local_direct' || providerId === 'local_conversation';
}

export function parseLocalVoiceSttSettings(value: unknown): VoiceLocalSttSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return VoiceLocalSttSchema.parse(value ?? {});
  }
  const raw = value as Record<string, unknown>;
  const provider = normalizeNonEmptyString(raw.provider);
  const hasCanonicalFields =
    'provider' in raw || 'openaiCompat' in raw || 'googleGemini' in raw || 'localNeural' in raw;
  if (!hasCanonicalFields && ('baseUrl' in raw || 'useDeviceStt' in raw || 'model' in raw || 'apiKey' in raw)) {
    return VoiceLocalSttSchema.parse({
      provider: raw.useDeviceStt === true ? 'device' : 'openai_compat',
      openaiCompat: {
        baseUrl: normalizeNonEmptyString(raw.baseUrl),
        apiKey: raw.apiKey ?? null,
        model: normalizeNonEmptyString(raw.model) ?? 'whisper-1',
      },
    });
  }
  return VoiceLocalSttSchema.parse({
    ...raw,
    ...(provider ? { provider } : {}),
  });
}

export function parseLocalVoiceTtsSettings(value: unknown): VoiceLocalTtsSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return VoiceLocalTtsSchema.parse(value ?? {});
  }
  const raw = value as Record<string, unknown>;
  const provider = normalizeNonEmptyString(raw.provider);
  const hasCanonicalFields = 'provider' in raw || 'openaiCompat' in raw || 'localNeural' in raw || 'googleCloud' in raw;
  if (!hasCanonicalFields && ('baseUrl' in raw || 'useDeviceTts' in raw || 'format' in raw || 'voice' in raw || 'model' in raw)) {
    const format = normalizeNonEmptyString(raw.format) === 'wav' ? 'wav' : 'mp3';
    return VoiceLocalTtsSchema.parse({
      provider: raw.useDeviceTts === true ? 'device' : 'openai_compat',
      openaiCompat: {
        baseUrl: normalizeNonEmptyString(raw.baseUrl),
        apiKey: raw.apiKey ?? null,
        model: normalizeNonEmptyString(raw.model) ?? 'tts-1',
        voice: normalizeNonEmptyString(raw.voice) ?? 'alloy',
        format,
      },
      autoSpeakReplies: raw.autoSpeakReplies !== false,
      bargeInEnabled: raw.bargeInEnabled !== false,
    });
  }
  if ('kokoro' in raw || provider === 'kokoro') {
    const kokoro = raw.kokoro && typeof raw.kokoro === 'object' && !Array.isArray(raw.kokoro)
      ? (raw.kokoro as Record<string, unknown>)
      : {};
    const speed = typeof kokoro.speed === 'number' && Number.isFinite(kokoro.speed) ? kokoro.speed : null;
    return VoiceLocalTtsSchema.parse({
      provider: raw.provider === 'device' ? 'device' : 'local_neural',
      localNeural: {
        model: 'kokoro',
        assetId: normalizeNonEmptyString(kokoro.assetSetId),
        voiceId: normalizeNonEmptyString(kokoro.voiceId),
        speed,
        execution: 'auto',
      },
      autoSpeakReplies: raw.autoSpeakReplies !== false,
      bargeInEnabled: raw.bargeInEnabled !== false,
    });
  }
  return VoiceLocalTtsSchema.parse({
    ...raw,
    ...(provider ? { provider } : {}),
  });
}

export function resolveLocalSttProvider(settings: any): 'device' | 'openai_compat' | 'google_gemini' | 'local_neural' {
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

export function resolveAdaptiveInterruptionConfig(settings: any): AdaptiveInterruptionConfig {
  const { config } = resolveLocalVoiceAdapterSettings(settings);
  const rawIgnoredPhrases: readonly unknown[] | null = Array.isArray(config?.handsFree?.adaptiveInterruption?.ignoredPhrases)
    ? config.handsFree.adaptiveInterruption.ignoredPhrases
    : null;
  const ignoredPhrases = (rawIgnoredPhrases ?? DEFAULT_ADAPTIVE_INTERRUPTION_IGNORED_PHRASES)
    .map((phrase) => normalizeNonEmptyString(phrase))
    .filter((phrase): phrase is string => phrase !== null);

  return {
    ignoredPhrases,
  };
}

export function resolveLocalConversationControlSessionId(settings: any, sessionId: string): string {
  const { adapterId, config } = resolveLocalVoiceAdapterSettings(settings);
  if (adapterId === 'local_conversation' && (config?.conversationMode ?? 'direct_session') === 'agent') {
    return VOICE_AGENT_GLOBAL_SESSION_ID;
  }
  return sessionId;
}
