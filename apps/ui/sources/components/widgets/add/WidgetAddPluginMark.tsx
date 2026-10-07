import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { useAppShellPluginUiProjection } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { InstalledPluginBrandMark } from '@/components/plugins/shared/InstalledPluginBrandMark';
import { useInstalledPluginBrandPresentation } from '@/components/plugins/shared/installedPluginBrandPresentation';
import { Icon } from '@/components/ui/icons/Icon';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';

/**
 * A plugin section's mark in the Add surface's list (lab `widget-add` wsplit A: "GitHub plugin"):
 * the installed package's own brand through the one brand presentation owner, or the neutral
 * plugin glyph while the brand is absent or still arriving. The section title names the plugin.
 */
export function WidgetAddPluginMark(props: Readonly<{ pluginId: string; size: number; testID?: string }>): React.ReactElement {
    const { theme } = useUnistyles();
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
    return brand
        ? <InstalledPluginBrandMark brand={brand} externallyLabelled size="small" pixelSize={props.size} {...(props.testID ? { testID: props.testID } : {})} />
        : <Icon name="puzzle-piece" size={props.size} color={theme.colors.text.secondary} {...(props.testID ? { testID: props.testID } : {})} />;
}
