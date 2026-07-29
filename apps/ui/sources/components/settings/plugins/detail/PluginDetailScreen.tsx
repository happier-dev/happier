import * as React from 'react';
import { Redirect, useNavigation } from 'expo-router';

import { ItemList } from '@/components/ui/lists/ItemList';
import { t } from '@/text';

import { PluginDetailActionsSection } from './PluginDetailActionsSection';
import { PluginDetailContributionsSection } from './PluginDetailContributionsSection';
import { PluginDetailDiagnosticsSection } from './PluginDetailDiagnosticsSection';
import { PluginDetailGenericSettingsSection } from './PluginDetailGenericSettingsSection';
import { PluginDetailHeader } from './PluginDetailHeader';
import { PluginDetailSummaryGrid } from './PluginDetailSummaryGrid';
import { usePluginSettingsScreenState } from '../model/usePluginSettingsScreenState';
import { PluginReadOnlySnapshotNotice } from '../PluginReadOnlySnapshotNotice';

type NavigationLike = Readonly<{
    setOptions?: (options: Readonly<{ headerTitle?: string }>) => void;
}>;

export const PluginDetailScreen = React.memo(function PluginDetailScreen(props: Readonly<{
    pluginId: string | null;
}>) {
    const navigation = useNavigation() as NavigationLike;
    const state = usePluginSettingsScreenState();
    const installed = props.pluginId ? (state.installedPluginById.get(props.pluginId) ?? null) : null;

    if (!props.pluginId || !installed) {
        return <Redirect href="/settings/plugins" />;
    }

    const projection = state.pluginProjectionById[installed.pluginId] ?? null;
    const headerTitle = projection?.title ?? installed.title;

    React.useLayoutEffect(() => {
        navigation.setOptions?.({ headerTitle });
    }, [headerTitle, navigation]);

    return (
        <ItemList style={{ paddingTop: 0 }}>
            {state.isReadOnlySnapshot ? (
                <PluginReadOnlySnapshotNotice testID="settings.plugins.detail.readOnlySnapshot" />
            ) : null}
            <PluginDetailHeader installed={installed} projection={projection} />
            <PluginDetailSummaryGrid
                installed={installed}
                projection={projection}
            />
            <PluginDetailActionsSection
                installed={installed}
                actionInFlight={state.isPluginActionInFlight(installed.pluginId)}
                canRunActions={state.canRefreshInstalledPlugins}
                onAction={state.runInstalledPluginAction}
            />
            <PluginDetailGenericSettingsSection
                pluginId={installed.pluginId}
                projection={projection}
                machineId={state.primaryMachineId}
                serverId={state.activeServerId}
                daemonOperationsAvailable={state.daemonOperationsAvailable}
            />
            <PluginDetailContributionsSection pluginId={installed.pluginId} projection={projection} />
            <PluginDetailDiagnosticsSection
                pluginId={installed.pluginId}
                projection={projection}
                registryDiagnostics={state.registryDiagnostics}
            />
        </ItemList>
    );
});

export default PluginDetailScreen;
