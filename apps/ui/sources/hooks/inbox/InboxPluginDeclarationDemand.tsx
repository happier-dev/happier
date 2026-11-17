import * as React from 'react';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { useMachinePresenceMembership } from '@/sync/domains/machines/reachability/useMachinePresenceSummary';
import { usePluginUiProjectionCurrentness } from '@/sync/domains/plugins/ui/usePluginUiProjectionCurrentness';
import { useActiveServerAccountScopeLifetime } from '@/sync/store/hooks';

/** A mounted Inbox acquires declarations; AppShell observes and publishes the same admitted cache. */
export function InboxPluginDeclarationDemand() {
    const presented = useLayoutPresentationActive();
    return presented ? <PresentedInboxPluginDeclarations /> : null;
}

function PresentedInboxPluginDeclarations() {
    const lifetime = useActiveServerAccountScopeLifetime();
    const serverId = lifetime?.scope.serverId ?? null;
    const { onlineMachineIds } = useMachinePresenceMembership(serverId, lifetime);
    return lifetime ? <>{onlineMachineIds.map(machineId => <MachineDeclarationDemand
        key={machineId} machineId={machineId} serverId={lifetime.scope.serverId}
    />)}</> : null;
}

function MachineDeclarationDemand(props: Readonly<{ machineId: string; serverId: string }>) {
    // AppShell publishes the complete UI section set; a Resource-only read cannot settle that publication.
    usePluginUiProjectionCurrentness(props);
    return null;
}
