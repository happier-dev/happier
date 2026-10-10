import * as React from 'react';
import { Redirect } from '@/components/appShell/workspace/destinationRoute';

import { McpServerCollection } from './collection/McpServerCollection';
import {
    buildMcpServerCollection,
    mcpServerRoute,
    resolveMcpServerLandingId,
} from './collection/mcpServerCollectionModel';
import { useMcpServersSettings } from './useMcpServersSettings';
import { useHappierCollectionIndexView } from '@happier-dev/plugin-ui/presentation';

/**
 * `/settings/mcp`. Beside the rail a server is always selected, so the index lands on one; with no
 * server yet it invites adding the first. Where no rail shows, the index is the server list.
 */
export const McpSettingsIndex = React.memo(function McpSettingsIndex() {
    const view = useHappierCollectionIndexView();
    if (view === 'pending') return null;
    if (view === 'land') return <McpCollectionLanding />;
    return <McpServerCollection variant="page" />;
});

const McpCollectionLanding = React.memo(function McpCollectionLanding() {
    const { settings } = useMcpServersSettings();
    const rows = React.useMemo(() => buildMcpServerCollection(settings, ''), [settings]);

    const landingId = resolveMcpServerLandingId(rows);
    if (landingId) return <Redirect href={mcpServerRoute(landingId) as never} />;

    return <McpServerCollection variant="page" />;
});
