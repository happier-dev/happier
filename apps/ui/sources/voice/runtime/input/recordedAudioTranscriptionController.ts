import {
  VoiceProviderOperationErrorCodeSchema,
  DaemonVoiceInferenceErrorCodeSchema,
  DaemonVoiceOpenAiCompatErrorCodeSchema,
} from '@happier-dev/protocol';
import { MissingSttBaseUrlError, transcribeRecordedAudioWithHttpStt } from '@/voice/input/HttpSttController';
import { prepareDaemonVoiceInferenceSttSource } from '@/voice/input/prepareDaemonVoiceInferenceSttSource';
import {
  parseLocalVoiceSttSettings,
  resolveLocalVoiceAdapterSettings,
} from '@/voice/local/localVoiceSettings';
import { DaemonSttController } from '@/voice/runtime/daemonInference/DaemonSttController';
import { resolveDaemonVoiceInferenceExecution } from '@/voice/runtime/daemonInference/daemonVoiceInferencePolicy';
import { createBundledSpeechRuntime } from '@/voice/runtime/bundledSpeech/bundledSpeechRuntime';
import { createDefaultVoiceProviderRegistry } from '@/voice/registry/defaultRegistry';
import { readBundledSpeechSettingsDescriptorFromEntry } from '@/voice/settings/panels/bundledSpeech/descriptor';
import { readLocalSpeechProviderEnvelope } from '@/sync/domains/settings/voiceLocalSpeechProviderSettings';

export { MissingSttBaseUrlError };

export class MissingBundledSpeechCredentialError extends Error {
  readonly providerId: string;

  constructor(providerId: string) {
    super('missing_bundled_speech_credential');
    this.name = 'MissingBundledSpeechCredentialError';
    this.providerId = providerId;
  }
}

const RECORDED_AUDIO_STT_FAILURE_CODES: ReadonlySet<string> = new Set([
  ...VoiceProviderOperationErrorCodeSchema.options,
  ...DaemonVoiceInferenceErrorCodeSchema.options,
  ...DaemonVoiceOpenAiCompatErrorCodeSchema.options,
  'machine_unavailable',
  'invalid_response',
  'transfer_failed',
  'legacy_credential_unavailable',
]);

/**
 * Preserve only bounded, protocol/client-owned STT failure codes at the
 * provider-neutral recorded-audio boundary. Arbitrary provider messages stay
 * hidden behind `stt_failed`, while actionable machine/transfer/timeout causes
 * remain observable to the runtime, UI recovery projection, and QA.
 */
export function resolveRecordedAudioTranscriptionFailureReason(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code ?? '')
    : '';
  return RECORDED_AUDIO_STT_FAILURE_CODES.has(code) ? `stt_${code}` : 'stt_failed';
}

export type RecordedAudioTranscriptionRequest = Readonly<{
  sessionId?: string | null;
  uri: string;
  settings: any;
  signal?: AbortSignal | null;
}>;

export type RecordedAudioTranscriptionController = Readonly<{
  transcribe: (params: RecordedAudioTranscriptionRequest) => Promise<string | null>;
}>;

type RecordedAudioTranscriptionContext = RecordedAudioTranscriptionRequest & Readonly<{
  adapter: any;
  stt: ReturnType<typeof parseLocalVoiceSttSettings>;
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
  if (params.signal?.aborted) return null;

  const transcription = await new DaemonSttController().transcribeRecordedAudio({
    sessionId: params.sessionId ?? null,
    source: preparedSource.source,
    inputMimeType: preparedSource.inputMimeType,
    packId,
    language,
    normalization: preparedSource.normalization,
    signal: params.signal,
  });
  return transcription.text.trim() || null;
}

async function transcribeWithOpenAiCompatRecordedAudio(params: RecordedAudioTranscriptionContext): Promise<string | null> {
  return await transcribeRecordedAudioWithHttpStt({
    uri: params.uri,
    settings: params.settings,
    signal: params.signal ?? undefined,
  });
}

type RecordedAudioSttProvider = RecordedAudioTranscriptionContext['stt']['provider'];

function createDefaultRecordedAudioTranscriptionControllers(): ReadonlyMap<string, RecordedAudioSttProviderController> {
  const registry = createDefaultVoiceProviderRegistry();
  const bundledRuntime = createBundledSpeechRuntime({ registry });
  const entries: Array<readonly [string, RecordedAudioSttProviderController]> = [
    ['device', { transcribe: async () => null }],
    ['local_neural', { transcribe: transcribeWithLocalNeuralRecordedAudio }],
    ['openai_compat', { transcribe: transcribeWithOpenAiCompatRecordedAudio }],
  ];
  for (const providerId of bundledRuntime.sttProviderIds()) {
    const descriptor = readBundledSpeechSettingsDescriptorFromEntry(
      providerId,
      registry.get(providerId),
    );
    if (!descriptor) continue;
    entries.push([providerId, {
      transcribe: async (params) => {
        const envelope = readLocalSpeechProviderEnvelope(params.stt, providerId);
        const providerConfig = envelope === null
          ? descriptor.defaultConfig
          : envelope.schemaVersion === descriptor.schemaVersion
            ? envelope.config
            : null;
        try {
          return await bundledRuntime.transcribeRecordedAudio(providerId, {
            uri: params.uri,
            providerConfig,
            fallbackLanguage: resolveRecordedAudioLanguage({ explicitLanguage: null, settings: params.settings }),
            signal: params.signal,
          });
        } catch (error) {
          if ((error as { code?: unknown } | null)?.code === 'credential_unavailable') {
            throw new MissingBundledSpeechCredentialError(providerId);
          }
          throw error;
        }
      },
    }]);
  }
  return new Map(entries);
}

export function createRecordedAudioTranscriptionController(options?: Readonly<{
  controllers?: Partial<Record<RecordedAudioSttProvider, RecordedAudioSttProviderController>>;
}>): RecordedAudioTranscriptionController {
  const controllers = new Map(createDefaultRecordedAudioTranscriptionControllers());
  for (const [providerId, controller] of Object.entries(options?.controllers ?? {})) {
    if (controller) controllers.set(providerId, controller);
  }

  return {
    transcribe: async (params) => {
      const { config: adapter } = resolveLocalVoiceAdapterSettings(params.settings);
      const stt = parseLocalVoiceSttSettings(adapter?.stt);
      const provider = stt.provider;
      const controller = controllers.get(provider);
      if (!controller) throw Object.assign(new Error('voice_stt_provider_unavailable'), { code: 'provider_unavailable' });
      return await controller.transcribe({
        ...params,
        adapter,
        stt,
      });
    },
  };
}

export const recordedAudioTranscriptionController = createRecordedAudioTranscriptionController();
