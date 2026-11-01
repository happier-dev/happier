import type { WindowFoldMetrics } from '@/utils/platform/windowFoldMetrics';
import type { useDeviceType } from '@/utils/platform/responsive';

export function resolveMobileBottomChromePresenter(input: Readonly<{
    platform: string;
    bridgeAvailable: boolean;
    verticalBarEdge: WindowFoldMetrics['verticalBarEdge'];
    enabled: boolean;
    deviceType: ReturnType<typeof useDeviceType>;
}>): 'system' | 'happier' {
    return input.platform === 'ios'
        && input.bridgeAvailable
        && input.verticalBarEdge !== null
        && input.enabled === true
        && input.deviceType === 'phone'
        ? 'system'
        : 'happier';
}
