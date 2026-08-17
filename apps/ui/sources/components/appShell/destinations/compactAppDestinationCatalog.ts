import * as React from 'react';
import type { PluginUiDestinationReferenceV1 } from '@happier-dev/protocol/plugins/ui';

import { useAppShellPluginUiProjection } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import {
    resolvePluginAppPages,
    selectPluginAppPagePlacements,
    type PluginAppPage,
} from '@/components/appShell/plugins/pluginAppPages';
import type { IconName } from '@/components/ui/icons/Icon';
import {
    resolveRightSidebarTabs,
} from '@/components/appShell/rightSidebar/rightSidebarTabRegistry';
import type { RightSidebarPluginTabDefinition } from '@/components/appShell/rightSidebar/rightSidebarBuiltinTabs';
import { selectPluginRightSidebarTabPlacements } from '@/sync/domains/plugins/ui/surfacePlacementSelectors';
import { useLocalSetting } from '@/sync/domains/state/storage';
import { t } from '@/text';

/** The stable host-owned identity for the existing Sessions-list launcher. */
export const BROWSE_EXISTING_SESSIONS_DESTINATION_ID = 'browseExistingSessions';

export type CompactAppDestinationVisibility = 'visible' | 'hidden';
export type CompactAppDestinationPreferencesV1 = Readonly<{
    orderedDestinationIds: readonly string[];
    hiddenDestinationIds: readonly string[];
}>;

export type CompactAppBuiltinDestination = Readonly<{
    kind: 'builtin';
    id: typeof BROWSE_EXISTING_SESSIONS_DESTINATION_ID;
    title: string;
    icon: IconName;
    group: 'sessions';
    order: number;
    /** Hidden destinations remain catalogued for their exact route/tombstone owner. */
    visibility?: CompactAppDestinationVisibility;
    routePath: '/external/browse';
    availability: 'available';
}>;

export type CompactAppPluginDestination = Readonly<{
    kind: 'plugin';
    container: 'appPage' | 'rightSidebarTab';
    /** The existing host-built qualified destination id, never a local slug. */
    id: string;
    destination: PluginUiDestinationReferenceV1;
    title: string;
    icon: IconName;
    group: 'sessions' | 'plugins';
    order: number;
    /** Static, normalized presentation defaults; host/user policy remains final. */
    badge?: PluginAppPage['badge'];
    rankHint?: number;
    visibility?: CompactAppDestinationVisibility;
    /** Built by the app-page route owner; plugins do not provide a route. */
    routePath: string;
    availability: 'available' | 'unavailable';
    unavailableReason?: string;
}>;

export type CompactAppDestination = CompactAppBuiltinDestination | CompactAppPluginDestination;

/** Consumers that are ordinary discovery surfaces honor the catalog's user visibility. */
export function isCompactAppDestinationVisible(destination: CompactAppDestination): boolean {
    return destination.visibility !== 'hidden';
}

type CompactAppDestinationRouteLocation = Readonly<{
    pathname: string;
    params: Readonly<Record<string, string | readonly string[] | undefined>>;
}>;

export function buildAppRightSidebarDestinationRoute(
    destination: PluginUiDestinationReferenceV1,
): string {
    const query = new URLSearchParams({
        pluginId: destination.pluginId,
        destinationId: destination.localId,
    });
    return `/settings/plugins/panels?${query.toString()}`;
}

function readCurrentRouteParam(value: string | readonly string[] | undefined): string | null {
    // Match the panels route owner: malformed repeated values do not select a
    // destination, while a concrete string is normalized before identity
    // comparison. This is presentation only; the route still owns mounting and
    // tombstone behavior.
    return typeof value === 'string' ? value.trim() : null;
}

/**
 * Whether a compact navigation row represents the current host route.
 *
 * This deliberately reads no router state and writes no selection state. It
 * just compares the host-issued route with the route facts supplied by a
 * consumer, so every compact projection can render the same selected state
 * without becoming another route or pane-selection owner.
 */
export function isCompactAppDestinationCurrent(
    destination: CompactAppDestination,
    location: CompactAppDestinationRouteLocation,
): boolean {
    const queryIndex = destination.routePath.indexOf('?');
    const destinationPath = queryIndex < 0
        ? destination.routePath
        : destination.routePath.slice(0, queryIndex);
    const destinationQuery = queryIndex < 0
        ? ''
        : destination.routePath.slice(queryIndex + 1);

    if (location.pathname !== destinationPath) {
        // The generated app-page root stays selected while its plugin-owned
        // sub-route is current. Other compact destinations are exact routes.
        return destination.kind === 'plugin'
            && destination.container === 'appPage'
            && location.pathname.startsWith(`${destinationPath}/`);
    }
    if (destinationQuery.length === 0) {
        return true;
    }

    const expected = new URLSearchParams(destinationQuery);
    let matches = true;
    expected.forEach((value, key) => {
        if (readCurrentRouteParam(location.params[key]) !== value) {
            matches = false;
        }
    });
    return matches;
}

/**
 * The normalized compact App destination catalog.
 *
 * This is the common data owner for compact native App launchers and the web
 * command palette. It deliberately exposes only host-generated routes and
 * exact qualified plugin identities; mounting, history, and unavailable UI
 * remain with their existing route/pane owners.
 */
export function resolveCompactAppDestinations(input: Readonly<{
    browseExistingSessionsEnabled: boolean;
    pages: readonly PluginAppPage[];
    rightSidebarTabs?: readonly RightSidebarPluginTabDefinition[];
    preferences?: CompactAppDestinationPreferencesV1;
}>): readonly CompactAppDestination[] {
    const destinations: CompactAppDestination[] = [];

    if (input.browseExistingSessionsEnabled) {
        destinations.push(Object.freeze({
            kind: 'builtin',
            id: BROWSE_EXISTING_SESSIONS_DESTINATION_ID,
            title: t('externalSessions.browseOpenExisting'),
            icon: 'folder-open',
            group: 'sessions',
            order: 0,
            routePath: '/external/browse',
            availability: 'available',
        }));
    }

    for (const page of input.pages) {
        const unavailableReason = page.disabledReason;
        destinations.push(Object.freeze({
            kind: 'plugin',
            container: 'appPage',
            id: page.id,
            destination: Object.freeze({
                pluginId: page.pluginId,
                localId: page.localId,
            }),
            title: page.label,
            icon: page.icon,
            group: page.groupHint === 'sessions' ? 'sessions' : 'plugins',
            order: page.order,
            ...(page.badge === undefined ? {} : { badge: page.badge }),
            ...(page.rankHint === undefined ? {} : { rankHint: page.rankHint }),
            routePath: page.routePath,
            availability: unavailableReason === null ? 'available' : 'unavailable',
            ...(unavailableReason === null ? {} : { unavailableReason }),
        }));
    }

    for (const tab of input.rightSidebarTabs ?? []) {
        const destination = Object.freeze({
            pluginId: tab.placement.binding.destination.pluginId,
            localId: tab.placement.binding.destination.localId,
        });
        const unavailableReason = tab.disabledReason;
        destinations.push(Object.freeze({
            kind: 'plugin',
            container: 'rightSidebarTab',
            id: `rightSidebarTab:${tab.id}`,
            destination,
            title: tab.label,
            icon: tab.icon,
            group: tab.groupHint === 'sessions' ? 'sessions' : 'plugins',
            order: tab.order,
            ...(tab.badge === undefined ? {} : { badge: tab.badge }),
            ...(tab.rankHint === undefined ? {} : { rankHint: tab.rankHint }),
            routePath: buildAppRightSidebarDestinationRoute(destination),
            availability: unavailableReason === undefined ? 'available' : 'unavailable',
            ...(unavailableReason === undefined ? {} : { unavailableReason }),
        }));
    }

    const compareHostDefaults = (left: CompactAppDestination, right: CompactAppDestination): number => {
        // Browse Existing Sessions is a host-owned anchor. A plugin rank can
        // influence only its peer group; it cannot force itself ahead of this
        // existing host destination.
        if (left.kind === 'builtin' || right.kind === 'builtin') {
            if (left.kind === right.kind) return left.id.localeCompare(right.id);
            return left.kind === 'builtin' ? -1 : 1;
        }
        const groupRank = (destination: CompactAppPluginDestination) => (
            destination.group === 'sessions' ? 0 : 1
        );
        const byGroup = groupRank(left) - groupRank(right);
        if (byGroup !== 0) return byGroup;
        const byRankHint = (left.rankHint ?? 0) - (right.rankHint ?? 0);
        return byRankHint || left.order - right.order || left.id.localeCompare(right.id);
    };

    const hostOrdered = destinations.slice().sort(compareHostDefaults);
    const knownIds = new Set(hostOrdered.map((destination) => destination.id));
    const userOrder = new Map<string, number>();
    for (const id of input.preferences?.orderedDestinationIds ?? []) {
        if (knownIds.has(id) && !userOrder.has(id)) {
            userOrder.set(id, userOrder.size);
        }
    }
    const userOrdered = hostOrdered.slice().sort((left, right) => {
        const leftOrder = userOrder.get(left.id);
        const rightOrder = userOrder.get(right.id);
        if (leftOrder === undefined && rightOrder === undefined) return 0;
        if (leftOrder === undefined) return 1;
        if (rightOrder === undefined) return -1;
        return leftOrder - rightOrder;
    });
    const hiddenIds = new Set(input.preferences?.hiddenDestinationIds ?? []);

    return Object.freeze(userOrdered.map((destination, order) => Object.freeze({
        ...destination,
        order,
        visibility: hiddenIds.has(destination.id) ? 'hidden' : 'visible',
    })));
}

/**
 * App-shell adapter for the compact catalog. Discovery requires a current
 * admitted projection, not daemon interaction: pages can be host-local or
 * Account-artifact-backed and must remain navigable/offline-tombstonable while
 * executable bridge methods are separately unavailable.
 */
export function useCompactAppDestinations(input: Readonly<{
    browseExistingSessionsEnabled: boolean;
}>): readonly CompactAppDestination[] {
    const projection = useAppShellPluginUiProjection();
    const preferences = useLocalSetting('compactAppDestinationPreferencesV1');
    const pages = React.useMemo(() => (
        projection.pluginUiProjection
            ? resolvePluginAppPages({
                placements: selectPluginAppPagePlacements(projection.pluginUiProjection),
            })
            : []
    ), [projection.pluginUiProjection]);
    const rightSidebarTabs = React.useMemo(() => (
        projection.pluginUiProjection
            ? resolveRightSidebarTabs({
                scope: 'app',
                pluginPlacements: selectPluginRightSidebarTabPlacements(
                    projection.pluginUiProjection,
                    'app',
                ),
                projectionGeneration: projection.pluginUiProjection.generation,
            }).filter((tab): tab is RightSidebarPluginTabDefinition => tab.owner === 'plugin')
            : []
    ), [projection.pluginUiProjection]);
    return React.useMemo(() => resolveCompactAppDestinations({
        browseExistingSessionsEnabled: input.browseExistingSessionsEnabled,
        pages,
        rightSidebarTabs,
        preferences,
    }), [input.browseExistingSessionsEnabled, pages, preferences, rightSidebarTabs]);
}
