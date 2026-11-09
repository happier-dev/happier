import { useDestinationVisibility } from '@/components/appShell/workspace/DestinationInstanceHost';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { useHostActivelyViewed } from '@/utils/runtime/useHostActivelyViewed';

/** Local surface presentation controls both document work and record demand. */
export function useSessionVisualPresentationActive(): boolean {
    const destinationVisible = useDestinationVisibility();
    const layoutPresented = useLayoutPresentationActive();
    const hostViewed = useHostActivelyViewed();
    return destinationVisible && layoutPresented && hostViewed;
}
