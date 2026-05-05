import * as React from 'react';

import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { useSessionServerId } from '@/sync/store/hooks';
import { normalizeServerId } from './normalizeServerId';

export function usePreferredServerIdForSession(sessionId: string, fallbackServerId?: string | null): string | null {
    const sessionServerId = useSessionServerId(sessionId);
    const activeServerSnapshot = useActiveServerSnapshot();

    return React.useMemo(
        () =>
            normalizeServerId(sessionServerId)
            ?? normalizeServerId(fallbackServerId)
            ?? normalizeServerId(activeServerSnapshot.serverId),
        [activeServerSnapshot.serverId, fallbackServerId, sessionServerId],
    );
}
