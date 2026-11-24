import { useLaunchCurtainHold } from '@/boot/launchCurtain';
import { useActiveHomeUnavailable, useReportedHomeServerId } from '@/components/navigation/connectionStatus/HomeReachabilityGate';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';

export function useSessionRouteLaunchCurtainHold(initialLoading: boolean, serverId: string | null): void {
    const activeHomeUnavailable = useActiveHomeUnavailable();
    const reportedHomeServerId = useReportedHomeServerId();
    // Only the applied Home has a connection summary. Its outage cannot speak for another route's Home.
    const routeHomeUnavailable = activeHomeUnavailable
        && (serverId === null || areServerProfileIdentifiersEquivalent(serverId, reportedHomeServerId));
    useLaunchCurtainHold(initialLoading && !routeHomeUnavailable);
}
