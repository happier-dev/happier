import * as React from 'react';
import { useLocalSearchParams } from '@/components/appShell/workspace/destinationRoute';

import { ProviderConnectionDetailScreen } from '@/components/settings/providers/ProviderConnectionDetailScreen';

function readParam(value: string | string[] | undefined): string | undefined {
    return Array.isArray(value) ? value[0] : value;
}

export function ProviderConnectionRoute() {
    const params = useLocalSearchParams<{
        connectionId?: string | string[];
        section?: string | string[];
        add?: string | string[];
        connected?: string | string[];
    }>();
    return (
        <ProviderConnectionDetailScreen
            connectionId={readParam(params.connectionId) ?? ''}
            section={readParam(params.section) ?? null}
            startAddingModels={readParam(params.add) === '1'}
            justConnected={readParam(params.connected) === '1'}
        />
    );
}
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export { ProviderConnectionRoute as WorkspaceRouteBody };
export default function RouteEntry() { return <WorkspaceRouteEntry Body={ProviderConnectionRoute} />; }
