import { Platform } from 'react-native';

export function isRunningOnMac(): boolean {
    if (Platform.OS !== 'ios') {
        return false;
    }
    
    const isMacCatalyst = (Platform as any)?.constants?.isMacCatalyst;
    if (typeof isMacCatalyst === 'boolean') {
        return isMacCatalyst;
    }

    return false;
}
