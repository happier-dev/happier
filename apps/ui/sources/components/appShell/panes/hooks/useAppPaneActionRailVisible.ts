import { useAppPaneContext } from '../AppPaneProvider';
import type { PaneRightSidebarAdapter } from '../types';
import { useDeviceType } from '@/utils/platform/responsive';
import { useLocalSetting } from '@/sync/domains/state/storage';

/** Shares rail admission with headers outside the pane host's content context. */
export function useAppPaneActionRailVisible(
    scopeId: string,
    resolvedAdapter?: PaneRightSidebarAdapter | null,
): boolean {
    const registeredAdapter = useAppPaneContext(value => resolvedAdapter === undefined
        ? value.getDriver(scopeId)?.rightSidebarAdapter : undefined);
    const deviceType = useDeviceType();
    const multiPaneEnabled = useLocalSetting('uiMultiPanePanelsEnabled') !== false;
    // Hosts pass their resolved adapter, including null on an authority collision.
    const adapter = resolvedAdapter === undefined
        ? registeredAdapter
        : resolvedAdapter;
    return multiPaneEnabled && deviceType !== 'phone' && Boolean(adapter?.renderActionRail);
}
