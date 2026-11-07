import * as React from 'react';
import { useLocalSearchParams } from '@/components/appShell/workspace/destinationRoute';

import { ProviderConnectionModelsScreen } from '@/components/settings/providers/models/ProviderConnectionModelsScreen';

/** `/settings/providers/<id>/models`: the connection's Models page, opened from its detail's Models row. */
export function ProviderConnectionModelsRoute() {
    const params = useLocalSearchParams<{ connectionId?: string | string[]; add?: string | string[]; allowanceFor?: string | string[] }>();
    const connectionId = Array.isArray(params.connectionId) ? params.connectionId[0] ?? '' : params.connectionId ?? '';
    const add = Array.isArray(params.add) ? params.add[0] : params.add;
    const allowanceFor = Array.isArray(params.allowanceFor) ? params.allowanceFor[0] : params.allowanceFor;
    return <ProviderConnectionModelsScreen connectionId={connectionId} startAdding={add === '1'} startEditingGenerationOf={allowanceFor || undefined} />;
}
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export { ProviderConnectionModelsRoute as WorkspaceRouteBody };
export default function RouteEntry() { return <WorkspaceRouteEntry Body={ProviderConnectionModelsRoute} />; }
