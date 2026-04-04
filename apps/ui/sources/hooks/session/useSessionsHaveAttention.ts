import * as React from 'react';
import { useAllSessions } from '@/sync/domains/state/storage';
import { hasSessionAttention } from '@/sync/domains/session/attention/sessionAttention';

export function useSessionsHaveAttention(): boolean {
    const sessions = useAllSessions();

    return React.useMemo(() => {
        return sessions.some((session) => hasSessionAttention(session));
    }, [sessions]);
}
