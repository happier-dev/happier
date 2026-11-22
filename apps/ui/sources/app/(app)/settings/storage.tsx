import * as React from 'react';

import { useLocalSearchParams } from '@/components/appShell/workspace/destinationRoute';
import { AccountStorageView } from '@/components/storage/account/AccountStorageView';
import { parseAccountStorageItemFilter } from '@/components/storage/account/accountStorageModel';

/** Settings › Storage: the Account's Storage view; `?kind=artifacts` opens it filtered (the Artifacts page, quota notices). */
export const WorkspaceRouteBody = React.memo(function StorageSettingsRoute() {
    const params = useLocalSearchParams() as Record<string, string | string[] | undefined>;
    const kind = Array.isArray(params.kind) ? params.kind[0] : params.kind;
    return <AccountStorageView key={kind ?? 'all'} initialFilter={parseAccountStorageItemFilter(kind)} />;
});
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export default function RouteEntry() { return <WorkspaceRouteEntry Body={WorkspaceRouteBody} />; }
