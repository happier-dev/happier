import React from 'react';

import { McpServerEditorScreen } from '@/components/settings/mcpServers/McpServerEditorScreen';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';

export default React.memo(function McpServerEditorRoute() {
    const enabled = useFeatureEnabled('mcp.servers');

    if (!enabled) {
        return null;
    }

    return <McpServerEditorScreen />;
});
