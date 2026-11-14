import * as React from 'react';
import { ManagedInventorySections } from '@/components/store/inventory/ManagedInventorySections';
import { useManagedInventory, type ManagedInventoryQuery } from '@/components/store/inventory/useManagedInventory';
import { InboxArtifactSourceBoundary } from '@/hooks/inbox/useInboxArtifactSource';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';

type Props = Omit<Parameters<typeof ManagedInventorySections>[0], 'inventory' | 'input' | 'query'> & Readonly<{
    /** One Machine's own inventory (its Overview), or the Account's (Services → Checks · Watched, no Machine). */
    query: ManagedInventoryQuery;
}>;

/** A managed inventory section for one door: the Overview's routed Machine, or the Account's (Services). No Settings administration preference is read or written. */
export function MachineManagedInventorySection(props: Props): React.ReactNode {
    return <PluginSurfaceFocusEligibilityProvider active={props.query.presented}>
        <InboxArtifactSourceBoundary><MachineInventoryBody {...props} /></InboxArtifactSourceBoundary>
    </PluginSurfaceFocusEligibilityProvider>;
}

function MachineInventoryBody(props: Props): React.ReactNode {
    const { query, ...sections } = props;
    const inventory = useManagedInventory(query);
    const input = React.useMemo(() => ({ scope: query.scope, machine: query.machine, projectKey: query.projectKey }),
        [query.scope, query.machine, query.projectKey]);
    return <ManagedInventorySections {...sections} inventory={inventory} input={input} />;
}
