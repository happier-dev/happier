import * as React from 'react';
import { useLocalSearchParams } from 'expo-router';

import { PluginAppPageScreen } from '@/components/appShell/plugins/PluginAppPageScreen';
import { readPluginAppPageRouteIdentity } from '@/components/appShell/plugins/pluginAppPageRoute';

export default React.memo(function PluginAppPageRootRoute() {
    const identity = readPluginAppPageRouteIdentity(useLocalSearchParams());

    return (
        <PluginAppPageScreen
            pluginId={identity.pluginId}
            localId={identity.localId}
            subPath=""
        />
    );
});
