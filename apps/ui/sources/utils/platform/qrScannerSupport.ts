import * as Device from 'expo-device';
import { Platform } from 'react-native';

import { isRunningOnMac } from './platform';

function isWebCameraApiAvailable(): boolean {
    if (typeof navigator === 'undefined') return false;
    return Boolean((navigator as any)?.mediaDevices?.getUserMedia);
}

export function isWebQrScannerSupported(): boolean {
    return isWebCameraApiAvailable();
}

export function canUseCurrentDeviceQrScanner(): boolean {
    if (isRunningOnMac()) return false;
    if (Platform.OS !== 'web') return Device.isDevice;
    return isWebQrScannerSupported();
}
