import * as React from 'react';
import type { PluginUiNewSessionSeedV1 } from '@happier-dev/protocol/plugins/ui';

import { useLocalSearchParams, usePathname } from '@/components/appShell/workspace/destinationRoute';
import { useDestinationPaneScopeId } from '@/components/appShell/workspace/DestinationInstanceHost';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { AppPaneContext } from '@/components/appShell/panes/AppPaneContext';
import { buildDetailsWorkspaceStateView } from '@/components/appShell/panes/details/workspace/detailsWorkspaceSelectors';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { useActiveServerAccountScope, useWorkspaceRefs } from '@/sync/domains/state/storage';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import { resolveProjectCheckoutWorkspaceRef } from '@/sync/domains/workspaces/workspaceRefs';
import { workspaceAddressFromRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import { buildProjectNewSessionOrigin, readProjectSelectedRouteResource, type ProjectPageV1 } from './detail/projectRouteState';
import { buildProjectPaneScopeId } from './detail/projectPaneScope';
import { resolveProjectCockpitRouteFromPathname } from '@/components/workspaceCockpit/project/projectCockpitState';
import { openSessionAuthoringAction } from '@/sync/ops/actions/sessionAuthoringActions';

/** Both ordinary Project launchers use the admitted draft owner, never a private seed route. */
export function useProjectNewSessionAction(input: Readonly<{
    workspaceRef: WorkspaceRefV1;
    activeRootPath: string;
    page?: ProjectPageV1;
    scopeId?: string;
}>) {
    const accountScope = useActiveServerAccountScope();
    const workspaceRefs = useWorkspaceRefs();
    const routeParams = useLocalSearchParams<Record<string, string | string[]>>();
    const pathname = usePathname();
    const scopeId = useDestinationPaneScopeId(buildProjectPaneScopeId(input.workspaceRef.id, input.workspaceRef.serverId));
    const paneContext = React.useContext(AppPaneContext);
    const pane = useAppPaneScope(input.scopeId ?? scopeId, scope => {
        const details = scope ? buildDetailsWorkspaceStateView(scope.details) : null;
        const selected = details?.tabs.find(tab => tab.key === details.activeTabKey);
        return { detailsOpen: details?.isOpen, detailsPresent: Boolean(details?.tabs.length),
            activeDetailsKey: details?.activeTabKey, activeDetailsKind: selected?.kind, activeDetailsResource: selected?.resource,
            rightOpen: scope?.right.isOpen, rightTabId: scope?.right.activeTabId, selectedDestination: scope?.right.selectedDestination };
    });
    const target = { serverId: input.workspaceRef.serverId, machineId: input.workspaceRef.machineId, rootPath: input.activeRootPath };
    const checkout = resolveProjectCheckoutWorkspaceRef(workspaceRefs, input.workspaceRef, input.activeRootPath);
    const page = input.page ?? resolveProjectCockpitRouteFromPathname(pathname)?.page ?? 'overview';
    const selectedCompanion = pane.scopeState.selectedDestination;
    const companion = pane.scopeState.rightOpen
        ? selectedCompanion?.kind === 'plugin' ? selectedCompanion : pane.scopeState.rightTabId
        : undefined;
    const origin = React.useMemo(() => {
        const current = paneContext?.getSnapshot().state.scopes[pane.scopeId]?.details;
        const details = current ? buildDetailsWorkspaceStateView(current) : null;
        return accountScope && checkout ? buildProjectNewSessionOrigin({ scope: accountScope,
            workspace: workspaceAddressFromRefV1(checkout), page, routeParams,
            resource: details?.tabs.length ? readProjectSelectedRouteResource(details) ?? null : undefined,
            ...(companion ? { companion } : {}),
        }) : null;
    }, [accountScope, checkout, companion, paneContext, pane.scopeId, pane.scopeState, page, routeParams]);
    const targetKey = JSON.stringify([target.serverId, target.machineId, target.rootPath, origin]);
    const currentTargetKey = React.useRef(targetKey);
    currentTargetKey.current = targetKey;
    const mounted = React.useRef(true);
    React.useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; };
    }, []);
    const open = React.useCallback(async () => {
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime || !origin || !areServerProfileIdentifiersEquivalent(target.serverId, lifetime.scope.serverId)) return;
        const seed = { placement: { kind: 'exactTarget', serverId: target.serverId,
            machineId: target.machineId, directory: target.rootPath }, origin } satisfies PluginUiNewSessionSeedV1;
        // The authoring owner shows a refusal or a waiting approval, and stays quiet once this target is gone.
        await openSessionAuthoringAction({ seed }, lifetime,
            { isCurrent: () => mounted.current && currentTargetKey.current === targetKey });
    }, [target.serverId, target.machineId, target.rootPath, targetKey, origin]);
    return { open };
}
