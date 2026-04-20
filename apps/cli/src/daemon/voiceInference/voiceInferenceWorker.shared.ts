import type {
  DaemonVoiceInferenceAudioOutput,
  DaemonVoiceInferenceModelStatus,
  ModelPackManifest,
} from '@happier-dev/protocol';

import type { VoiceInferenceRuntime } from './voiceInferenceRuntimeTypes';

export type RuntimeLoader = () => Promise<VoiceInferenceRuntime | null>;

export type VoiceInferenceModelIdentity = Readonly<{
  kind: DaemonVoiceInferenceModelStatus['kind'];
  model: string;
}>;

export type WarmRuntimeHandle = Readonly<{
  runtime: VoiceInferenceRuntime;
  packDir: string;
  manifest: ModelPackManifest;
}>;

export function normalizePackId(packId: string | null | undefined): string | null {
  if (typeof packId !== 'string') {
    return null;
  }
  const normalized = packId.trim();
  return normalized.length > 0 ? normalized : null;
}

const VOICE_INFERENCE_PACK_ID_FILESYSTEM_SAFE_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const VOICE_INFERENCE_PACK_ID_MAX_LENGTH = 256;

export function assertVoiceInferencePackIdFilesystemSafe(packId: string): string {
  const normalized = packId.trim();
  if (
    normalized.length === 0
    || normalized.length > VOICE_INFERENCE_PACK_ID_MAX_LENGTH
    || normalized === '.'
    || normalized === '..'
    || !VOICE_INFERENCE_PACK_ID_FILESYSTEM_SAFE_RE.test(normalized)
  ) {
    throw createVoiceInferenceError('internal_error', 'voice_inference_invalid_pack_id');
  }
  return normalized;
}

export function createVoiceInferenceError(code: string, message = `voice_inference_${code}`): Error {
  return Object.assign(new Error(message), { code });
}

export function readVoiceInferenceErrorCode(error: unknown): string {
  return typeof (error as { code?: unknown } | null)?.code === 'string'
    ? (error as { code: string }).code
    : '';
}

export function createRuntimeUnavailableError(error: unknown): Error {
  if (readVoiceInferenceErrorCode(error) === 'runtime_unavailable' && error instanceof Error) {
    return error;
  }
  return createVoiceInferenceError('runtime_unavailable', 'voice_inference_runtime_unavailable');
}

export function normalizeVoiceInferenceInputMimeType(inputMimeType: string): string {
  return String(inputMimeType ?? '').trim().toLowerCase().split(';', 1)[0]?.trim() ?? '';
}

export function isVoiceInferenceWavMimeType(inputMimeType: string): boolean {
  const normalized = normalizeVoiceInferenceInputMimeType(inputMimeType);
  return normalized === 'audio/wav' || normalized === 'audio/wave' || normalized === 'audio/x-wav';
}

export function isVoiceInferenceModelKind(value: string | null | undefined): value is DaemonVoiceInferenceModelStatus['kind'] {
  return value === 'tts_sherpa' || value === 'stt_sherpa';
}

export function resolveVoiceInferenceOutputExtension(output: DaemonVoiceInferenceAudioOutput): string {
  switch (output.codec) {
    case 'wav':
      return 'wav';
    case 'opus':
      return 'opus';
    default:
      return 'mp3';
  }
}

export function shouldPreserveHealthyDiagnostics(error: unknown): boolean {
  const errorCode = readVoiceInferenceErrorCode(error);
  return (
    errorCode === 'cancelled'
    || errorCode === 'invalid_audio_input'
    || errorCode === 'model_not_installed'
    || errorCode === 'unsupported_codec'
  );
}
