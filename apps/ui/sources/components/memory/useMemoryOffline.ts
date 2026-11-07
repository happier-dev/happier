import { useEndpointConnectivity } from '@/sync/domains/state/storage';
import { useReportedHomeServerId } from '@/components/navigation/connectionStatus/HomeReachabilityGate';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';

/**
 * The Home connection is down: retained memory stays readable, but nothing can be saved or searched.
 * The page says so once, instead of each degraded part (counts, search) blaming a Machine for it.
 */
export function useMemoryOffline(serverId: string): Readonly<{ offline: boolean; since: number | null }> {
    const connectivity = useEndpointConnectivity();
    const reportedServerId = useReportedHomeServerId();
    return { offline: connectivity.status === 'offline' && reportedServerId !== null
        && areServerProfileIdentifiersEquivalent(serverId, reportedServerId), since: connectivity.lastDisconnectedAt };
}
