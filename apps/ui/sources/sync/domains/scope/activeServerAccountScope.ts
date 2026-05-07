import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { readRegisteredStorageState } from '@/sync/domains/state/storageStateReaderBridge';

import type { ServerAccountScope } from './serverAccountScope';

export function getActiveServerAccountScope(): ServerAccountScope | null {
    const activeServerId = String(getActiveServerSnapshot().serverId ?? '').trim();
    const profileScope = readRegisteredStorageState()?.profileScope ?? null;
    if (!activeServerId || !profileScope) {
        return null;
    }
    return profileScope.serverId === activeServerId ? profileScope : null;
}
