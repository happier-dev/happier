import * as React from 'react';
import { useLocalSearchParams } from 'expo-router';

import { PluginSettingsPageScreen } from '@/components/settings/plugins/PluginSettingsPageScreen';
import { readPluginSettingsPageRouteParams } from '@/components/settings/catalog/runtime/pluginSettingsPageCatalog';

export default React.memo(function PluginSettingsPageRoute() {
    const params = useLocalSearchParams();
    const route = readPluginSettingsPageRouteParams(params);

    return <PluginSettingsPageScreen pluginId={route?.pluginId ?? null} pageId={route?.pageId ?? null} />;
});
