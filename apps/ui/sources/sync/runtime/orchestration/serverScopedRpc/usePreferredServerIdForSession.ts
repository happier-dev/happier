import * as React from 'react';

import { getActiveServerSnapshot, subscribeActiveServer } from '@/sync/domains/server/serverRuntime';
import { useSessionServerId } from '@/sync/store/hooks';

function normalizeServerId(value: unknown): string | null {
    const serverId = String(value ?? '').trim();
    return serverId || null;
}

export function usePreferredServerIdForSession(sessionId: string): string | null {
    const sessionServerId = useSessionServerId(sessionId);
    const [activeServerSnapshot, setActiveServerSnapshot] = React.useState(() => getActiveServerSnapshot());

    React.useEffect(() => {
        return subscribeActiveServer(setActiveServerSnapshot);
    }, []);

    return React.useMemo(
        () => normalizeServerId(sessionServerId) ?? normalizeServerId(activeServerSnapshot.serverId),
        [activeServerSnapshot.serverId, sessionServerId],
    );
}
