import * as React from 'react';
import { useDestinationPathname } from '@/components/appShell/workspace/DestinationInstanceHost';
import { useWorkspaceSectionPathname } from '@/components/appShell/workspace/WorkspaceNavigationContext';

import {
    useCompactAppDestinations,
    type CompactAppDestination,
} from '@/components/appShell/destinations/compactAppDestinationCatalog';

import { resolveAppShellLocation, type AppShellLocation } from './appRailModel';

/** The catalog and where the route stands in it, for the shell chrome that shows both. */
export function useAppShellLocation(): Readonly<{
    catalog: readonly CompactAppDestination[];
    location: AppShellLocation;
}> {
    const catalog = useCompactAppDestinations();
    const destinationPathname = useDestinationPathname();
    const sectionPathname = useWorkspaceSectionPathname();
    const pathname = sectionPathname ?? destinationPathname;
    const location = React.useMemo(() => resolveAppShellLocation(catalog, pathname), [catalog, pathname]);
    return { catalog, location };
}
