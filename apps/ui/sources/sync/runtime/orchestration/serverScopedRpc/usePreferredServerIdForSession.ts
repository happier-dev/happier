import * as React from 'react';

import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { useSessionServerId } from '@/sync/store/hooks';
import { normalizeServerId } from './normalizeServerId';

export function usePreferredServerIdForSession(
    sessionId: string,
    fallbackServerId?: string | null,
    enabled = true,
): string | null {
    const sessionServerId = useSessionServerId(sessionId, enabled);
    const activeServerSnapshot = useActiveServerSnapshot(enabled);

    return React.useMemo(
        () => enabled
            ? normalizeServerId(sessionServerId)
                ?? normalizeServerId(fallbackServerId)
                ?? normalizeServerId(activeServerSnapshot.serverId)
            : null,
        [activeServerSnapshot.serverId, enabled, fallbackServerId, sessionServerId],
    );
}
