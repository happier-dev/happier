import * as React from 'react';
import { Redirect, useLocalSearchParams } from '@/components/appShell/workspace/destinationRoute';

/**
 * Older links to the stand-alone Secrets page. Saved Secrets now live in Credentials (owner 10-30), so this
 * opens them there, keeping a selected secret.
 */
export const WorkspaceRouteBody = React.memo(function SecretsSettingsRoute() {
    const params = useLocalSearchParams<{ secret?: string }>();
    const query = typeof params.secret === 'string' && params.secret ? `?${new URLSearchParams({ secret: params.secret })}` : '';
    return <Redirect href={`/(app)/settings/connected-services/secrets${query}` as never} />;
});
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export default function RouteEntry() { return <WorkspaceRouteEntry Body={WorkspaceRouteBody} />; }
