import * as React from 'react';

import type { AppShellPluginUiProjectionPublication } from './appShellPluginUiProjectionPublication';
import type { PluginUiClientExecutableProjectionSource } from '@/components/plugins/reactNative/clientExecutableProjection';
import { createInstalledPluginUiReactNativeRuntimeProjectionSource,
    type PluginUiReactNativeRuntimeProjectionSource } from '@/components/plugins/reactNative/projectionInvalidation';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';

/** Mounted admission feeds AppShell's existing executable owner, never a second reconciler. */
export const MountedClientActionDemandContext = React.createContext<
    AppShellPluginUiProjectionPublication['publishMountedActions'] | null
>(null);

export const EMPTY_MOUNTED_CLIENT_ACTION_PROJECTIONS: readonly PluginUiClientExecutableProjectionSource[] = Object.freeze([]);

/** Share an admitted mount with the existing Artifact lease and AppShell activation owners. */
export function useMountedClientActionDemand(accountLifetime: ActiveServerAccountScopeLifetime | null,
    source: PluginUiClientExecutableProjectionSource | null): void {
    const publishMountedActions = React.useContext(MountedClientActionDemandContext);
    const [demandOwner] = React.useState(() => Symbol('mounted-client-actions'));
    const artifactSource = React.useRef<PluginUiReactNativeRuntimeProjectionSource | null>(null);
    React.useLayoutEffect(() => {
        if (!source && !artifactSource.current) return;
        const owner = artifactSource.current ?? createInstalledPluginUiReactNativeRuntimeProjectionSource();
        artifactSource.current = owner;
        owner.update({ projection: source?.projection ?? null, accountLifetime,
            isCurrent: () => accountLifetime?.isCurrent() === true });
    }, [accountLifetime, source]);
    React.useEffect(() => () => {
        artifactSource.current?.dispose();
        artifactSource.current = null;
    }, []);
    // Demand follows the mount, not its visibility. A retained surface hidden
    // with Freeze (a Session tab) disconnects layout effects; passive effects
    // stay connected, so hiding and showing it neither withdraws nor reloads
    // its executables. Unmount and Account change still withdraw.
    React.useEffect(() => () => publishMountedActions?.(demandOwner, accountLifetime, null),
        [accountLifetime, demandOwner, publishMountedActions]);
    React.useEffect(() => {
        publishMountedActions?.(demandOwner, accountLifetime, source);
    }, [accountLifetime, demandOwner, source, publishMountedActions]);
}
