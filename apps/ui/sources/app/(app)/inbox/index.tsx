import * as React from 'react';
import { useLocalSearchParams } from '@/components/appShell/workspace/destinationRoute';
import { readInboxItemFocus } from '@/components/inbox/inboxItemFocus';
import { InboxView } from '@/components/navigation/shell/InboxView';
import { useRequireInboxAvailable } from '@/hooks/inbox/useRequireInboxAvailable';

/** The Inbox route owns its one focus parameter, `item` (`createInboxItemRoute`). */
export function InboxPage() {
    const enabled = useRequireInboxAvailable();
    const params = useLocalSearchParams<{ item?: string | string[]; invocationId?: string | string[] }>();
    const rawItem = Array.isArray(params.item) ? params.item[0] : params.item;
    const focusedItem = React.useMemo(() => readInboxItemFocus(rawItem, params.invocationId), [rawItem, params.invocationId]);
    if (!enabled) return null;
    return <InboxView focusedItem={focusedItem} />;
}
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export { InboxPage as WorkspaceRouteBody };
export default function RouteEntry() { return <WorkspaceRouteEntry Body={InboxPage} />; }
