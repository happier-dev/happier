import * as React from 'react';

import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { useSessionServerId } from '@/sync/store/hooks';

function normalizeServerId(value: unknown): string | null {
    const serverId = String(value ?? '').trim();
    return serverId || null;
}

export function usePreferredServerIdForSession(sessionId: string): string | null {
    const sessionServerId = useSessionServerId(sessionId);
    const activeServerSnapshot = useActiveServerSnapshot();

    return React.useMemo(
        () => normalizeServerId(sessionServerId) ?? normalizeServerId(activeServerSnapshot.serverId),
        [activeServerSnapshot.serverId, sessionServerId],
    );
}
