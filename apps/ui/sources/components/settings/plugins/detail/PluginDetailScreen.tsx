import * as React from 'react';
import { Redirect, useNavigation } from 'expo-router';

import { ItemList } from '@/components/ui/lists/ItemList';
import { t } from '@/text';

import { PluginDetailActionsSection } from './PluginDetailActionsSection';
import { PluginDetailContributionsSection } from './PluginDetailContributionsSection';
import { PluginDetailDescriptorsSection } from './PluginDetailDescriptorsSection';
import { PluginDetailDiagnosticsSection } from './PluginDetailDiagnosticsSection';
import { PluginDetailHeader } from './PluginDetailHeader';
import { PluginDetailSummaryGrid } from './PluginDetailSummaryGrid';
import { usePluginSettingsScreenState } from '../model/usePluginSettingsScreenState';

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
    const updateState = state.readInstalledPluginUpdateState(installed.pluginId);
    const headerTitle = projection?.title ?? installed.title;

    React.useLayoutEffect(() => {
        navigation.setOptions?.({ headerTitle });
    }, [headerTitle, navigation]);

    return (
        <ItemList style={{ paddingTop: 0 }}>
                <PluginDetailHeader installed={installed} projection={projection} />
                <PluginDetailSummaryGrid
                    installed={installed}
                    projection={projection}
                    updateState={updateState}
                />
                <PluginDetailActionsSection
                    installed={installed}
                    updateState={updateState}
                    actionInFlight={state.isPluginActionInFlight(installed.pluginId)}
                    canRunActions={state.canRefreshInstalledPlugins}
                    onAction={state.runInstalledPluginAction}
                />
                <PluginDetailContributionsSection pluginId={installed.pluginId} projection={projection} />
                <PluginDetailDiagnosticsSection
                    pluginId={installed.pluginId}
                    projection={projection}
                    registryDiagnostics={state.registryDiagnostics}
                />
                <PluginDetailDescriptorsSection pluginId={installed.pluginId} projection={projection} />
        </ItemList>
    );
});

export default PluginDetailScreen;
