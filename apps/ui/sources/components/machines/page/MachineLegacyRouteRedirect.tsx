import * as React from 'react';

import { Redirect, useLocalSearchParams } from '@/components/appShell/workspace/destinationRoute';
import { machinePageHref } from '@/components/settings/machines/collection/machineCollectionModel';

import type { MachinePageTabParams } from './machinePageTabQuery';

/**
 * Where a 0.2 `/machine/<id>[/installables]` link leads: the same machine in the rail door, keeping its Home and the
 * tab the link names (`?tab=security&page=network`), or the tab that now holds a moved page (Tools: Setup › Tools).
 */
export function machineLegacyRouteHref(params: Readonly<Record<string, string | string[] | undefined>>, tab?: MachinePageTabParams): string {
    const machineId = typeof params.id === 'string' ? params.id : '';
    if (!machineId) return '/machines';
    const serverId = typeof params.serverId === 'string' && params.serverId.trim() ? params.serverId.trim() : undefined;
    const href = machinePageHref({ door: 'rail', target: { machineId, serverId }, tab });
    if (tab) return href;
    // The page reads its own tab params tolerantly, so the link's query is carried as it is.
    const rest = Object.entries(params).filter((entry): entry is [string, string] =>
        entry[0] !== 'id' && entry[0] !== 'serverId' && typeof entry[1] === 'string');
    if (rest.length === 0) return href;
    const query = rest.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&');
    return `${href}${href.includes('?') ? '&' : '?'}${query}`;
}

/** The 0.2 route (and older notifications) still open it. Delete when 0.2 links are no longer supported. */
export function MachineLegacyRouteRedirect(props: Readonly<{ tab?: MachinePageTabParams }>) {
    const params = useLocalSearchParams<Record<string, string | string[] | undefined>>();
    return <Redirect href={machineLegacyRouteHref(params, props.tab) as never} />;
}
