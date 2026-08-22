import { requestMicrophonePermission, showMicrophonePermissionDeniedAlert } from '@/utils/platform/microphonePermissions';

import { createNativeMicSession } from './NativeMicSession';
import type { CreateMicSessionOptions } from './MicSession';

export function createLiveMicSession(options: CreateMicSessionOptions = {}) {
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
