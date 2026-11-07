import * as React from 'react';
import { useManagedInventory, type ManagedInventoryQuery } from './useManagedInventory';
import { FilteredManagedInventorySections } from './ManagedInventorySections';
import { InboxArtifactSourceBoundary } from '@/hooks/inbox/useInboxArtifactSource';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';

type Props = Omit<Parameters<typeof FilteredManagedInventorySections>[0], 'inventory' | 'input' | 'presented'>
    & Readonly<{ query: ManagedInventoryQuery }>;

/** Installed's data/control binding. The route owner retains the draft and S50-UI composes the page. */
export function InstalledScreen(props: Props): React.ReactNode {
    return <PluginSurfaceFocusEligibilityProvider active={props.query.presented}>
        <InboxArtifactSourceBoundary><InstalledBody {...props} /></InboxArtifactSourceBoundary>
    </PluginSurfaceFocusEligibilityProvider>;
}

function InstalledBody(props: Props): React.ReactNode {
    const { query, ...sections } = props;
    const inventory = useManagedInventory(query);
    const input = React.useMemo(() => ({ scope: query.scope, machine: query.machine, projectKey: query.projectKey }),
        [query.scope, query.machine, query.projectKey]);
    return <FilteredManagedInventorySections {...sections} inventory={inventory} input={input} presented={query.presented} />;
}
