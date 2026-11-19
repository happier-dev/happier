import * as React from 'react';
import { Platform } from 'react-native';
import { useCompactAppDestinationCatalog } from '../destinations/compactAppDestinationCatalog';
import { WorkspaceProvider } from './WorkspaceProvider';
import { useWorkspacePresentation } from './useWorkspaceShellEnabled';
import { useActiveServerAccountScope, useIsDataReady } from '@/sync/domains/state/storage';
import { resolveDesktopWindowContext } from '@/desktop/window/isDesktopAuxiliaryWindowContext';
import { AppWindowWorkspace } from '@/desktop/window/AppWindowWorkspace';
import { HomeReachabilityGate } from '@/components/navigation/connectionStatus/HomeReachabilityGate';
import { AppLaunchState } from './AppLaunchState';
import type { AppWindowRecord } from '@/desktop/window/appWindowBoot';

/** Above the palette and rail so every workspace launcher reaches the same owner. */
export function WorkspaceAppShellProvider(props: Readonly<{ children: React.ReactNode; browserWindow?: AppWindowRecord | null }>) {
    const { destinations: catalog, ready, accountLifetime } = useCompactAppDestinationCatalog();
    const presentation = useWorkspacePresentation();
    const accountScope = useActiveServerAccountScope();
    const dataReady = useIsDataReady();
    const admittedLifetime = React.useRef<typeof accountLifetime | undefined>(undefined);
    // A descriptive unscoped catalog is not the authenticated Account's initial
    // workspace. Registering its navigator before core restoration can lose the
    // parsed deep link when the supplied-Home refresh withdraws that first scope.
    const pendingFirstAccount = presentation !== null && presentation !== 'entry'
        && admittedLifetime.current === undefined && (!accountScope || !dataReady);
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
    if (pendingFirstAccount && Platform.OS === 'web') {
        // Nothing yet says which page opens, so startup is the app's launch state, not a page's loading rows.
        return <HomeReachabilityGate variant="pane"><AppLaunchState testID="workspace-account-restoring" /></HomeReachabilityGate>;
    }
    if ((presentation !== 'entry' && ((accountLifetime && !accountLifetime.isCurrent())
        || (!ready && admittedLifetime.current !== null && admittedLifetime.current !== accountLifetime)))) return null;
    if (resolveDesktopWindowContext().role === 'secondary') return <AppWindowWorkspace catalog={catalog} browserRecord={props.browserWindow}>{props.children}</AppWindowWorkspace>;
    return <WorkspaceProvider enabled={presentation === 'shell' && !pendingFirstAccount} phone={presentation === 'phone'}
        entry={presentation === 'entry'} deferred={pendingFirstAccount} catalog={catalog}>
        {props.children}
    </WorkspaceProvider>;
}
