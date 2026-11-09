import * as React from 'react';

import type { LocalServiceLaunchTargetV1 } from '@happier-dev/protocol/local/services/launcher/v1';
import { BrowserWorkspaceOpenResultV1Schema } from '@happier-dev/protocol/browser/control/v1';

import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import {
    bindServicesOpenInBrowser,
    type OpenBrowserTargetScope,
    type ServicesOpenInBrowserResult,
} from '@/components/browser/surfaces/openBrowserTargetInWorkspace';
import { resolveBrowserSurfacePlatform } from '@/components/browser/surfaces/useBrowserSurfaceHostProps';
import { useOpenBrowserTargetInWorkspace } from '@/components/browser/surfaces/useOpenBrowserTargetInWorkspace';
import { useSessionViewerSourceAccountLifetime } from '@/components/sessions/viewer/SessionViewerSourceAccountScope';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
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
    /** Project/standalone surfaces pass their admitted lifetime; Session shells supply it in context. */
    accountLifetime?: ServerAccountScopeLifetime | null;
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
 * (the admitted Account lifetime, pane, platform, and live preview state) once, then returns the
 * `onOpenServiceInBrowser` callback the Services surface host expects. The existing
 * {@link bindServicesOpenInBrowser} owns mapping and admission
 * through the canonical workspace opener. Its typed outcome reaches the Services action runner;
 * an unmappable target is refused and does not invoke `onAfterOpen`.
 *
 * Centralizing this here keeps the Session/Project panels, mobile cockpits, and Companion glance
 * from each re-deriving the same opener wiring.
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
    const postOpen = React.useRef({ onAfterOpen, onAfterDetailsOpen });
    postOpen.current = { onAfterOpen, onAfterDetailsOpen };
    const viewerAccountLifetime = useSessionViewerSourceAccountLifetime();
    const accountLifetime = input.accountLifetime === undefined ? viewerAccountLifetime : input.accountLifetime;
    const mountedAction = useMountedActionExecution(accountLifetime?.scope);
    const actionExecution = React.useRef(mountedAction);
    actionExecution.current = mountedAction;
    // The opener's presentation lifetime stays stable while credential readiness changes.
    const actionExecute = React.useCallback<NonNullable<Parameters<typeof useOpenBrowserTargetInWorkspace>[0]['actionExecute']>>(
        (actionId, actionInput, context) => actionExecution.current.execute(actionId, actionInput, context), []);
    const onOpenTarget = useOpenBrowserTargetInWorkspace({
        scopeId: input.scopeId,
        accountLifetime,
        actionExecute,
        openDetailsTab,
        scope: input.scope,
        platform,
        localServicePreviewState,
        localServiceAddressScope: input.machineId ? { machineId: input.machineId,
            ...(input.sessionId ? { sessionId: input.sessionId } : {}) } : undefined,
    });
    const currentOpener = React.useRef(onOpenTarget);
    currentOpener.current = onOpenTarget;

    const openAndFollowCommit = React.useCallback(async (...args: Parameters<typeof onOpenTarget>) => {
        const result = await onOpenTarget(...args);
        if (result?.ok && currentOpener.current === onOpenTarget
            && actionExecution.current.isCurrent() && accountLifetime?.isCurrent()) {
            const opened = BrowserWorkspaceOpenResultV1Schema.safeParse(result.result);
            if (opened.success && opened.data.status === 'dispatched' && opened.data.outcome === 'workspaceTab') {
                postOpen.current.onAfterDetailsOpen?.();
                postOpen.current.onAfterOpen?.();
            }
        }
        return result;
    }, [accountLifetime, onOpenTarget]);

    return React.useMemo(() => bindServicesOpenInBrowser({
        onOpenTarget: openAndFollowCommit,
        platform,
        serverId: input.serverId,
        sessionId: input.sessionId,
        accountLifetime,
        credentialKey: mountedAction.binding?.credentialKey,
    }), [accountLifetime, input.serverId, input.sessionId, mountedAction.binding?.credentialKey, openAndFollowCommit, platform]);
}
