import * as React from 'react';

import { Redirect, useLocalSearchParams } from '@/components/appShell/workspace/destinationRoute';
import { machinePageHref } from '@/components/settings/machines/collection/machineCollectionModel';

import type { MachinePageTabParams } from './machinePageTabQuery';

/**
 * `/machine/<id>[/installables]`: the route 0.2 links (and older notifications) still open. It leads to
 * the same machine in the rail door, keeping its Home, on the tab that now holds the page (Tools: Setup › Tools). Delete when 0.2 links are no longer supported.
 */
export function MachineLegacyRouteRedirect(props: Readonly<{ tab?: MachinePageTabParams }>) {
    const params = useLocalSearchParams<{ id?: string; serverId?: string }>();
    const machineId = typeof params.id === 'string' ? params.id : '';
    if (!machineId) return <Redirect href={'/machines' as never} />;
    const serverId = typeof params.serverId === 'string' && params.serverId.trim() ? params.serverId.trim() : undefined;
    return <Redirect href={machinePageHref({ door: 'rail', target: { machineId, serverId }, tab: props.tab }) as never} />;
}
