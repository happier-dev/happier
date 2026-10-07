import { Platform, useWindowDimensions } from 'react-native';

import { isRunningOnMac } from '@/utils/platform/platform';
import { useDeviceType } from '@/utils/platform/responsive';
import { isWebMobileLikeQrScannerHost } from '@/utils/platform/webMobileHeuristics';

/**
 * Hardware decides which pairing actions are useful. The shared responsive owner separately
 * decides how setup fits: a narrow desktop browser needs rows without gaining a phone scanner.
 */
export function useSetupDevice(): Readonly<{ isComputer: boolean; isPhone: boolean; tileLayout: 'row' | 'card' }> {
    const { width, height } = useWindowDimensions();
    const deviceType = useDeviceType();
    const isPhoneSizedWeb = Platform.OS === 'web' && isWebMobileLikeQrScannerHost({ width, height });
    return {
        isComputer: isRunningOnMac() || (Platform.OS === 'web' && !isPhoneSizedWeb),
        isPhone: !isRunningOnMac() && (Platform.OS !== 'web' || isPhoneSizedWeb),
        tileLayout: deviceType === 'phone' ? 'row' : 'card',
    };
}
