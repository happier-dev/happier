import * as React from 'react';

import { getActiveServerSnapshot, subscribeActiveServer } from '@/sync/domains/server/serverRuntime';
import { useSessionServerId } from '@/sync/store/hooks';
import { normalizeServerId } from './normalizeServerId';

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
