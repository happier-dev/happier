import React from 'react';

import { McpServersSettingsScreen } from '@/components/settings/mcpServers/McpServersSettingsScreen';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';

export default React.memo(function McpServersSettingsRoute() {
    const enabled = useFeatureEnabled('mcp.servers');

    if (!enabled) {
        return null;
    }

    return <McpServersSettingsScreen />;
});
