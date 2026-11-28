import * as React from 'react';
import { DetailsPaneSlotHost } from '@/components/appShell/panes/details/DetailsPaneSlot';
import { PluginPageContent } from '@/components/plugins/pages/PluginPageContent';
import { resolvePluginPageForRoute, usePluginPages, selectPluginPagePlacements } from '@/components/plugins/pages/pluginPages';
import { buildPluginAppPageRoutePath, pluginAppPageRouteSelectsEntry, readPluginAppPageLocation } from '@/components/plugins/pages/pluginPageRoute';
import { resolvePortableServerIdentityForRoutingId } from '@/sync/domains/server/resolvePortableServerIdentityForRoutingId';
import { useAppShellPluginUiPageProjection, useProjectedPluginLocalizedTextResolver } from './AppShellPluginUiProjection';
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
    const projection = useAppShellPluginUiPageProjection();
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
    const location = readPluginAppPageLocation(props.subPath);
    const { serverId, machineId, installationId } = location?.machine ?? {};
    const machine = React.useMemo(() => serverId && machineId && installationId
        ? { serverId, machineId, installationId } : null, [serverId, machineId, installationId]);
    const serverIdentityId = machine ? resolvePortableServerIdentityForRoutingId(machine.serverId) ?? machine.serverId : null;
    const executionTarget = React.useMemo(() => machine && serverIdentityId
        ? { serverIdentityId, machineId: machine.machineId, installationId: machine.installationId }
        : undefined, [machine, serverIdentityId]);
    const routePathFor = React.useCallback((subPath: string, view: string | null) => buildPluginAppPageRoutePath({
        pluginId: props.pluginId, localId: props.localId, subPath, view, machine,
    }), [props.pluginId, props.localId, machine]);
    const renderContent = React.useCallback((content: React.ReactElement) => <DetailsPaneSlotHost testID="plugin-app-page-details" mainColumn={{
        hideLabel: t('panes.mainColumn.hidePage', { title }),
        showLabel: t('panes.mainColumn.showPage', { title }),
        identity: { name: title },
    }}>
        {content}
    </DetailsPaneSlotHost>, [title]);
    return <PluginPageContent key={machine ? JSON.stringify(machine) : undefined}
        pluginId={props.pluginId} localId={props.localId} subPath={location?.subPath ?? null}
        page={page} views={pages} projection={projection} routePathFor={routePathFor}
        contextualExecutionTarget={executionTarget}
        initialView={props.view ?? null}
        entryDetail={pluginAppPageRouteSelectsEntry(props.pluginId, props.subPath)}
        accountScopeRestoring={coldAccountRestorePending || (appliedRuntimeAvailable && !isDataReady)}
        renderContent={renderContent} appChrome />;
}
