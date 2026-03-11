import React from 'react';
import { Stack } from 'expo-router';

import { McpServersSettingsScreen } from '@/components/settings/mcpServers/McpServersSettingsScreen';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { t } from '@/text';

export default React.memo(function McpServersSettingsRoute() {
    const enabled = useFeatureEnabled('mcp.servers');
    const headerTitle = t('settings.mcpServers');
    const headerBackTitle = t('common.back');

    const screenOptions = React.useMemo(() => {
        return {
            headerShown: true,
            headerTitle,
            headerBackTitle,
        } as const;
    }, [headerBackTitle, headerTitle]);

    if (!enabled) {
        return null;
    }

    return (
        <>
            <Stack.Screen options={screenOptions} />
            <McpServersSettingsScreen />
        </>
    );
});
