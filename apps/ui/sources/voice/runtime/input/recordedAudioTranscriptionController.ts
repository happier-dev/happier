import {
  VoiceProviderOperationErrorCodeSchema,
  DaemonVoiceInferenceErrorCodeSchema,
} from '@happier-dev/protocol';
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
import { readVoiceProviderSettingsConfig, voiceSettingsParse } from '@/sync/domains/settings/voiceSettings';

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
  'machine_unavailable',
  'invalid_response',
  'transfer_failed',
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
  webBlob?: Blob | null;
  executionMachineId?: string | null;
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
    webBlob: params.webBlob,
  });
  if (params.signal?.aborted) return null;

  const transcription = await new DaemonSttController().transcribeRecordedAudio({
    sessionId: params.sessionId ?? null,
    machineTarget: params.executionMachineId
      ? { machineId: params.executionMachineId }
      : null,
    source: preparedSource.source,
    inputMimeType: preparedSource.inputMimeType,
    packId,
    language,
    normalization: preparedSource.normalization,
    signal: params.signal,
  });
  return transcription.text.trim() || null;
}

type RecordedAudioSttProvider = RecordedAudioTranscriptionContext['stt']['provider'];

function createDefaultRecordedAudioTranscriptionControllers(): ReadonlyMap<string, RecordedAudioSttProviderController> {
  return new Map<string, RecordedAudioSttProviderController>([
    ['device', { transcribe: async () => null }],
    ['local_neural', { transcribe: transcribeWithLocalNeuralRecordedAudio }],
  ]);
}

async function transcribeWithRegisteredSpeechProvider(input: Readonly<{
  params: RecordedAudioTranscriptionContext;
  providerId: string;
  registry: ReturnType<typeof createDefaultVoiceProviderRegistry>;
  runtime: ReturnType<typeof createBundledSpeechRuntime>;
}>): Promise<string | null> {
  const descriptor = readBundledSpeechSettingsDescriptorFromEntry(
    input.providerId,
    input.registry.get(input.providerId),
  );
  if (!descriptor) {
    throw Object.assign(new Error('voice_stt_provider_unavailable'), { code: 'provider_unavailable' });
  }
  const providerConfig = readVoiceProviderSettingsConfig(
    voiceSettingsParse(input.params.settings?.voice),
    input.providerId,
  );
  try {
    return await input.runtime.transcribeRecordedAudio(input.providerId, {
      uri: input.params.uri,
      providerConfig,
      fallbackLanguage: resolveRecordedAudioLanguage({ explicitLanguage: null, settings: input.params.settings }),
      signal: input.params.signal,
    });
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === 'credential_unavailable') {
      throw new MissingBundledSpeechCredentialError(input.providerId);
    }
    throw error;
  }
}

export function createRecordedAudioTranscriptionController(options?: Readonly<{
  controllers?: Partial<Record<RecordedAudioSttProvider, RecordedAudioSttProviderController>>;
}>): RecordedAudioTranscriptionController {
  const controllers = new Map(createDefaultRecordedAudioTranscriptionControllers());
  const registry = createDefaultVoiceProviderRegistry();
  const speechRuntime = createBundledSpeechRuntime({ registry });
  for (const [providerId, controller] of Object.entries(options?.controllers ?? {})) {
    if (controller) controllers.set(providerId, controller);
  }

  return {
    transcribe: async (params) => {
      const { config: adapter } = resolveLocalVoiceAdapterSettings(params.settings);
      const stt = parseLocalVoiceSttSettings(adapter?.stt);
      const provider = stt.provider;
      const controller = controllers.get(provider);
      const context = {
        ...params,
        adapter,
        stt,
      };
      if (controller) return await controller.transcribe(context);
      return await transcribeWithRegisteredSpeechProvider({
        params: context,
        providerId: provider,
        registry,
        runtime: speechRuntime,
      });
    },
  };
}

export const recordedAudioTranscriptionController = createRecordedAudioTranscriptionController();
