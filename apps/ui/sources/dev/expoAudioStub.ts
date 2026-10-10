// Vitest/node stub for `expo-audio`.
//
// The real module depends on Expo native runtime bindings.

import { PermissionStatus, type PermissionResponse } from 'expo-modules-core';

const recordingPermission = (): PermissionResponse => ({
    status: PermissionStatus.UNDETERMINED,
    granted: false,
    canAskAgain: true,
    expires: 'never',
});

export const AudioModule = {
    getRecordingPermissionsAsync: async (): Promise<PermissionResponse> => recordingPermission(),
    requestRecordingPermissionsAsync: async (): Promise<PermissionResponse> => recordingPermission(),
};
