import * as React from 'react';
import { useSessionAwareness } from '@/sync/domains/session/awareness/useSessionAwareness';
import { normalizeSessionAddress } from '@/sync/domains/session/sessionAddress';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import type { Session } from '@/sync/domains/state/storageTypes';

/** Incumbent Summary exact-Home live facts, kept below the memoized Session shell. */
export function useSessionSummaryAwareness(input: Readonly<{ session: Session; serverId?: string | null }>) {
    const { session } = input;
    const address = React.useMemo(() => {
        const candidate = normalizeSessionAddress(input.serverId ?? session.serverId, session.id);
        return candidate && (!session.serverId
            || areServerProfileIdentifiersEquivalent(candidate.serverId, session.serverId)) ? candidate : null;
    }, [input.serverId, session.id, session.serverId]);
    // The shell deliberately omits heartbeat/turn freshness from its render
    // signature. Subscribe below it, never project status from that frozen row.
    const binding = useSessionAwareness(address?.sessionId ?? '', address?.serverId ?? null, session);
    return { address, awarenessSource: binding.session, awareness: binding.awareness, turnStartedAtMs: binding.turnStartedAtMs };
}
