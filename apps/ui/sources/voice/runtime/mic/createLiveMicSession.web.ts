import { requestMicrophonePermission, showMicrophonePermissionDeniedAlert } from '@/utils/platform/microphonePermissions';

import { createNativeMicSession } from './NativeMicSession';
import { createWebMicSession } from './WebMicSession.web';
import type { CreateMicSessionOptions } from './MicSession';

export function createLiveMicSession(options: CreateMicSessionOptions = {}) {
    const supportsWebMediaCapture =
        typeof navigator !== 'undefined'
        && typeof navigator.mediaDevices !== 'undefined'
        && typeof navigator.mediaDevices.getUserMedia === 'function';

    if (supportsWebMediaCapture) {
        return createWebMicSession(options);
    }

    return createNativeMicSession({
        ...(options.onFailure ? { onFailure: options.onFailure } : {}),
        ensureActive: async () => {
            const permission = await requestMicrophonePermission();
            if (!permission.granted) {
                showMicrophonePermissionDeniedAlert(permission.canAskAgain);
                throw new Error('mic_permission_denied');
            }
        },
    });
}
