import * as React from 'react';
import { useLocalSearchParams } from 'expo-router';

import { PluginAppPageScreen } from '@/components/appShell/plugins/PluginAppPageScreen';
import {
    readPluginAppPageRouteIdentity,
} from '@/components/appShell/plugins/pluginAppPageRoute';
import { readPluginAppPageSubPath } from '@/components/appShell/plugins/pluginAppPages';

export default React.memo(function PluginAppPageDeepRoute() {
    const params = useLocalSearchParams();
    const identity = readPluginAppPageRouteIdentity(params);

    return (
        <PluginAppPageScreen
            pluginId={identity.pluginId}
            localId={identity.localId}
            subPath={readPluginAppPageSubPath(params.subPath)}
        />
    );
});
