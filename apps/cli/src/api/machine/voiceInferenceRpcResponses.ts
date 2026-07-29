export type VoiceInferenceSchemaParser<T> = Readonly<{
  safeParse: (value: unknown) => { success: true; data: T } | { success: false };
  parse: (value: unknown) => T;
}>;

function toVoiceInferencePublicErrorMessage(errorCode: string): string {
  switch (errorCode) {
    case 'runtime_unavailable':
    case 'model_not_installed':
    case 'machine_unreachable':
    case 'request_timeout':
    case 'invalid_audio_input':
    case 'unsupported_codec':
    case 'unsupported_runtime_family':
    case 'cancelled':
    case 'stream_not_found':
    case 'invalid_stream_state':
      return `voice_inference_${errorCode}`;
    default:
      return 'voice_inference_internal_error';
  }
}

export function toVoiceInferenceErrorCode(error: unknown): DaemonVoiceInferenceErrorCode {
  const code = typeof (error as { code?: unknown } | null)?.code === 'string'
    ? (error as { code: string }).code
    : '';
  switch (code) {
    case 'runtime_unavailable':
    case 'model_not_installed':
    case 'machine_unreachable':
    case 'request_timeout':
    case 'invalid_audio_input':
    case 'unsupported_codec':
    case 'unsupported_runtime_family':
    case 'cancelled':
    case 'stream_not_found':
    case 'invalid_stream_state':
      return code;
    case 'runtime_timeout':
      return 'request_timeout';
    default:
      return 'internal_error';
  }
}

export function toVoiceInferenceError(error: unknown) {
  const errorCode = toVoiceInferenceErrorCode(error);
  return {
    ok: false as const,
    errorCode,
    error: toVoiceInferencePublicErrorMessage(errorCode),
  };
}

export function parseVoiceInferenceResponse<T>(schema: VoiceInferenceSchemaParser<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) {
    return parsed.data;
  }
  return schema.parse(toVoiceInferenceError(new Error('invalid_voice_inference_response')));
}
import type { DaemonVoiceInferenceErrorCode } from '@happier-dev/protocol';
