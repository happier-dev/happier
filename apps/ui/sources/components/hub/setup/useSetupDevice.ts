import { Platform } from 'react-native';

import { isRunningOnMac } from '@/utils/platform/platform';
import { useDeviceType } from '@/utils/platform/responsive';
import { isWebMobileHost } from '@/utils/platform/webMobileHeuristics';

/**
 * Hardware decides which pairing actions are useful. The shared responsive owner separately
 * decides how setup fits: a narrow desktop browser needs rows without gaining a phone scanner.
 */
export function useSetupDevice(): Readonly<{ isComputer: boolean; isPhone: boolean; tileLayout: 'row' | 'card' }> {
    const deviceType = useDeviceType();
    const isComputer = isRunningOnMac() || (Platform.OS === 'web' && !isWebMobileHost());
    return {
        isComputer,
        isPhone: !isComputer,
        tileLayout: deviceType === 'phone' ? 'row' : 'card',
    };
}
