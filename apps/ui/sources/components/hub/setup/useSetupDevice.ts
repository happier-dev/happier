import { Platform, useWindowDimensions } from 'react-native';

import { isRunningOnMac } from '@/utils/platform/platform';
import { isWebMobileLikeQrScannerHost } from '@/utils/platform/webMobileHeuristics';

/**
 * Which device Get set up is on: a computer (the desktop app or a wide browser) or a phone (a native
 * app or a phone-sized browser). Set-up blocks choose their layout and the order of their steps
 * from this one answer.
 */
export function useSetupDevice(): Readonly<{ isComputer: boolean; isPhone: boolean }> {
    const { width, height } = useWindowDimensions();
    const isPhoneSizedWeb = Platform.OS === 'web' && isWebMobileLikeQrScannerHost({ width, height });
    return {
        isComputer: isRunningOnMac() || (Platform.OS === 'web' && !isPhoneSizedWeb),
        isPhone: !isRunningOnMac() && (Platform.OS !== 'web' || isPhoneSizedWeb),
    };
}
