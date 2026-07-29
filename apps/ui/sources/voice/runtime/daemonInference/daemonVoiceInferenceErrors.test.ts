import { describe, expect, it } from 'vitest';

import {
    DAEMON_VOICE_INFERENCE_CLIENT_ERROR_CODES,
    readDaemonVoiceInferenceClientErrorCode,
} from './daemonVoiceInferenceErrors';

describe('daemonVoiceInferenceErrors', () => {
    it('derives one known set from protocol and client-local transport codes', () => {
        expect(DAEMON_VOICE_INFERENCE_CLIENT_ERROR_CODES.has('request_timeout')).toBe(true);
        expect(DAEMON_VOICE_INFERENCE_CLIENT_ERROR_CODES.has('stream_not_found')).toBe(true);
        expect(DAEMON_VOICE_INFERENCE_CLIENT_ERROR_CODES.has('upload_failed')).toBe(true);
    });

    it('preserves known codes and fails unknown values closed', () => {
        expect(readDaemonVoiceInferenceClientErrorCode({ code: 'unsupported_runtime_family' })).toBe('unsupported_runtime_family');
        expect(readDaemonVoiceInferenceClientErrorCode({ code: 'download_failed' })).toBe('download_failed');
        expect(readDaemonVoiceInferenceClientErrorCode({ code: 'provider_private_failure' })).toBe('internal_error');
        expect(readDaemonVoiceInferenceClientErrorCode(new Error('boom'))).toBe('internal_error');
    });
});
