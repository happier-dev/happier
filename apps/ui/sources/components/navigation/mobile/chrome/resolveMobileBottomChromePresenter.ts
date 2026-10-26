import type { MobileBottomChromeModel } from './mobileBottomChromeTypes';
import type { WindowFoldMetrics } from '@/utils/platform/windowFoldMetrics';

export function resolveMobileBottomChromePresenter(input: Readonly<{
    platform: string;
    bridgeAvailable: boolean;
    verticalBarEdge: WindowFoldMetrics['verticalBarEdge'];
    enabled: boolean;
    model: MobileBottomChromeModel;
}>): 'system' | 'happier' {
    return input.platform === 'ios'
        && input.bridgeAvailable
        && input.verticalBarEdge !== null
        && input.enabled === true
        && input.model.kind !== 'hidden'
        ? 'system'
        : 'happier';
}
