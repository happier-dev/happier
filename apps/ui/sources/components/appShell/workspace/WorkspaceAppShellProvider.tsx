import * as React from 'react';
import { Platform } from 'react-native';
import { useCompactAppDestinationCatalog } from '../destinations/compactAppDestinationCatalog';
import { WorkspaceProvider } from './WorkspaceProvider';
import { WorkspacePhoneHomeArrivalContext, WorkspaceShellWillHostRoutesContext } from './WorkspaceRouteHostingContext';
import { useWorkspacePresentation } from './useWorkspaceShellEnabled';
import { storage, useActiveServerAccountScope, useIsDataReady } from '@/sync/domains/state/storage';
import { resolveDesktopWindowContext } from '@/desktop/window/isDesktopAuxiliaryWindowContext';
import { AppWindowWorkspace } from '@/desktop/window/AppWindowWorkspace';
import { isHomeArrivalMotionPending } from '@/components/hub/homeArrival';
import { skipStepMotion } from '@/components/ui/motion/stepMotion/StepMotionStage';
import { HomeReachabilityGate } from '@/components/navigation/connectionStatus/HomeReachabilityGate';
import { AppLaunchState } from './AppLaunchState';
import type { AppWindowRecord } from '@/desktop/window/appWindowBoot';
import { useCurrentRoutePathname } from './currentRouteLocation';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { isUserFacingSession } from '@/sync/domains/session/listing/isUserFacingSession';

function revealUnavailableHome(): void {
    // The held entry must yield to the reachable Retry control if admission ends offline.
    if (isHomeArrivalMotionPending()) skipStepMotion();
}

/** Above the palette and rail so every workspace launcher reaches the same owner. */
export function WorkspaceAppShellProvider(props: Readonly<{ children: React.ReactNode; browserWindow?: AppWindowRecord | null }>) {
    const { destinations: catalog, ready, accountLifetime } = useCompactAppDestinationCatalog();
    const requestedPresentation = useWorkspacePresentation();
    const hasWorkspace = requestedPresentation !== null;
    const [hadWorkspace, setHadWorkspace] = React.useState(hasWorkspace);
    // Give the live public route its credential-publication layout before the workspace
    // takes its place. The route can then capture the outgoing workflow at its own commit.
    const presentation = hadWorkspace || requestedPresentation === 'entry' ? requestedPresentation : null;
    React.useLayoutEffect(() => { setHadWorkspace(hasWorkspace); }, [hasWorkspace]);
    const accountScope = useActiveServerAccountScope();
    const dataReady = useIsDataReady();
    const admittedLifetime = React.useRef<typeof accountLifetime | undefined>(undefined);
    const warmHomeLifetime = React.useRef<typeof accountLifetime>(null);
    const pathname = useCurrentRoutePathname();
    // Only the ordinary main-window Home may start from a display projection.
    // An addressed arrival still needs the exact destination's normal admission.
    const mayRestoreWarmHome = Platform.OS === 'web' && !dataReady && presentation !== null
        && presentation !== 'entry' && props.browserWindow == null && resolveDesktopWindowContext().role === 'primary'
        && pathname === '/' && typeof window !== 'undefined'
        && window.location.pathname === '/' && !window.location.search && !window.location.hash
        && ready && accountScope !== null && accountLifetime !== null && accountLifetime.isCurrent()
        && areServerAccountScopesEqual(accountScope, accountLifetime.scope);
    const hasRetainedRows = storage(state => {
        if (!mayRestoreWarmHome || !accountScope || !areServerAccountScopesEqual(accountScope, state.settingsScope)) return false;
        const rows = state.sessionListRowsByServerId[accountScope.serverId];
        return Boolean(rows && state.ordinarySessionListMembershipByServerId[accountScope.serverId]?.some(id => {
            const row = rows[id];
            return row?.metadata != null && isUserFacingSession(row);
        }));
    });
    const restoreRetainedHome = !dataReady && accountLifetime !== null && accountLifetime.isCurrent()
        && (hasRetainedRows || warmHomeLifetime.current === accountLifetime);
    React.useLayoutEffect(() => {
        warmHomeLifetime.current = restoreRetainedHome ? accountLifetime : null;
    }, [accountLifetime, restoreRetainedHome]);
    // A descriptive unscoped catalog is not the authenticated Account's initial
    // workspace. Registering its navigator before core restoration can lose the
    // parsed deep link when the supplied-Home refresh withdraws that first scope.
    const pendingFirstAccount = presentation !== null && presentation !== 'entry'
        && admittedLifetime.current === undefined && (!accountScope || (!dataReady && !restoreRetainedHome));
    React.useLayoutEffect(() => {
        if (!pendingFirstAccount && ready && (!accountLifetime || accountLifetime.isCurrent())) admittedLifetime.current = accountLifetime;
    }, [accountLifetime, pendingFirstAccount, ready]);
    // The first URL and restored tabs must see this exact source before their state initializes.
    // Once admitted, a current Account keeps its workspace and editors through source refreshes.
    // A mounted unscoped catalog has no previous Account content to withdraw. Keep its navigator
    // through the first Account publication: unmounting it resets an authenticated cold deep link
    // to Expo's initial route. Public entry owns an in-flight authentication or
    // exact-Home arrival, so it also keeps that navigator while the Account
    // runtime is readmitted. Private workspace surfaces still withdraw with
    // their retired Account; public entry hosts no retained private destination.
    // Native's stack owns recovery navigation before the workspace can restore private tabs.
    // Web retains its initial navigator gate so a transient first scope cannot consume its deep link.
    // While it waits, the person sees the startup state, or the Home's Retry once it is unreachable.
    const [pendingPhoneHome, setPendingPhoneHome] = React.useState<'/home' | null>(null);
    // A descriptive catalog can be ready before Sync publishes the new Account. An Expo-only leaf
    // can replace its route once the Account is ready and its navigator will stay mounted.
    const restoring = Platform.OS === 'web' && (pendingFirstAccount || (pendingPhoneHome !== null && (!ready || !dataReady)));
    const canNavigate = presentation !== null && !restoring && ready && dataReady;
    React.useLayoutEffect(() => {
        if (!hasWorkspace) setPendingPhoneHome(null);
    }, [hasWorkspace]);
    const phoneHomeArrival = React.useMemo(() => ({
        defer(href: '/home') {
            if (canNavigate || requestedPresentation !== 'phone') return false;
            setPendingPhoneHome(href);
            return true;
        },
        take() {
            if (!canNavigate || !pendingPhoneHome) return null;
            setPendingPhoneHome(null);
            return pendingPhoneHome;
        },
    }), [canNavigate, pendingPhoneHome, requestedPresentation]);
    if (!restoring && (presentation !== 'entry' && ((accountLifetime && !accountLifetime.isCurrent())
        || (!ready && admittedLifetime.current !== null && admittedLifetime.current !== accountLifetime)))) return null;
    if (!restoring && resolveDesktopWindowContext().role === 'secondary') {
        return <AppWindowWorkspace catalog={catalog} browserRecord={props.browserWindow}>{props.children}</AppWindowWorkspace>;
    }
    return <WorkspaceProvider enabled={presentation === 'shell' && !pendingFirstAccount} phone={presentation === 'phone'}
        entry={presentation === 'entry'} deferred={pendingFirstAccount} restoreRetainedHome={restoreRetainedHome} catalog={catalog}>
        {restoring
            ? <HomeReachabilityGate variant="pane" onUnavailable={revealUnavailableHome}>
                <AppLaunchState testID="workspace-account-restoring" />
            </HomeReachabilityGate>
            : <WorkspaceShellWillHostRoutesContext.Provider value={Platform.OS === 'web' && requestedPresentation === 'shell'}>
                <WorkspacePhoneHomeArrivalContext.Provider value={Platform.OS === 'web' ? phoneHomeArrival : null}>
                    {props.children}
                </WorkspacePhoneHomeArrivalContext.Provider>
            </WorkspaceShellWillHostRoutesContext.Provider>}
    </WorkspaceProvider>;
}
