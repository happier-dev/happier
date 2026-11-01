import { Platform } from 'react-native';

import { sync } from '@/sync/sync';
import { runtimeFetch } from '@/utils/system/runtimeFetch';
import { MissingSttBaseUrlError, transcribeRecordedAudioWithHttpStt } from '@/voice/input/HttpSttController';
import { transcribeWithGoogleGeminiStt } from '@/voice/input/googleGeminiStt';
import { resolveVoiceNetworkTimeoutMs } from '@/voice/runtime/fetchWithTimeout';
import {
  resolveGoogleAndroidCertSha1,
  resolveLocalSttProvider,
  resolveLocalVoiceAdapterSettings,
} from '@/voice/local/localVoiceSettings';

export { MissingSttBaseUrlError };

export class MissingGeminiApiKeyError extends Error {
  constructor() {
    super('missing_gemini_api_key');
    this.name = 'MissingGeminiApiKeyError';
  }
}

/** File extension → MIME type for recorder output; Gemini-specific normalization lives in googleGeminiStt. */
function guessMimeType(uri: string): string {
  const lower = uri.toLowerCase();
  if (lower.endsWith('.webm')) return 'audio/webm';
  if (lower.endsWith('.wav')) return 'audio/wav';
  if (lower.endsWith('.mp3')) return 'audio/mpeg';
  // expo-audio RecordingPresets.HIGH_QUALITY writes AAC in an .m4a container on iOS and Android.
  return 'audio/m4a';
}

export async function transcribeRecordedAudioWithProvider(params: {
  uri: string;
  settings: any;
  decryptSecretValue?: (value: unknown) => string | null;
}): Promise<string | null> {
  const decryptSecretValue = params.decryptSecretValue ?? ((value: unknown) => sync.decryptSecretValue(value as any));
  const adapter = resolveLocalVoiceAdapterSettings(params.settings).config;
  const provider = resolveLocalSttProvider(params.settings);

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
    const androidCertSha1 = resolveGoogleAndroidCertSha1(params.settings);
	    const uri = params.uri;
	
	    if (Platform.OS === 'web' && uri.startsWith('blob:')) {
	      const blob = await (await runtimeFetch(uri)).blob();
	      const text = await transcribeWithGoogleGeminiStt({
	        apiKey,
	        model,
	        audio: { kind: 'web', blob, mimeType: blob.type || 'audio/webm' },
	        language,
	        androidCertSha1,
	        timeoutMs,
	      });
      return text ? text.trim() || null : null;
    }

    const text = await transcribeWithGoogleGeminiStt({
      apiKey,
      model,
      audio: { kind: 'native', uri, mimeType: guessMimeType(uri) },
      language,
      androidCertSha1,
      timeoutMs,
    });
    return text ? text.trim() || null : null;
  }

  // Device STT is handled by the live recognizer controller, not file transcription.
  return null;
}
