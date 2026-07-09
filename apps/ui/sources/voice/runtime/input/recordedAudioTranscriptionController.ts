import { Platform } from 'react-native';

import { sync } from '@/sync/sync';
import { runtimeFetch } from '@/utils/system/runtimeFetch';
import { guessAudioMimeType } from '@/voice/input/guessAudioMimeType';
import { MissingSttBaseUrlError, transcribeRecordedAudioWithHttpStt } from '@/voice/input/HttpSttController';
import { transcribeWithGoogleGeminiStt } from '@/voice/input/googleGeminiStt';
import { prepareDaemonVoiceInferenceSttSource } from '@/voice/input/prepareDaemonVoiceInferenceSttSource';
import {
  parseLocalVoiceSttSettings,
  resolveLocalVoiceAdapterSettings,
} from '@/voice/local/localVoiceSettings';
import { DaemonSttController } from '@/voice/runtime/daemonInference/DaemonSttController';
import { resolveDaemonVoiceInferenceExecution } from '@/voice/runtime/daemonInference/daemonVoiceInferencePolicy';
import { resolveVoiceNetworkTimeoutMs } from '@/voice/runtime/fetchWithTimeout';

export { MissingSttBaseUrlError };

export class MissingGeminiApiKeyError extends Error {
  constructor() {
    super('missing_gemini_api_key');
    this.name = 'MissingGeminiApiKeyError';
  }
}

export type RecordedAudioTranscriptionRequest = Readonly<{
  sessionId?: string | null;
  uri: string;
  settings: any;
  decryptSecretValue?: (value: unknown) => string | null;
}>;

export type RecordedAudioTranscriptionController = Readonly<{
  transcribe: (params: RecordedAudioTranscriptionRequest) => Promise<string | null>;
}>;

type RecordedAudioTranscriptionContext = RecordedAudioTranscriptionRequest & Readonly<{
  adapter: any;
  stt: ReturnType<typeof parseLocalVoiceSttSettings>;
  decryptSecretValue: (value: unknown) => string | null;
}>;

type RecordedAudioSttProviderController = Readonly<{
  transcribe: (params: RecordedAudioTranscriptionContext) => Promise<string | null>;
}>;

function resolveRecordedAudioLanguage(params: Readonly<{
  explicitLanguage: unknown;
  settings: any;
}>): string | null {
  return typeof params.explicitLanguage === 'string' && params.explicitLanguage.trim()
    ? params.explicitLanguage.trim()
    : typeof params.settings?.voice?.assistantLanguage === 'string' && params.settings.voice.assistantLanguage.trim()
      ? params.settings.voice.assistantLanguage.trim()
      : null;
}

async function transcribeWithLocalNeuralRecordedAudio(params: RecordedAudioTranscriptionContext): Promise<string | null> {
  const localNeural = params.stt.localNeural;
  const execution = await resolveDaemonVoiceInferenceExecution({
    requestedExecution: localNeural?.execution ?? 'auto',
    sessionId: params.sessionId ?? null,
    surface: 'stt',
  });
  if (execution !== 'daemon') {
    return null;
  }

  const packId = typeof localNeural?.assetId === 'string' && localNeural.assetId.trim() ? localNeural.assetId.trim() : null;
  const language = resolveRecordedAudioLanguage({
    explicitLanguage: localNeural?.language,
    settings: params.settings,
  });
  const preparedSource = await prepareDaemonVoiceInferenceSttSource({
    uri: params.uri,
  });

  const transcription = await new DaemonSttController().transcribeRecordedAudio({
    sessionId: params.sessionId ?? null,
    source: preparedSource.source,
    inputMimeType: preparedSource.inputMimeType,
    packId,
    language,
    normalization: preparedSource.normalization,
  });
  return transcription.text.trim() || null;
}

async function transcribeWithOpenAiCompatRecordedAudio(params: RecordedAudioTranscriptionContext): Promise<string | null> {
  return await transcribeRecordedAudioWithHttpStt({
    uri: params.uri,
    settings: params.settings,
    decryptSecretValue: params.decryptSecretValue,
  });
}

async function transcribeWithGoogleGeminiRecordedAudio(params: RecordedAudioTranscriptionContext): Promise<string | null> {
  const googleGemini = params.stt.googleGemini;
  const apiKey = googleGemini?.apiKey ? (params.decryptSecretValue(googleGemini.apiKey) ?? null) : null;
  if (!apiKey) {
    throw new MissingGeminiApiKeyError();
  }

  const model = typeof googleGemini?.model === 'string' && googleGemini.model.trim() ? googleGemini.model.trim() : 'gemini-2.5-flash';
  const language = resolveRecordedAudioLanguage({
    explicitLanguage: googleGemini?.language,
    settings: params.settings,
  });
  const timeoutMs = resolveVoiceNetworkTimeoutMs(params.adapter?.networkTimeoutMs, 15_000);

  if (Platform.OS === 'web' && params.uri.startsWith('blob:')) {
    const blob = await (await runtimeFetch(params.uri)).blob();
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
    audio: { kind: 'native', uri: params.uri, mimeType: guessAudioMimeType(params.uri) },
    language,
    timeoutMs,
  });
  return text ? text.trim() || null : null;
}

type RecordedAudioSttProvider = RecordedAudioTranscriptionContext['stt']['provider'];

function createDefaultRecordedAudioTranscriptionControllers(): Record<RecordedAudioSttProvider, RecordedAudioSttProviderController> {
  return {
    device: { transcribe: async () => null },
    google_gemini: { transcribe: transcribeWithGoogleGeminiRecordedAudio },
    local_neural: { transcribe: transcribeWithLocalNeuralRecordedAudio },
    openai_compat: { transcribe: transcribeWithOpenAiCompatRecordedAudio },
  };
}

export function createRecordedAudioTranscriptionController(options?: Readonly<{
  controllers?: Partial<Record<RecordedAudioSttProvider, RecordedAudioSttProviderController>>;
}>): RecordedAudioTranscriptionController {
  const defaultControllers = createDefaultRecordedAudioTranscriptionControllers();
  const controllers: Record<RecordedAudioSttProvider, RecordedAudioSttProviderController> = {
    device: options?.controllers?.device ?? defaultControllers.device,
    google_gemini: options?.controllers?.google_gemini ?? defaultControllers.google_gemini,
    local_neural: options?.controllers?.local_neural ?? defaultControllers.local_neural,
    openai_compat: options?.controllers?.openai_compat ?? defaultControllers.openai_compat,
  };

  return {
    transcribe: async (params) => {
      const decryptSecretValue = params.decryptSecretValue ?? ((value: unknown) => sync.decryptSecretValue(value as any));
      const { config: adapter } = resolveLocalVoiceAdapterSettings(params.settings);
      const stt = parseLocalVoiceSttSettings(adapter?.stt);
      const provider = stt.provider;
      return await controllers[provider].transcribe({
        ...params,
        adapter,
        stt,
        decryptSecretValue,
      });
    },
  };
}

export const recordedAudioTranscriptionController = createRecordedAudioTranscriptionController();
