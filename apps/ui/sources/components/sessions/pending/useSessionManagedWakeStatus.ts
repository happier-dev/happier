import * as React from 'react';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { readManagedWakeAuthorization } from '@/sync/domains/pending/managedWakeProjection';
import { useActiveServerAccountScopeLifetime, useSessionPendingMessages } from '@/sync/store/hooks';
import { useMachinePresenceSummaries } from '@/sync/domains/machines/reachability/useMachinePresenceSummary';
import { sync } from '@/sync/sync';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { useSessionManagedWakePresentation } from './useSessionManagedWakePresentation';

/** Mounted row demand stays local; pending custody currently belongs to the active Home. */
export function useSessionManagedWakeStatus(session: SessionListRenderableSession | null, serverId: string | null | undefined) {
    const lifetime = useActiveServerAccountScopeLifetime();
    const authorization = session ? readManagedWakeAuthorization(session) : null;
    const demanded = authorization && lifetime && areServerProfileIdentifiersEquivalent(lifetime.scope.serverId, serverId)
        ? session : null;
    const sessionId = demanded?.id ?? '';
    const pending = useSessionPendingMessages(sessionId);
    React.useEffect(() => {
        if (sessionId && !pending.isLoaded) fireAndForget(sync.fetchPendingMessages(sessionId), { tag: 'useSessionManagedWakeStatus.fetchPendingMessages' });
    }, [pending.isLoaded, sessionId]);
    const machineId = demanded ? authorization?.managedWakeTargetV1?.enrolledMachineId : null;
    const presence = useMachinePresenceSummaries(serverId, machineId ? [machineId] : [], lifetime);
    const reachability = presence[0]?.reachability;
    const wake = useSessionManagedWakePresentation({ session: demanded, accountLifetime: demanded ? lifetime : null,
        machineReachable: reachability === 'reachable' ? true : reachability === 'unreachable' ? false : null,
        pendingMessages: pending.messages, pendingLoaded: pending.isLoaded, pendingReadState: pending.readState });
    return wake.projection;
}
