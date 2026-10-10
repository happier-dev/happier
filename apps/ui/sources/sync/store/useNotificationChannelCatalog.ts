import * as React from 'react';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { observeNotificationChannelCatalog } from '@/sync/engine/settings/notificationChannelCatalogEngine';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { getNotificationChannelCatalogValue, subscribeNotificationChannelCatalogSnapshots,
    type NotificationChannelCatalogValueSnapshot } from '@/sync/store/settings/notificationChannelCatalogSnapshot';

const unavailableScope: NotificationChannelCatalogValueSnapshot = Object.freeze({ status: 'unavailable', channels: Object.freeze([]),
    diagnostics: Object.freeze([]), revision: 'absent', stale: true, reason: 'scope-unavailable' });
export function useNotificationChannelCatalog(requestedScope?: ServerAccountScope | null): NotificationChannelCatalogValueSnapshot {
    const active = useAccountSettingsScope();
    const scope = requestedScope === undefined ? active : requestedScope;
    const serverId = scope?.serverId;
    const accountId = scope?.accountId;
    const captured = React.useMemo(() => serverId && accountId ? { serverId, accountId } : null, [serverId, accountId]);
    React.useEffect(() => captured ? observeNotificationChannelCatalog(captured) : undefined, [captured]);
    const read = React.useCallback(() => captured ? getNotificationChannelCatalogValue(captured) : unavailableScope, [captured]);
    return React.useSyncExternalStore(subscribeNotificationChannelCatalogSnapshots, read, read);
}
