import { requestMicrophonePermission, showMicrophonePermissionDeniedAlert } from '@/utils/platform/microphonePermissions';
import {
    getVoiceNativeWebRtcRuntime,
    type VoiceNativeWebRtcMediaStream,
} from '@/voice/runtime/nativeWebRtcRuntime';

import { createNativeMicSession } from './NativeMicSession';
import type { CreateMicSessionOptions } from './MicSession';

export function createRealtimeMicSession(options: CreateMicSessionOptions = {}) {
    return createNativeMicSession({
        ...(options.onFailure ? { onFailure: options.onFailure } : {}),
        ensurePermission: async () => {
            const permission = await requestMicrophonePermission();
            if (!permission.granted) {
                showMicrophonePermissionDeniedAlert(permission.canAskAgain);
                throw new Error('mic_permission_denied');
            }
        },
        acquireStream: async () => {
            const { mediaDevices } = getVoiceNativeWebRtcRuntime();
            return (await mediaDevices.getUserMedia({ audio: true, video: false })) as unknown as MediaStream;
        },
        releaseStream: (stream) => {
            (stream as unknown as VoiceNativeWebRtcMediaStream).release();
        },
    });
}
