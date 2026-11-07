import * as React from 'react';
import { DetailsPaneSlotHost } from '@/components/appShell/panes/details/DetailsPaneSlot';
import { PluginPageContent } from '@/components/plugins/pages/PluginPageContent';
import { resolvePluginPageForRoute, usePluginPages, selectPluginPagePlacements } from '@/components/plugins/pages/pluginPages';
import { buildPluginAppPageRoutePath } from '@/components/plugins/pages/pluginPageRoute';
import { useAppShellPluginUiProjection, useProjectedPluginLocalizedTextResolver } from './AppShellPluginUiProjection';
import { t } from '@/text';
import {
    isAppliedActiveServerRuntimeAvailable,
    isColdActiveServerRestorePending,
    subscribeAppliedActiveServerRuntimeAvailability,
    subscribeColdActiveServerRestore,
} from '@/sync/runtime/orchestration/connectionManager';
import { useIsDataReady } from '@/sync/store/hooks';

export function PluginAppPageScreen(props: Readonly<{
    pluginId: string; localId: string; subPath: string | null;
    /** The declared view the route names (`?view=`), or `null` for the page itself. */
    view?: string | null;
}>): React.ReactElement {
    const projection = useAppShellPluginUiProjection();
    const coldAccountRestorePending = React.useSyncExternalStore(
        subscribeColdActiveServerRestore,
        isColdActiveServerRestorePending,
        isColdActiveServerRestorePending,
    );
    const appliedRuntimeAvailable = React.useSyncExternalStore(
        subscribeAppliedActiveServerRuntimeAvailability,
        isAppliedActiveServerRuntimeAvailable,
        isAppliedActiveServerRuntimeAvailable,
    );
    const isDataReady = useIsDataReady();
    const localize = useProjectedPluginLocalizedTextResolver();
    const placements = React.useMemo(() => selectPluginPagePlacements(projection.pluginUiProjection,
        { container: 'appPage', targetKind: 'app' }), [projection.pluginUiProjection]);
    const pages = usePluginPages({ target: { kind: 'app' }, placements, localize });
    const page = resolvePluginPageForRoute({ pages, pluginId: props.pluginId, localId: props.localId });
    const title = page?.label ?? t('pluginSurfaces.appPage.title');
    const routePathFor = React.useCallback((subPath: string, view: string | null) => buildPluginAppPageRoutePath({
        pluginId: props.pluginId, localId: props.localId, subPath, view,
    }), [props.pluginId, props.localId]);
    const renderContent = React.useCallback((content: React.ReactElement) => <DetailsPaneSlotHost testID="plugin-app-page-details" mainColumn={{
        hideLabel: t('panes.mainColumn.hidePage', { title }),
        showLabel: t('panes.mainColumn.showPage', { title }),
        identity: { name: title },
    }}>
        {content}
    </DetailsPaneSlotHost>, [title]);
    return <PluginPageContent {...props} page={page} views={pages} projection={projection} routePathFor={routePathFor}
        initialView={props.view ?? null}
        accountScopeRestoring={coldAccountRestorePending || (appliedRuntimeAvailable && !isDataReady)}
        renderContent={renderContent} appChrome />;
}
