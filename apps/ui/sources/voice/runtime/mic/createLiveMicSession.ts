import { requestMicrophonePermission, showMicrophonePermissionDeniedAlert } from '@/utils/platform/microphonePermissions';

import { createNativeMicSession } from './NativeMicSession';
import type { CreateMicSessionOptions } from './MicSession';

export function createLiveMicSession(_options: CreateMicSessionOptions = {}) {
    return createNativeMicSession({
        ensureActive: async () => {
            const permission = await requestMicrophonePermission();
            if (!permission.granted) {
                showMicrophonePermissionDeniedAlert(permission.canAskAgain);
                throw new Error('mic_permission_denied');
            }
        },
    });
}
