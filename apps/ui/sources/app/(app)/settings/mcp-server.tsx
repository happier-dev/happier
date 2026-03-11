import React from 'react';
import { Stack } from 'expo-router';

import { McpServerEditorScreen } from '@/components/settings/mcpServers/McpServerEditorScreen';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { t } from '@/text';

export default React.memo(function McpServerEditorRoute() {
    const enabled = useFeatureEnabled('mcp.servers');
    const headerTitle = t('settings.mcpServersEditorTitle');
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
            <McpServerEditorScreen />
        </>
    );
});
