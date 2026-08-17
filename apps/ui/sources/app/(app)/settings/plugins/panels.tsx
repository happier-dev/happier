import { AppScopeRightSidebar } from '@/components/appShell/rightSidebar/AppScopeRightSidebar';
import { useLocalSearchParams } from 'expo-router';

export default function PluginAppPanelsSettingsRoute() {
    const params = useLocalSearchParams<{ pluginId?: string; destinationId?: string }>();
    const pluginId = typeof params.pluginId === 'string' ? params.pluginId.trim() : '';
    const localId = typeof params.destinationId === 'string' ? params.destinationId.trim() : '';
    const requestedDestination = pluginId.length > 0 && localId.length > 0
        ? { pluginId, localId }
        : undefined;
    return (
        <AppScopeRightSidebar
            scopeId="settings:plugins:panels"
            requestedDestination={requestedDestination}
            testID="settings.plugins.appPanels.host"
        />
    );
}
