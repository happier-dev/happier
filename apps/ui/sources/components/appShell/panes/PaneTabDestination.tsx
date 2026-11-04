import * as React from 'react';
import type { PaneTabAddress } from '@happier-dev/protocol/actions';
import { AppPaneProvider } from './AppPaneProvider';
import { AppPaneContext, useAppPaneContext } from './AppPaneContext';
import { DetailsTabLifetimeScope } from './details/workspace/detailsTabLifetime';
import { DetailsSurfaceFallback } from './details/surfaces/DetailsSurfaceFallback';
import { parseSessionPaneScopeId } from '@/components/sessions/panes/sessionPaneScopeId';
import { parseProjectPaneScopeId } from '@/components/projects/detail/projectPaneScope';
import { SessionDetailsPanel } from '@/components/sessions/panes/SessionDetailsPanel';
import { WorkspaceDetailsPanel } from '@/components/projects/panes/WorkspaceDetailsPanel';
import { useWorkspaceRefs } from '@/sync/domains/state/storage';
import { resolveWorkspaceRefById } from '@/sync/domains/workspaces/workspaceRefs';
import type { DetailsTabState } from './details/workspace/detailsWorkspaceTypes';
import type { AppPaneContextValue } from './AppPaneContext';
import { closePaneWindowTab, preparePaneTabWindowTransfer, preparePaneTabWindowClose } from './paneTabWindowTransfer';
import { isSelectedPaneDestinationTabKey } from './model/selectedPaneDestination';
import { SelectedPaneDestinationHost } from './SelectedPaneDestinationHost';
import { ProjectDetailScreen } from '@/components/projects/ProjectDetailScreen';
import { AppScopePaneHost } from './AppScopePaneHost';
import { APP_PANE_SCOPE_ID } from '@/components/appShell/rightSidebar/appScopeRightSidebarNavigation';
import { readResourcePaneScopeId } from './paneScopeIdentity';
import { resolveDetailsPresentationTabKey } from './details/workspace/detailsWorkspaceSelectors';

export type PaneTabDestinationOwner = Readonly<{
    prepareTransfer: () => Promise<boolean>;
    prepareClose: () => Promise<boolean>;
    close: () => Promise<boolean>;
    read: () => AppPaneContextValue;
}>;
type Props = Readonly<{ address: PaneTabAddress; restoredTabKey?: string;
    onReady?: (owner: PaneTabDestinationOwner) => void | (() => void) }>;

function PaneTabMountedOwner(props: React.PropsWithChildren<Props>) {
    const subscription = React.useContext(AppPaneContext);
    const { address, restoredTabKey, onReady } = props;
    React.useEffect(() => {
        const presentedAddress = { ...address, tabKey: isSelectedPaneDestinationTabKey(address.tabKey) ? address.tabKey : restoredTabKey ?? address.tabKey };
        if (!subscription) return;
        const read = subscription.getSnapshot;
        return onReady?.({ read,
            prepareTransfer: () => preparePaneTabWindowTransfer(read(), presentedAddress),
            prepareClose: () => preparePaneTabWindowClose(read(), presentedAddress),
            close: () => closePaneWindowTab(read(), presentedAddress) });
    }, [address, onReady, restoredTabKey, subscription]);
    return <>{props.children}</>;
}

function ProjectPaneTab(props: Readonly<{ address: PaneTabAddress; tab: DetailsTabState; workspaceRefId: string }>) {
    const refs = useWorkspaceRefs();
    const resolved = resolveWorkspaceRefById(refs, props.workspaceRefId, props.address.serverId);
    return resolved.kind === 'resolved'
        ? <WorkspaceDetailsPanel workspaceRef={resolved.ref} scopeId={props.address.scopeId} destinationTab={props.tab} />
        : <DetailsSurfaceFallback status="missing" />;
}

function PaneTabContent(props: Readonly<{ address: PaneTabAddress; restoredTabKey?: string }>) {
    const selectedSlot = isSelectedPaneDestinationTabKey(props.address.tabKey);
    const tabKey = selectedSlot ? props.address.tabKey : props.restoredTabKey ?? props.address.tabKey;
    const tab = useAppPaneContext(value => {
        const details = value.state.scopes[props.address.scopeId]?.details;
        return details ? details.tabsByKey[resolveDetailsPresentationTabKey(details, tabKey)] : undefined;
    });
    const session = parseSessionPaneScopeId(props.address.scopeId);
    const project = parseProjectPaneScopeId(props.address.scopeId);
    if (selectedSlot) return <DetailsTabLifetimeScope scopeId={props.address.scopeId} tabKey={tabKey}>
        {session ? <SelectedPaneDestinationHost scopeId={props.address.scopeId} tabKey={tabKey}
            sessionId={session.sessionId} serverId={props.address.serverId} />
            : project ? <ProjectDetailScreen workspaceRefId={project.workspaceRefId} serverId={props.address.serverId}
                paneScopeId={props.address.scopeId} selectedPaneTabKey={tabKey} />
                : readResourcePaneScopeId(props.address.scopeId) === APP_PANE_SCOPE_ID ? <AppScopePaneHost main={null}
                    paneScopeId={props.address.scopeId} selectedPaneTabKey={tabKey} />
                    : <DetailsSurfaceFallback status="unsupported" />}
    </DetailsTabLifetimeScope>;
    if (!tab) return <DetailsSurfaceFallback status="missing" />;
    return <DetailsTabLifetimeScope scopeId={props.address.scopeId} tabKey={tab.key}>
        {session ? <SessionDetailsPanel sessionId={session.sessionId} routeServerId={props.address.serverId}
            scopeId={props.address.scopeId} destinationTab={tab} destinationActive presentation="screen" showHeaderActions={false} />
            : project ? <ProjectPaneTab address={props.address} tab={tab} workspaceRefId={project.workspaceRefId} />
                : <DetailsSurfaceFallback status="unsupported" />}
    </DetailsTabLifetimeScope>;
}

/** Only the addressed real Details body mounts; parent and sibling content stay in their source realm. */
export function PaneTabDestination(props: Props) {
    const selection = React.useMemo(() => ({ scopeId: props.address.scopeId,
        tabKey: isSelectedPaneDestinationTabKey(props.address.tabKey) ? props.address.tabKey : props.restoredTabKey ?? props.address.tabKey }),
        [props.address.scopeId, props.address.tabKey, props.restoredTabKey]);
    return <AppPaneProvider presentedPaneTab={selection}>
        <PaneTabMountedOwner {...props}>
        <PaneTabContent address={props.address} restoredTabKey={props.restoredTabKey} />
        </PaneTabMountedOwner>
    </AppPaneProvider>;
}
