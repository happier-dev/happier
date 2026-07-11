import * as React from 'react';

import type { LocalServiceLaunchTargetV1 } from '@happier-dev/protocol';

import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import {
    createOpenBrowserTargetInWorkspace,
    mapLocalServiceLaunchTargetToBrowserTarget,
    resolveBrowserSurfacePlatform,
    type OpenBrowserTargetScope,
} from '@/components/browser/surfaces';
import { useLocalServicePreviewState } from '@/sync/domains/local/services/preview/useLocalServicePreviewState';

export type UseServicesOpenInBrowserInput = Readonly<{
    /**
     * The pane scope whose details workspace a browser-view tab is opened into. Desktop surfaces use
     * the surface's own pane scope; the mobile cockpits pass the browser sub-scope (`${scopeId}:browser`)
     * so the tab lands in the dedicated mobile browser workspace.
     */
    scopeId: string;
    scope: OpenBrowserTargetScope;
    machineId?: string | null;
    serverId?: string | null;
    sessionId?: string | null;
    /**
     * Side effect to run AFTER a service target is successfully opened (i.e. it mapped to a browser
     * target and a tab was created). The mobile cockpits use it to switch the active full-screen
     * surface to the browser; desktop surfaces have a side-by-side details pane and omit it. It is
     * never invoked for an unmappable target so the surface does not navigate to nothing.
     */
    onAfterOpen?: () => void;
}>;

/**
 * Single owner of the Services → Browser open binding. Resolves the canonical opener dependencies
 * (the pane's `openDetailsTab`, the browser platform, and the live local-service preview state for
 * access-URL/expiry seeding) once, then returns the `onOpenServiceInBrowser` callback the Services
 * surface host expects: it maps the {@link LocalServiceLaunchTargetV1} to a browser target via the
 * canonical {@link mapLocalServiceLaunchTargetToBrowserTarget} and opens BOTH a browser-view details
 * tab and its live content record through {@link createOpenBrowserTargetInWorkspace}. No-ops (and
 * skips `onAfterOpen`) when the target cannot be mapped.
 *
 * Centralizing this here keeps the four Services mount sites (session/project right panels +
 * session/project mobile cockpits) from each re-deriving the same opener wiring.
 */
export function useServicesOpenInBrowser(
    input: UseServicesOpenInBrowserInput,
): (target: LocalServiceLaunchTargetV1) => void {
    const pane = useAppPaneScope(input.scopeId);
    const openDetailsTab = pane.openDetailsTab;
    const platform = resolveBrowserSurfacePlatform();
    const localServicePreviewState = useLocalServicePreviewState({
        machineId: input.machineId,
        serverId: input.serverId,
    });
    const onAfterOpen = input.onAfterOpen;

    return React.useCallback((target: LocalServiceLaunchTargetV1): void => {
        const browserTarget = mapLocalServiceLaunchTargetToBrowserTarget(target);
        if (!browserTarget) {
            return;
        }
        const openBrowserViewTarget = createOpenBrowserTargetInWorkspace({
            openDetailsTab,
            scope: input.scope,
            platform,
            localServicePreviewState,
        });
        openBrowserViewTarget(browserTarget);
        onAfterOpen?.();
    }, [input.scope, localServicePreviewState, onAfterOpen, openDetailsTab, platform]);
}
