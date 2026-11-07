import * as React from 'react';
import { usePathname } from '@/components/appShell/workspace/destinationRoute';

import { PluginSurfacePlacementHost } from '@/components/plugins/surfaces';
import type { BoundPluginSurfaceBinding } from '@/components/plugins/surfaces/boundPluginSurfaceController';
import { usePluginSurfaceDestinationNavigationBinding } from '@/components/plugins/surfaces/pluginSurfaceDestinationNavigation';
import { useAppShellPeek } from '@/components/navigation/shell/appRail/AppShellPeek';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { PluginSurfaceCompanionContext } from '@/components/plugins/shared/pluginSurfaceInteractionAvailability';

import {
    useAppShellPluginUiProjection,
    useProjectedPluginLocalizedTextResolver,
} from './AppShellPluginUiProjection';
import {
    readPluginPageSubPathFromPathname,
    usePluginPages,
    selectPluginPagePlacements,
} from '@/components/plugins/pages/pluginPages';

/**
 * A plugin page's own shell column (design §3.2): the page's placement bound to its column renderer,
 * mounted beside the page only while that page is the open destination (the shell decides that). It
 * reads the page's current location so the plugin can mark its selected row, and reaches the page
 * through the ordinary `openSurface` navigation — it owns no route and no selection of its own. An
 * unavailable column renderer mounts nothing and the page stands full width.
 */
export const PluginAppPageColumn = React.memo(function PluginAppPageColumn(props: Readonly<{
    destinationId: string;
    /** Peeked over another page: its own page is not there to state an offline machine, so the column does. */
    peeked: boolean;
}>) {
    const projection = useAppShellPluginUiProjection();
    const localize = useProjectedPluginLocalizedTextResolver();
    const pathname = usePathname();
    const shell = useAppShellPeek();
    const presented = shell !== null && (shell.peek === null
        ? shell.columnShown
        : shell.peek.kind === props.destinationId);
    const focused = presented && (shell?.peek === null || shell?.peek.focus === true);
    const pages = usePluginPages({ target: { kind: 'app' },
        placements: selectPluginPagePlacements(projection.pluginUiProjection, { container: 'appPage', targetKind: 'app' }),
        localize,
    });
    const page = pages.find(candidate => candidate.id === props.destinationId) ?? null;
    const navigation = usePluginSurfaceDestinationNavigationBinding();
    const openSurface = navigation?.openSurface;
    const binding = React.useMemo<BoundPluginSurfaceBinding>(
        () => (openSurface ? { openSurface } : {}),
        [openSurface],
    );
    const subPath = page ? readPluginPageSubPathFromPathname(page, pathname) : null;
    if (!page?.columnPlacement || page.disabledReason !== null) return null;
    return (
        <PluginSurfaceFocusEligibilityProvider active={focused} presentationActive={presented} currentUiContextActive={false}>
            <PluginSurfaceCompanionContext.Provider value={!props.peeked}>
            <PluginSurfacePlacementHost
                placement={page.columnPlacement}
                pluginUiProjection={projection.pluginUiProjection}
                machineId={projection.machineId}
                serverId={projection.serverId}
                platform={projection.platform}
                binding={binding}
                subPath={subPath ?? ''}
            />
            </PluginSurfaceCompanionContext.Provider>
        </PluginSurfaceFocusEligibilityProvider>
    );
});
