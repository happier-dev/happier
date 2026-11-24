import { useLaunchCurtainHold } from '@/boot/launchCurtain';
import { useActiveHomeUnavailable, useReportedHomeServerId } from '@/components/navigation/connectionStatus/HomeReachabilityGate';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { useOptionalScreenIsFocused } from '@/utils/navigation/useOptionalScreenIsFocused';

import { useDestinationInstanceFacts } from './destinationInstanceContext';

/** Holds only while the destination is focused, on its first load, and its Home is not known unavailable. */
export function useRouteLaunchCurtainHold(active: boolean, routeServerId: string | null = null): void {
    const destinationFocused = useDestinationInstanceFacts()?.focused !== false;
    const sceneFocused = useOptionalScreenIsFocused();
    const activeHomeUnavailable = useActiveHomeUnavailable();
    const reportedHomeServerId = useReportedHomeServerId();
    // Only the applied Home's connection summary can explain an outage for this route.
    const routeHomeUnavailable = activeHomeUnavailable
        && (routeServerId === null || areServerProfileIdentifiersEquivalent(routeServerId, reportedHomeServerId));
    useLaunchCurtainHold(active && destinationFocused && sceneFocused && !routeHomeUnavailable);
}
