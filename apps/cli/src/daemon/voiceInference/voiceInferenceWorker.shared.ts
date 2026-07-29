import {
  assertPackIdFilesystemSafe,
  type DaemonVoiceInferenceModelStatus,
  type ModelPackManifest,
  type VoiceModelPackRuntimeV1,
  type VoiceModelPackSupportArtifactV1,
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
  runtimeDescriptor?: VoiceModelPackRuntimeV1 | null;
  supportArtifacts?: readonly VoiceModelPackSupportArtifactV1[];
}>;

export function normalizePackId(packId: string | null | undefined): string | null {
  if (typeof packId !== 'string') {
    return null;
  }
  const normalized = packId.trim();
  return normalized.length > 0 ? normalized : null;
}

export function assertVoiceInferencePackIdFilesystemSafe(packId: string): string {
  return assertPackIdFilesystemSafe(packId, () =>
    createVoiceInferenceError('internal_error', 'voice_inference_invalid_pack_id'),
  );
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

export function shouldPreserveHealthyDiagnostics(error: unknown): boolean {
  const errorCode = readVoiceInferenceErrorCode(error);
  return (
    errorCode === 'cancelled'
    || errorCode === 'invalid_audio_input'
    || errorCode === 'model_not_installed'
    || errorCode === 'unsupported_codec'
  );
}
