import * as React from 'react';

import type { LocalServiceLaunchTargetV1 } from '@happier-dev/protocol';

import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import {
    bindServicesOpenInBrowser,
    type OpenBrowserTargetScope,
    type ServicesOpenInBrowserResult,
} from '@/components/browser/surfaces/openBrowserTargetInWorkspace';
import { resolveBrowserSurfacePlatform } from '@/components/browser/surfaces/useBrowserSurfaceHostProps';
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
    /** After the pane owner commits an in-app tab, never an external-browser handoff. */
    onAfterDetailsOpen?: () => void;
}>;

/**
 * Single owner of the Services → Browser open binding. Resolves the canonical opener dependencies
 * (the pane's `openDetailsTab`, the browser platform, and the live local-service preview state for
 * access-URL/expiry seeding) once, then returns the `onOpenServiceInBrowser` callback the Services
 * surface host expects. The existing {@link bindServicesOpenInBrowser} owns mapping and admission
 * through the canonical workspace opener. Its typed outcome reaches the Services action runner;
 * an unmappable target is refused and does not invoke `onAfterOpen`.
 *
 * Centralizing this here keeps the four Services mount sites (session/project right panels +
 * session/project mobile cockpits) from each re-deriving the same opener wiring.
 */
export function useServicesOpenInBrowser(
    input: UseServicesOpenInBrowserInput,
): (target: LocalServiceLaunchTargetV1) => Promise<ServicesOpenInBrowserResult> {
    const pane = useAppPaneScope(input.scopeId);
    const openDetailsTab = pane.openDetailsTab;
    const platform = resolveBrowserSurfacePlatform();
    const localServicePreviewState = useLocalServicePreviewState({
        machineId: input.machineId,
        serverId: input.serverId,
    });
    const onAfterOpen = input.onAfterOpen;
    const onAfterDetailsOpen = input.onAfterDetailsOpen;

    return React.useCallback(async (target: LocalServiceLaunchTargetV1): Promise<ServicesOpenInBrowserResult> => {
        const openService = bindServicesOpenInBrowser({
            openDetailsTab: (tab, options) => {
                openDetailsTab(tab, options);
                onAfterDetailsOpen?.();
            },
            scope: input.scope,
            platform,
            localServicePreviewState,
            serverId: input.serverId,
            sessionId: input.sessionId,
        });
        const result = await openService(target);
        if (result.status === 'succeeded') onAfterOpen?.();
        return result;
    }, [input.scope, input.serverId, input.sessionId, localServicePreviewState, onAfterOpen, onAfterDetailsOpen, openDetailsTab, platform]);
}
