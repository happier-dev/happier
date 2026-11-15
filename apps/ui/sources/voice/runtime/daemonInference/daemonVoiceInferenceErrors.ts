import {
    DaemonVoiceInferenceErrorCodeSchema,
    type DaemonVoiceInferenceErrorCode,
} from '@happier-dev/protocol/daemon/voiceInference';
import { isRpcMethodNotAvailableError } from '@happier-dev/protocol/rpcErrors';
import type { ActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';

const DAEMON_VOICE_INFERENCE_CLIENT_TRANSPORT_ERROR_CODES = [
    'feature_disabled',
    'upload_size_unavailable',
    'upload_failed',
    'download_failed',
    'stream_transport_unavailable',
    'peer_route_signing_identity_unavailable',
] as const;

type DaemonVoiceInferenceClientTransportErrorCode = typeof DAEMON_VOICE_INFERENCE_CLIENT_TRANSPORT_ERROR_CODES[number];

export type DaemonVoiceInferenceClientErrorCode =
    | DaemonVoiceInferenceErrorCode
    | DaemonVoiceInferenceClientTransportErrorCode;

export const DAEMON_VOICE_INFERENCE_CLIENT_ERROR_CODES: ReadonlySet<DaemonVoiceInferenceClientErrorCode> = new Set([
    ...DaemonVoiceInferenceErrorCodeSchema.options,
    ...DAEMON_VOICE_INFERENCE_CLIENT_TRANSPORT_ERROR_CODES,
]);

export function readDaemonVoiceInferenceClientErrorCode(error: unknown): DaemonVoiceInferenceClientErrorCode {
    if (isRpcMethodNotAvailableError(error)) return 'runtime_unavailable';
    const code = error && typeof error === 'object' && 'code' in error
        ? String((error as { code?: unknown }).code ?? '')
        : '';
    return DAEMON_VOICE_INFERENCE_CLIENT_ERROR_CODES.has(code as DaemonVoiceInferenceClientErrorCode)
        ? code as DaemonVoiceInferenceClientErrorCode
        : 'internal_error';
}

export function createDaemonVoiceInferenceClientError(
    code: DaemonVoiceInferenceClientErrorCode,
    message = `daemon_voice_inference_${code}`,
    failureCause?: ActionFailureCauseV1,
): Error & Readonly<{ code: DaemonVoiceInferenceClientErrorCode; failureCause?: ActionFailureCauseV1 }> {
    return Object.assign(new Error(message), { code, ...(failureCause ? { failureCause } : {}) });
}
