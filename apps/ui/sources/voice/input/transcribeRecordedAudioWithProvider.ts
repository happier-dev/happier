import { Platform } from 'react-native';

import { sync } from '@/sync/sync';
import { MissingSttBaseUrlError, transcribeRecordedAudioWithHttpStt } from '@/voice/input/HttpSttController';
import { transcribeWithGoogleGeminiStt } from '@/voice/input/googleGeminiStt';
import { resolveVoiceNetworkTimeoutMs } from '@/voice/runtime/fetchWithTimeout';

export { MissingSttBaseUrlError };

export class MissingGeminiApiKeyError extends Error {
  constructor() {
    super('missing_gemini_api_key');
    this.name = 'MissingGeminiApiKeyError';
  }
}

function resolveLocalAdapter(settings: any): any {
  const voice = settings?.voice ?? null;
  const providerId = voice?.providerId;
  if (providerId === 'local_direct') return voice?.adapters?.local_direct ?? null;
  if (providerId === 'local_conversation') return voice?.adapters?.local_conversation ?? voice?.adapters?.local_direct ?? null;
  return voice?.adapters?.local_conversation ?? voice?.adapters?.local_direct ?? null;
}

function resolveSttProvider(adapter: any): 'device' | 'openai_compat' | 'google_gemini' | 'local_neural' {
  const stt = adapter?.stt ?? null;
  const provider = typeof stt?.provider === 'string' ? stt.provider : null;
  if (provider === 'device' || provider === 'openai_compat' || provider === 'google_gemini' || provider === 'local_neural') return provider;
  if (stt?.useDeviceStt === true) return 'device';
  return 'openai_compat';
}

function guessMimeType(uri: string): string {
  const lower = uri.toLowerCase();
  if (lower.endsWith('.webm')) return 'audio/webm';
  if (lower.endsWith('.wav')) return 'audio/wav';
  if (lower.endsWith('.mp3')) return 'audio/mpeg';
  return 'audio/mp4';
}

export async function transcribeRecordedAudioWithProvider(params: {
  uri: string;
  settings: any;
  decryptSecretValue?: (value: unknown) => string | null;
}): Promise<string | null> {
  const decryptSecretValue = params.decryptSecretValue ?? ((value: unknown) => sync.decryptSecretValue(value as any));
  const adapter = resolveLocalAdapter(params.settings);
  const provider = resolveSttProvider(adapter);

  // Local neural STT is streaming-based (no file upload). File transcription is a no-op.
  // The live controller is responsible for capturing audio and producing transcripts.
  if (provider === 'local_neural') {
    return null;
  }

  if (provider === 'openai_compat') {
    return await transcribeRecordedAudioWithHttpStt({ uri: params.uri, settings: params.settings });
  }

  if (provider === 'google_gemini') {
    const stt = adapter?.stt ?? null;
    const googleGemini = (stt?.googleGemini ?? null) as any;
    const apiKey = googleGemini?.apiKey ? (decryptSecretValue(googleGemini.apiKey) ?? null) : null;
    if (!apiKey) {
      throw new MissingGeminiApiKeyError();
    }

    const model = typeof googleGemini?.model === 'string' && googleGemini.model.trim() ? googleGemini.model.trim() : 'gemini-2.5-flash';
    const language =
      typeof googleGemini?.language === 'string' && googleGemini.language.trim()
        ? googleGemini.language.trim()
        : typeof params.settings?.voice?.assistantLanguage === 'string' && params.settings.voice.assistantLanguage.trim()
          ? params.settings.voice.assistantLanguage.trim()
          : null;

    const timeoutMs = resolveVoiceNetworkTimeoutMs(adapter?.networkTimeoutMs, 15_000);
    const uri = params.uri;

    if (Platform.OS === 'web' && uri.startsWith('blob:')) {
      const blob = await (await fetch(uri)).blob();
      const text = await transcribeWithGoogleGeminiStt({
        apiKey,
        model,
        audio: { kind: 'web', blob, mimeType: blob.type || 'audio/webm' },
        language,
        timeoutMs,
      });
      return text ? text.trim() || null : null;
    }

    const text = await transcribeWithGoogleGeminiStt({
      apiKey,
      model,
      audio: { kind: 'native', uri, mimeType: guessMimeType(uri) },
      language,
      timeoutMs,
    });
    return text ? text.trim() || null : null;
  }

  // Device STT is handled by the live recognizer controller, not file transcription.
  return null;
}
