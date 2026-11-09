import * as React from 'react';

import { useAppShellPluginUiProjection } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { HappierBrandMark } from '@/components/ui/media/HappierBrandMark';
import { useInstalledPluginBrandPresentation } from '@/components/plugins/shared/installedPluginBrandPresentation';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';

/**
 * An installed plugin's mark beside its name, found by plugin id (the Add surface's sections, the
 * Settings rail's plugin rows): the package's own brand through the one brand presentation owner,
 * or its canonical letter fallback while artwork is absent or still arriving.
 * The adjacent title names the plugin.
 */
export function InstalledPluginMarkById(props: Readonly<{ pluginId: string; size: number; testID?: string }>): React.ReactElement {
    const app = useAppShellPluginUiProjection();
    const installed = app.pluginUiProjection?.installedPackagesById[props.pluginId] ?? null;
    const installedPackage = app.phase === 'current' && installed?.brand ? installed : null;
    const scope = React.useMemo(() => new AbortController(), [installedPackage, app.machineId, app.serverId]);
    React.useEffect(() => () => scope.abort(), [scope]);
    const brand = useInstalledPluginBrandPresentation({
        installedPackage,
        machineId: app.machineId ?? null,
        serverId: app.serverId ?? null,
        signal: scope.signal,
        accountLifetime: installedPackage ? captureActiveServerAccountScopeLifetime() : null,
        isCurrent: () => installedPackage !== null && !scope.signal.aborted,
    });
    return <HappierBrandMark brand={brand ?? { displayName: installed?.displayName ?? props.pluginId }} externallyLabelled size="small" pixelSize={props.size} {...(props.testID ? { testID: props.testID } : {})} />;
}
