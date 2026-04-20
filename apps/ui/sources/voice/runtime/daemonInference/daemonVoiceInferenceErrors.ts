export type DaemonVoiceInferenceClientErrorCode =
    | 'feature_disabled'
    | 'machine_unreachable'
    | 'upload_size_unavailable'
    | 'upload_failed'
    | 'download_failed'
    | 'runtime_unavailable'
    | 'model_not_installed'
    | 'request_timeout'
    | 'invalid_audio_input'
    | 'unsupported_codec'
    | 'cancelled'
    | 'internal_error';

export function createDaemonVoiceInferenceClientError(
    code: DaemonVoiceInferenceClientErrorCode,
    message = `daemon_voice_inference_${code}`,
): Error & Readonly<{ code: DaemonVoiceInferenceClientErrorCode }> {
    return Object.assign(new Error(message), { code });
}
