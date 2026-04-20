import * as React from 'react';
import { useLocalSearchParams } from 'expo-router';

import { PluginDetailScreen } from '@/components/settings/plugins/detail/PluginDetailScreen';
import { readPluginDetailRoutePluginId } from '@/components/settings/plugins/model/pluginDetailRoute';

export default React.memo(function PluginDetailRoute() {
    const params = useLocalSearchParams();
    const pluginId = readPluginDetailRoutePluginId(params.pluginId);

    return <PluginDetailScreen pluginId={pluginId} />;
});
