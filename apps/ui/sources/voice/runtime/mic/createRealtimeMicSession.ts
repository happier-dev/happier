import { mediaDevices, type MediaStream as NativeMediaStream } from '@livekit/react-native-webrtc';

import { requestMicrophonePermission, showMicrophonePermissionDeniedAlert } from '@/utils/platform/microphonePermissions';

import { createNativeMicSession } from './NativeMicSession';
import type { CreateMicSessionOptions } from './MicSession';

export function createRealtimeMicSession(_options: CreateMicSessionOptions = {}) {
    return createNativeMicSession({
        ensurePermission: async () => {
            const permission = await requestMicrophonePermission();
            if (!permission.granted) {
                showMicrophonePermissionDeniedAlert(permission.canAskAgain);
                throw new Error('mic_permission_denied');
            }
        },
        acquireStream: async () => (
            await mediaDevices.getUserMedia({ audio: true, video: false })
        ) as unknown as MediaStream,
        releaseStream: (stream) => {
            (stream as unknown as NativeMediaStream).release();
        },
    });
}
