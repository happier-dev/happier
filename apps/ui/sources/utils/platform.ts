import { Platform } from 'react-native';
import { getDeviceType } from 'react-native-device-info';

const deviceType = getDeviceType();

export function isRunningOnMac(): boolean {
    if (Platform.OS !== 'ios') {
        return false;
    }
    
    const isMacCatalyst = (Platform as any)?.constants?.isMacCatalyst;
    if (typeof isMacCatalyst === 'boolean') {
        return isMacCatalyst;
    }

    // Fallback for environments where Platform.constants.isMacCatalyst is unavailable.
    return deviceType === 'Desktop';
}
