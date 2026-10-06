import * as React from 'react';
import { stripGroupSegmentsFromPath } from 'expo-router/build/matchers';
import { parseQueryParams } from 'expo-router/build/fork/getStateFromPath-forks';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import type {
    PluginUiDestinationPlacementV1,
    PluginUiDestinationReferenceV1,
} from '@happier-dev/protocol/plugins/ui';

import {
    useAppShellPluginUiProjection,
    useProjectedPluginLocalizedTextResolver,
} from '@/components/appShell/plugins/AppShellPluginUiProjection';
import {
    resolvePluginAppPages,
    selectPluginAppPagePlacements,
    type PluginAppPage,
} from '@/components/appShell/plugins/pluginAppPages';
import { usePluginAppPageCatalogActivationHandler } from '@/components/appShell/plugins/pluginAppPageNavigation';
import {
    useOptionalUniversalSearchRuntime,
    type UniversalSearchScopeSeed,
} from '@/components/appShell/search/UniversalSearchRuntimeContext';
import type { IconName } from '@/components/ui/icons/Icon';
import {
    resolveRightSidebarTabs,
} from '@/components/appShell/rightSidebar/rightSidebarTabRegistry';
import type { RightSidebarPluginTabDefinition } from '@/components/appShell/rightSidebar/rightSidebarBuiltinTabs';
import { useWorkflowsDestinationAccess } from '@/components/workflows/gating/workflowsDestinationAccess';
import { useInboxAvailable } from '@/hooks/inbox/useInboxAvailable';
import { useFeatureDecision } from '@/hooks/server/useFeatureDecision';
import { useFriendsEnabled } from '@/hooks/server/useFriendsEnabled';
import type { KeyboardCommandId } from '@/keyboard/types';
import { selectPluginRightSidebarTabPlacements } from '@/sync/domains/plugins/ui/surfacePlacementSelectors';
import { useSessionDisplayNameProjections } from '@/sync/domains/state/storage';
import { t, type TranslationKeyNoParams } from '@/text';
import { UNIVERSAL_SEARCH_ROUTE } from '@/components/appShell/search/universalSearchRoutePresentation';
import {
    buildPluginPanelsRoute,
    PLUGINS_APP_PAGE_PATTERNS,
    PLUGINS_APP_ROUTE,
    PLUGINS_SURFACE_ICON,
} from '@/components/settings/plugins/model/pluginsSurfaceRoutes';
import { useOpenAppRightSidebarTab } from '@/components/appShell/rightSidebar/appScopeRightSidebarNavigation';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { createSessionPaneDetailsTab, parseSessionPaneUrlState, serializeSessionPaneUrlState } from '@/components/sessions/panes/url/sessionPaneUrlState';
import { resolveSettingsRouteTitleKey } from '@/components/settings/navigation/settingsRouteRegistry';
import { readSessionDisplayTitle, sessionDisplayTitle } from '@/utils/sessions/sessionDisplayTitle';
import { useSessionDiscussionTitleProjections } from '@/sync/ops/sessionDiscussions/useSessionDiscussionRepositorySnapshot';
import { matchWorkspaceDestinationRoute, registeredWorkspaceRoutes } from '@/components/appShell/workspace/workspaceRoutes';

/**
 * The one catalog of shell destinations (user ruling U1, 2026-09-28): the app's own destinations and
 * every plugin page or App panel, each with one placement — a rail region, or the column of another
 * destination. The rail, every column's destination rows, the phone launcher and the command
 * palette are projections of it; which destination is open (and so which rail entry, which column
 * and which peek) is decided once, by {@link resolveCurrentAppDestination}. Mounting, launch input,
 * history and unavailable tombstones stay with the route and page owners.
 */

/** The stable host-owned identity for the existing Sessions-list launcher. */
export const BROWSE_EXISTING_SESSIONS_DESTINATION_ID = 'browseExistingSessions';
/** The stable host-owned identity for Universal Search. */
export const SEARCH_DESTINATION_ID = 'search';
/** The stable host-owned identity for the Plugins page (installed plugins and the marketplace). */
export const PLUGINS_DESTINATION_ID = 'plugins';
/** The destination every route without a more specific one belongs to. */
export const SESSIONS_DESTINATION_ID = 'sessions';

/**
 * The columns this host can stand beside a page. `AppShellColumn` renders each through one table
 * typed against this list, so a column id without a renderer is a type error. A placement naming any
 * other column falls back to the rail.
 */
export const BUILTIN_APP_SHELL_COLUMN_IDS = ['sessions', 'projects', 'workflows', 'boards', 'plugins', 'settings'] as const;
export type BuiltinAppShellColumnId = typeof BUILTIN_APP_SHELL_COLUMN_IDS[number];

export function isBuiltinAppShellColumnId(value: string): value is BuiltinAppShellColumnId {
    return (BUILTIN_APP_SHELL_COLUMN_IDS as readonly string[]).includes(value);
}

/**
 * The columns another destination may be placed in. Settings is not one: settings contributions are
 * settings pages, with the Settings catalog as their one owner. Workflows is not one either: its
 * column lists workflow sections from their own owners (FIN 04 §3.3), not other destinations. Nor is
 * Boards: its column lists the user's boards (INT §5.1).
 */
export type PlaceableAppShellColumnId = Exclude<BuiltinAppShellColumnId, 'settings' | 'workflows' | 'boards'>;

function isPlaceableAppShellColumnId(value: string): value is PlaceableAppShellColumnId {
    return isBuiltinAppShellColumnId(value) && value !== 'settings' && value !== 'workflows' && value !== 'boards';
}

export type AppDestinationRailRegion = 'app' | 'plugins' | 'account';

/** Where a destination is listed, after resolving its request against this host's columns. */
export type AppDestinationPlacement =
    | Readonly<{ kind: 'rail'; region: AppDestinationRailRegion }>
    | Readonly<{ kind: 'column'; column: PlaceableAppShellColumnId }>;

/** What activating a destination does. The one activation owner is {@link useActivateAppDestination}. */
export type AppDestinationActivation = 'navigate' | 'overlay' | 'rightSidebarTab';

export type CompactAppDestinationVisibility = 'visible' | 'hidden';

type CompactAppDestinationCommon = Readonly<{
    title: string;
    icon: IconName;
    order: number;
    placement: AppDestinationPlacement;
    activation: AppDestinationActivation;
    /** Hidden destinations remain catalogued for their exact route/tombstone owner. */
    visibility?: CompactAppDestinationVisibility;
    /** The host-built route of the destination's own page. */
    routePath: string;
}>;

export type CompactAppBuiltinDestination = CompactAppDestinationCommon & Readonly<{
    kind: 'builtin';
    id: string;
    /** The column this destination stands beside its page, when it has one. */
    column?: BuiltinAppShellColumnId;
    /**
     * Further route patterns of this destination's own pages. A `[param]` segment matches exactly one
     * segment, a trailing `[...rest]` one or more; everything else matches exactly.
     */
    currentRoutePatterns?: readonly string[];
    /** The keyboard command that also opens it, shown beside its title. */
    shortcut?: KeyboardCommandId;
    /** A live count the rail marks on its icon, read only by that badge's own leaf. */
    signal?: 'inboxCount';
    /** Offered by the command palette before anything is typed. */
    suggested?: true;
    availability: 'available';
}>;

export type CompactAppPluginDestination = CompactAppDestinationCommon & Readonly<{
    kind: 'plugin';
    container: 'appPage' | 'rightSidebarTab';
    /** The existing host-built qualified destination id, never a local slug. */
    id: string;
    destination: PluginUiDestinationReferenceV1;
    /** Static, normalized presentation defaults; host/user policy remains final. */
    badge?: PluginAppPage['badge'];
    rankHint?: number;
    /** The page stands its own (plugin-rendered) column beside it. */
    ownColumn?: true;
    availability: 'available' | 'unavailable';
    unavailableReason?: string;
}>;

export type CompactAppDestination = CompactAppBuiltinDestination | CompactAppPluginDestination;

/** The address of one page instance. Tab identity is separate: two tabs may hold the same ref. */
export type DestinationRef = Readonly<{
    kind: string;
    params: Readonly<Record<string, string>>;
}>;

/** Which optional built-ins this viewer can open; each comes from its own availability owner. */
export type AppBuiltinDestinationAvailability = Readonly<{
    externalSessions: boolean;
    inbox: boolean;
    /** The Workflows destination is discoverable (`useWorkflowsDestinationAccess`). */
    workflows: boolean;
    friends: boolean;
}>;

/** A placement as requested: by an author, or by a built-in row. */
type RequestedAppDestinationPlacement =
    | Readonly<{ kind: 'rail'; region: AppDestinationRailRegion }>
    | Readonly<{ kind: 'column'; column: string }>;

type BuiltinDestinationRow = Readonly<{
    id: string;
    titleKey: TranslationKeyNoParams;
    icon: IconName;
    placement: RequestedAppDestinationPlacement;
    column?: BuiltinAppShellColumnId;
    activation: 'navigate' | 'overlay';
    routePath: string;
    currentRoutePatterns?: readonly string[];
    shortcut?: KeyboardCommandId;
    signal?: 'inboxCount';
    suggested?: true;
    available?: (availability: AppBuiltinDestinationAvailability) => boolean;
    visibility?: CompactAppDestinationVisibility;
}>;

/**
 * The host's own destinations, in their default order within each placement group. Workflows is the
 * one destination for workflows and their triggers; the retired Automations routes redirect into it.
 */
const BUILTIN_DESTINATION_ROWS: readonly BuiltinDestinationRow[] = [
    {
        id: SESSIONS_DESTINATION_ID, titleKey: 'tabs.sessions', icon: 'chats-circle',
        placement: { kind: 'rail', region: 'app' }, column: 'sessions', activation: 'navigate', routePath: '/',
        currentRoutePatterns: ['/session/[...rest]'], suggested: true,
    },
    {
        id: SEARCH_DESTINATION_ID, titleKey: 'tools.names.search', icon: 'magnifying-glass',
        placement: { kind: 'rail', region: 'app' }, activation: 'overlay', routePath: UNIVERSAL_SEARCH_ROUTE,
    },
    {
        id: 'inbox', titleKey: 'tabs.inbox', icon: 'tray', placement: { kind: 'rail', region: 'app' },
        activation: 'navigate', routePath: '/inbox', currentRoutePatterns: ['/inbox/[...rest]'], signal: 'inboxCount',
        available: (availability) => availability.inbox,
    },
    {
        id: 'projects', titleKey: 'tabs.projects', icon: 'folder', placement: { kind: 'rail', region: 'app' },
        column: 'projects', activation: 'navigate', routePath: '/projects', currentRoutePatterns: ['/projects/[...rest]'],
    },
    {
        id: 'workflows', titleKey: 'workflows.title', icon: 'tree-structure',
        placement: { kind: 'rail', region: 'app' }, column: 'workflows',
        activation: 'navigate', routePath: '/workflows',
        // The Automation pages that still exist (a legacy trigger's page, its runs, the create and
        // edit forms) open inside Workflows until the trigger popover and the run route target
        // replace them and their routes become redirect-only (FIN 04 §3.2).
        currentRoutePatterns: ['/workflows/[...rest]', '/automations', '/automations/[...rest]'],
        available: (availability) => availability.workflows,
    },
    {
        // Live sessions, runs, workflows and machines, arranged by the user (INT §5.1).
        id: 'boards', titleKey: 'boards.title', icon: 'squares-four',
        placement: { kind: 'rail', region: 'app' }, column: 'boards',
        activation: 'navigate', routePath: '/boards', currentRoutePatterns: ['/boards/[...rest]'],
    },
    {
        // Everything saved to the Account Artifact store, as one browser page (RU2 §9.6).
        id: 'artifacts', titleKey: 'artifacts.title', icon: 'files',
        placement: { kind: 'rail', region: 'app' },
        activation: 'navigate', routePath: '/artifacts', currentRoutePatterns: ['/artifacts/[...rest]'],
    },
    {
        id: 'friends', titleKey: 'tabs.friends', icon: 'users', placement: { kind: 'rail', region: 'app' },
        activation: 'navigate', routePath: '/friends', currentRoutePatterns: ['/friends/[...rest]'],
        available: (availability) => availability.friends,
    },
    {
        id: BROWSE_EXISTING_SESSIONS_DESTINATION_ID, titleKey: 'externalSessions.browseOpenExisting', icon: 'folder-open',
        placement: { kind: 'column', column: 'sessions' }, activation: 'navigate', routePath: '/external/browse',
        available: (availability) => availability.externalSessions,
    },
    {
        // Heads the plugins region: where plugins are installed and found. Plugin-contributed pages
        // under `/plugins/<pluginId>/…` are their own destinations.
        id: PLUGINS_DESTINATION_ID, titleKey: 'settingsPlugins.surfaces.navigationTitle', icon: PLUGINS_SURFACE_ICON,
        placement: { kind: 'rail', region: 'plugins' }, column: 'plugins', activation: 'navigate',
        routePath: PLUGINS_APP_ROUTE, currentRoutePatterns: PLUGINS_APP_PAGE_PATTERNS,
    },
    {
        id: 'settings', titleKey: 'settings.title', icon: 'gear', placement: { kind: 'rail', region: 'account' },
        column: 'settings', activation: 'navigate', routePath: '/settings',
        currentRoutePatterns: ['/settings/[...rest]'], shortcut: 'settings.open', suggested: true,
    },
    ...Object.entries(registeredWorkspaceRoutes).flatMap(([routeKey, registration]) => (
        registration.catalogEntry ? [{
            id: registration.destinationId, ...registration.catalogEntry,
            placement: { kind: 'rail', region: 'account' }, activation: 'navigate', routePath: `/${routeKey}`,
        } satisfies BuiltinDestinationRow] : []
    )),
];

/** Ordinary discovery honors contribution visibility; surface preferences remain surface-local. */
export function isCompactAppDestinationVisible(destination: CompactAppDestination): boolean {
    return destination.visibility !== 'hidden';
}

/** A requested placement against this host: a column it does not have falls back to the rail. */
function resolvePlacement(
    requested: RequestedAppDestinationPlacement,
    fallbackRegion: AppDestinationRailRegion,
): AppDestinationPlacement {
    if (requested.kind === 'rail') return requested;
    return isPlaceableAppShellColumnId(requested.column)
        ? Object.freeze({ kind: 'column', column: requested.column })
        : Object.freeze({ kind: 'rail', region: fallbackRegion });
}

/** A plugin asks for the rail or a column; the rail is its own region and the default. */
function resolvePluginPlacement(requested: PluginUiDestinationPlacementV1 | undefined): AppDestinationPlacement {
    return resolvePlacement(
        requested?.kind === 'column' ? requested : { kind: 'rail', region: 'plugins' },
        'plugins',
    );
}

/** The qualified renderer a destination placement binds, when the Registry projected one. */
function readDestinationRendererKey(
    placement: Readonly<{ binding?: Readonly<{ renderer?: Readonly<{ pluginId?: unknown; localId?: unknown }> }> }> | undefined,
): string | null {
    const renderer = placement?.binding?.renderer;
    if (typeof renderer?.pluginId !== 'string' || typeof renderer.localId !== 'string') return null;
    return `${renderer.pluginId}\u0000${renderer.localId}`;
}

/** Placement groups in list order: the app's rail region, each column, then plugins, then the account. */
function placementGroupRank(placement: AppDestinationPlacement): number {
    if (placement.kind === 'column') return 1 + BUILTIN_APP_SHELL_COLUMN_IDS.indexOf(placement.column) / 10;
    return placement.region === 'app' ? 0 : placement.region === 'plugins' ? 2 : 3;
}

function placementGroupKey(placement: AppDestinationPlacement): string {
    return placement.kind === 'column' ? `column:${placement.column}` : `rail:${placement.region}`;
}

/**
 * The normalized catalog. Built-ins the viewer cannot open are omitted; an unavailable plugin page is
 * listed and disabled, so its route can still show why.
 */
export function resolveCompactAppDestinations(input: Readonly<{
    builtins: AppBuiltinDestinationAvailability;
    pages: readonly PluginAppPage[];
    rightSidebarTabs?: readonly RightSidebarPluginTabDefinition[];
}>): readonly CompactAppDestination[] {
    const destinations: CompactAppDestination[] = [];

    BUILTIN_DESTINATION_ROWS.forEach((row, order) => {
        if (row.available && !row.available(input.builtins)) return;
        destinations.push(Object.freeze({
            kind: 'builtin',
            id: row.id,
            title: t(row.titleKey),
            icon: row.icon,
            order,
            placement: resolvePlacement(row.placement, 'app'),
            activation: row.activation,
            routePath: row.routePath,
            ...(row.column === undefined ? {} : { column: row.column }),
            ...(row.currentRoutePatterns === undefined ? {} : { currentRoutePatterns: row.currentRoutePatterns }),
            ...(row.shortcut === undefined ? {} : { shortcut: row.shortcut }),
            ...(row.signal === undefined ? {} : { signal: row.signal }),
            ...(row.suggested === undefined ? {} : { suggested: row.suggested }),
            ...(row.visibility === undefined ? {} : { visibility: row.visibility }),
            availability: 'available',
        }));
    });

    for (const page of input.pages) {
        const unavailableReason = page.disabledReason;
        destinations.push(Object.freeze({
            kind: 'plugin',
            container: 'appPage',
            id: page.id,
            destination: Object.freeze({ pluginId: page.pluginId, localId: page.localId }),
            title: page.label,
            icon: page.icon,
            order: page.order,
            placement: resolvePluginPlacement(page.requestedPlacement),
            activation: 'navigate',
            ...(page.badge === undefined ? {} : { badge: page.badge }),
            ...(page.rankHint === undefined ? {} : { rankHint: page.rankHint }),
            ...(page.columnPlacement ? { ownColumn: true as const } : {}),
            routePath: page.routePath,
            availability: unavailableReason === null ? 'available' : 'unavailable',
            ...(unavailableReason === null ? {} : { unavailableReason }),
        }));
    }

    // One surface is listed once. A plugin may bind the same renderer to an App page and to an App
    // right-sidebar tab ("one surface, two destinations"); the page is the full destination and wins.
    const pageRendererKeys = new Set(input.pages.flatMap((page) => {
        const key = readDestinationRendererKey(page.placement);
        return key === null ? [] : [key];
    }));

    for (const tab of input.rightSidebarTabs ?? []) {
        const rendererKey = readDestinationRendererKey(tab.placement);
        if (rendererKey !== null && pageRendererKeys.has(rendererKey)) continue;
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
            order: tab.order,
            placement: resolvePluginPlacement(tab.requestedPlacement),
            activation: 'rightSidebarTab',
            ...(tab.badge === undefined ? {} : { badge: tab.badge }),
            ...(tab.rankHint === undefined ? {} : { rankHint: tab.rankHint }),
            routePath: buildPluginPanelsRoute(destination),
            availability: unavailableReason === undefined ? 'available' : 'unavailable',
            ...(unavailableReason === undefined ? {} : { unavailableReason }),
        }));
    }

    const compare = (left: CompactAppDestination, right: CompactAppDestination): number => {
        const byGroup = placementGroupRank(left.placement) - placementGroupRank(right.placement);
        if (byGroup !== 0) return byGroup;
        // Host-owned destinations anchor their group. A plugin rank orders only its peers.
        if (left.kind !== right.kind) return left.kind === 'builtin' ? -1 : 1;
        if (left.kind === 'builtin' || right.kind === 'builtin') return left.order - right.order;
        const byRankHint = (left.rankHint ?? 0) - (right.rankHint ?? 0);
        return byRankHint || left.order - right.order || left.id.localeCompare(right.id);
    };

    // Surface-local preferences are resolved by that surface, not shared discovery.
    return Object.freeze(destinations.sort(compare).map((destination, order) => Object.freeze({ ...destination, order })));
}

/** The destinations listed in one placement group, visible ones only, in catalog order. */
export function selectAppDestinationsInPlacement(
    catalog: readonly CompactAppDestination[],
    placement: AppDestinationPlacement,
    options?: Readonly<{ includeHidden?: boolean }>,
): readonly CompactAppDestination[] {
    const key = placementGroupKey(placement);
    return catalog.filter((destination) => (
        (options?.includeHidden === true || isCompactAppDestinationVisible(destination)) && placementGroupKey(destination.placement) === key
    ));
}

function normalizePathname(pathname: string): string {
    return stripGroupSegmentsFromPath(pathname.trim()).replace(/\/+$/, '') || '/';
}

function splitPath(path: string): readonly string[] {
    return path === '/' ? [] : path.split('/').slice(1);
}

/** The number of literal segments `pattern` matched in `actual`, or `null` when it does not match. */
function matchRoutePattern(pattern: string, actual: readonly string[]): number | null {
    const expected = splitPath(pattern);
    const rest = expected.length > 0 && /^\[\.\.\.[^\]]+\]$/.test(expected[expected.length - 1]!);
    const fixed = rest ? expected.slice(0, -1) : expected;
    if (rest ? actual.length <= fixed.length : actual.length !== fixed.length) return null;
    let literals = 0;
    for (let index = 0; index < fixed.length; index += 1) {
        const segment = fixed[index]!;
        if (/^\[[^\]]+\]$/.test(segment)) {
            if (actual[index]!.length === 0) return null;
            continue;
        }
        if (segment !== actual[index]) return null;
        literals += 1;
    }
    return literals;
}

/**
 * How specifically a destination claims a pathname, or `null`. Its own route exactly is the strongest
 * claim; a plugin page also owns everything under its route (the plugin's own locations).
 */
function scoreDestinationRoute(destination: CompactAppDestination, actual: readonly string[]): number | null {
    // A panel opens in the right sidebar of the page it is activated from: it is never the open page.
    if (destination.activation === 'rightSidebarTab') return null;
    const routeSegments = splitPath(normalizePathname(destination.routePath.split('?')[0]!));
    let best: number | null = null;
    const exact = routeSegments.length === actual.length
        && routeSegments.every((segment, index) => segment === actual[index]);
    if (exact) best = routeSegments.length * 2 + 1;
    else if (
        destination.kind === 'plugin'
        && actual.length > routeSegments.length
        && routeSegments.every((segment, index) => segment === actual[index])
    ) {
        best = routeSegments.length * 2;
    }
    if (destination.kind === 'builtin') {
        for (const pattern of destination.currentRoutePatterns ?? []) {
            const literals = matchRoutePattern(pattern, actual);
            if (literals !== null) best = Math.max(best ?? 0, literals * 2);
        }
    }
    return best;
}

/**
 * The destination that is open at `pathname`: the most specific claim, or null when no destination
 * claims this route. The rail, column, peek and every selected row derive from this one answer.
 */
export function resolveCurrentAppDestination(
    catalog: readonly CompactAppDestination[],
    pathname: string,
): CompactAppDestination | null {
    const actual = splitPath(normalizePathname(pathname));
    let current: CompactAppDestination | null = null;
    let currentScore = -1;
    for (const destination of catalog) {
        const score = scoreDestinationRoute(destination, actual);
        if (score !== null && score > currentScore) {
            current = destination;
            currentScore = score;
        }
    }
    return current;
}

function decodeSegment(segment: string): string | null {
    try {
        return decodeURIComponent(segment);
    } catch {
        return null;
    }
}

function encodedSegment(segment: string): string {
    return encodeURIComponent(segment);
}

function appendQuery(path: string, params: Readonly<Record<string, string>>, excluded: readonly string[]): string {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
        if (key !== 'anchor' && !excluded.includes(key)) query.set(key, value);
    }
    const search = query.toString();
    const anchor = params.anchor ? `#${encodedSegment(params.anchor)}` : '';
    return `${search ? `${path}?${search}` : path}${anchor}`;
}

/** Resolve a deep link against the same destination catalog that owns shell activation. */
export function resolveDestinationRefFromHref(
    catalog: readonly CompactAppDestination[],
    href: string,
): DestinationRef | null {
    if (!href.startsWith('/') || href.startsWith('//')) return null;
    let url: URL;
    try {
        url = new URL(href, 'https://happier.invalid');
    } catch {
        return null;
    }
    const path = normalizePathname(url.pathname);
    const rawParts = splitPath(path);
    const decodedParts = rawParts.map(decodeSegment);
    if (decodedParts.some((part) => part === null)) return null;
    const parts = decodedParts as string[];
    const [first, second, third, ...rest] = parts;
    const route = matchWorkspaceDestinationRoute(path);
    const parsedQuery = parseQueryParams(`${path}${url.search}`, { name: route?.routeKey ?? path, params: route?.params });
    const query: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsedQuery ?? {})) {
        // Destination refs are scalar. Leave multivalued inputs with Expo so
        // domain readers (notably plugin locations) see and reject ambiguity.
        if (Array.isArray(value)) return null;
        query[key] = value;
    }
    delete query.workspacePathname;
    if (url.hash.length > 1) {
        const anchor = decodeSegment(url.hash.slice(1));
        if (anchor === null) return null;
        query.anchor = anchor;
    }

    if (first === 'session' && second) {
        if (third === 'details') {
            if (rest.length > 0) return null;
            const details = parseSessionPaneUrlState(query)?.details;
            if (!details) return null;
            return { kind: 'sessionDetails', params: {
                id: second,
                ...(query.serverId ? { serverId: query.serverId } : {}),
                ...serializeSessionPaneUrlState({ details }),
            } };
        }
        if (third === undefined && (!route || route.routeKey === 'session/[id]')) return { kind: 'session', params: { ...query, id: second } };
    }
    if (first === 'projects' && second) {
        return {
            kind: 'project',
            params: { ...query, ...route?.params, ...(third ? { pageId: [third, ...rest].join('/') } : {}), workspaceRefId: second },
        };
    }
    if (first === 'workflows' && second === 'runs' && third && rest.length === 0) {
        return { kind: 'workflowRun', params: { ...query, runId: third } };
    }
    if (first === 'workflows' && second && third === undefined && !['runs', 'new', 'edit', 'settings'].includes(second)) {
        return { kind: 'workflow', params: { ...query, id: second } };
    }
    if (first === 'automations' && second && third === undefined && !['settings', 'new', 'edit'].includes(second)) {
        return { kind: 'automation', params: { ...query, id: second } };
    }
    if (first === 'plugins' && parts.length >= 3
        && !catalog.some((item) => item.kind === 'plugin' && item.container === 'appPage'
            && item.destination.pluginId === second && item.destination.localId === third)) return null;
    const destination = resolveCurrentAppDestination(catalog, path);
    if (!destination || destination.activation !== 'navigate') return null;
    if (destination.kind === 'plugin') {
        const baseParts = splitPath(destination.routePath);
        if (rawParts.length < baseParts.length) return null;
        const subPath = parts.slice(baseParts.length).join('/');
        return {
            kind: destination.id,
            params: {
                ...query,
                ...(subPath ? { subPath } : {}),
                pluginId: destination.destination.pluginId,
                localId: destination.destination.localId,
            },
        };
    }
    if (destination.id === 'settings') {
        if (!route) return null;
        if (route?.params.pageId) return { kind: 'settings', params: {
            ...query, ...route.params, workspacePathname: path,
        } };
        return { kind: 'settings', params: { ...query, ...route?.params, pageId: parts.slice(1).join('/') } };
    }
    if (path !== destination.routePath) {
        if (!route) return null;
        return { kind: destination.id, params: { ...query, ...route.params, workspacePathname: path } };
    }
    return { kind: destination.id, params: { ...query } };
}

/** The inverse URL projection for the focused tab's destination. */
export function hrefForDestinationRef(
    catalog: readonly CompactAppDestination[],
    ref: DestinationRef,
): string | null {
    const params = ref.params;
    if (params.workspacePathname) {
        const target = resolveDestinationRefFromHref(catalog, params.workspacePathname);
        if (!target || target.kind !== ref.kind) return null;
        const route = matchWorkspaceDestinationRoute(params.workspacePathname);
        if (!route) return null;
        return appendQuery(params.workspacePathname, params, ['workspacePathname', ...Object.keys(route.params)]);
    }
    if (ref.kind === 'session' && params.id) {
        return appendQuery(`/session/${encodedSegment(params.id)}`, params, ['id']);
    }
    if (ref.kind === 'sessionDetails' && params.id && params.details) {
        const details = parseSessionPaneUrlState(params)?.details;
        if (!details) return null;
        return appendQuery(`/session/${encodedSegment(params.id)}/details`, {
            ...(params.serverId ? { serverId: params.serverId } : {}),
            ...serializeSessionPaneUrlState({ details }),
        }, []);
    }
    if (ref.kind === 'project' && params.workspaceRefId) {
        const page = params.pageId ? `/${params.pageId.split('/').map(encodedSegment).join('/')}` : '';
        const path = `/projects/${encodedSegment(params.workspaceRefId)}${page}`;
        return appendQuery(path, params, ['workspaceRefId', 'pageId', ...Object.keys(matchWorkspaceDestinationRoute(path)?.params ?? {})]);
    }
    if (ref.kind === 'workflowRun' && params.runId) {
        return appendQuery(`/workflows/runs/${encodedSegment(params.runId)}`, params, ['runId']);
    }
    if (ref.kind === 'workflow' && params.id) {
        return appendQuery(`/workflows/${encodedSegment(params.id)}`, params, ['id']);
    }
    if (ref.kind === 'automation' && params.id) {
        return appendQuery(`/automations/${encodedSegment(params.id)}`, params, ['id']);
    }
    if (ref.kind === 'settings') {
        const page = params.pageId
            ? `/${params.pageId.split('/').map(encodedSegment).join('/')}`
            : '';
        const path = `/settings${page}`;
        return appendQuery(path, params, ['pageId', ...Object.keys(matchWorkspaceDestinationRoute(path)?.params ?? {})]);
    }
    if (ref.kind === 'newTab') return '/';
    const destination = catalog.find((item) => item.id === ref.kind && item.activation === 'navigate');
    if (!destination) return null;
    if (destination.kind === 'plugin') {
        if (params.pluginId !== destination.destination.pluginId || params.localId !== destination.destination.localId) return null;
        const subPath = params.subPath
            ? `/${params.subPath.split('/').map(encodedSegment).join('/')}`
            : '';
        return appendQuery(`${destination.routePath}${subPath}`, params, ['pluginId', 'localId', 'subPath']);
    }
    return appendQuery(destination.routePath, params, []);
}

function useAppBuiltinDestinationAvailability(): AppBuiltinDestinationAvailability {
    // The same decision the Sessions list reads for its external sessions (`useSessionListStorageKind`).
    const externalSessions = useFeatureDecision('sessions.direct')?.state === 'enabled';
    const inbox = useInboxAvailable();
    // Listed while discoverable, including a local-policy disablement whose repair it leads to.
    const workflows = useWorkflowsDestinationAccess().discoverable;
    const friends = useFriendsEnabled();
    return React.useMemo(
        () => ({ externalSessions, inbox, workflows, friends }),
        [externalSessions, friends, inbox, workflows],
    );
}

/**
 * App-shell adapter for the catalog. Discovery requires a current admitted projection, not daemon
 * interaction: pages can be host-local or Account-artifact-backed and must remain
 * navigable/offline-tombstonable while executable bridge methods are separately unavailable.
 */
export function useCompactAppDestinations(): readonly CompactAppDestination[] {
    const projection = useAppShellPluginUiProjection();
    const localizePluginText = useProjectedPluginLocalizedTextResolver();
    const builtins = useAppBuiltinDestinationAvailability();
    const pages = React.useMemo(() => (
        projection.pluginUiProjection
            ? resolvePluginAppPages({
                placements: selectPluginAppPagePlacements(projection.pluginUiProjection),
                localize: localizePluginText,
            })
            : []
    ), [localizePluginText, projection.pluginUiProjection]);
    const rightSidebarTabs = React.useMemo(() => (
        projection.pluginUiProjection
            ? resolveRightSidebarTabs({
                scope: 'app',
                pluginPlacements: selectPluginRightSidebarTabPlacements(
                    projection.pluginUiProjection,
                    'app',
                ),
                projectionGeneration: projection.pluginUiProjection.generation,
                localize: localizePluginText,
            }).filter((tab): tab is RightSidebarPluginTabDefinition => tab.owner === 'plugin')
            : []
    ), [localizePluginText, projection.pluginUiProjection]);
    return React.useMemo(() => resolveCompactAppDestinations({
        builtins,
        pages,
        rightSidebarTabs,
    }), [builtins, pages, rightSidebarTabs]);
}

export type ActivateAppDestination = (
    destination: CompactAppDestination,
    options?: Readonly<{ searchScope?: UniversalSearchScopeSeed }>,
) => void;

/**
 * The one way to open a destination, for every list of them (rail, column rows, phone launcher,
 * palette): Search opens over the page, an App panel opens in the right sidebar of the page on
 * screen, a plugin page goes through its launch owner, everything else navigates to its route. An unavailable plugin page still navigates, to its route-owned
 * tombstone; lists that show it disabled simply do not call this.
 */
export function useActivateAppDestination(): ActivateAppDestination {
    const router = useRouter();
    const activatePluginAppPage = usePluginAppPageCatalogActivationHandler();
    const universalSearch = useOptionalUniversalSearchRuntime();
    const openAppRightSidebarTab = useOpenAppRightSidebarTab();
    // The owners above change with the route; the returned callback does not, so every memoized row
    // and rail icon that holds it keeps its identity across navigation.
    const latest = React.useRef({ router, activatePluginAppPage, universalSearch, openAppRightSidebarTab });
    latest.current = { router, activatePluginAppPage, universalSearch, openAppRightSidebarTab };
    return React.useCallback((destination, options) => {
        const owners = latest.current;
        if (destination.activation === 'overlay') {
            owners.universalSearch?.open(undefined, options?.searchScope);
            return;
        }
        if (destination.kind === 'plugin' && destination.activation === 'rightSidebarTab') {
            if (destination.availability === 'available') owners.openAppRightSidebarTab(destination.destination);
            return;
        }
        if (
            destination.kind === 'plugin'
            && destination.container === 'appPage'
            && destination.availability === 'available'
        ) {
            const result = runGuardedNavigation(() => owners.activatePluginAppPage(destination));
            if (result !== true) fireAndForget(result, { tag: 'AppDestination.activatePluginPage' });
            return;
        }
        const result = runGuardedNavigation(() => owners.router.push(destination.routePath as never));
        if (result !== true) fireAndForget(result, { tag: 'AppDestination.activate' });
    }, []);
}

export type DestinationInstanceTitleEntry = Readonly<{ key: string; ref: DestinationRef }>;


/**
 * The title of what is open, without asking any store: a Details target's own title (its file name,
 * "Board", a terminal), a settings page's title, or the catalog's title for a plugin page or an
 * app area. `null` when only live data can name it (a session) or nothing can.
 */
function resolveStaticInstanceTitle(catalog: readonly CompactAppDestination[], ref: DestinationRef): string | null {
    if (ref.kind === 'newTab') return t('workspaceBar.newTab');
    if (ref.kind === 'session') return null;
    if (ref.kind === 'sessionDetails') {
        const details = parseSessionPaneUrlState(ref.params)?.details;
        return details ? createSessionPaneDetailsTab(details)?.title ?? null : null;
    }
    const href = hrefForDestinationRef(catalog, ref);
    if (!href) return null;
    const pathname = href.split(/[?#]/, 1)[0]!;
    if (ref.kind === 'settings') {
        const key = resolveSettingsRouteTitleKey(pathname);
        if (key) return t(key);
    }
    return resolveCurrentAppDestination(catalog, pathname)?.title ?? null;
}

/**
 * The same title, read once without subscribing (a drag preview names what it carries and where it
 * lands only when the verdict changes). `null` when nothing can name it yet.
 */
export function readDestinationInstanceTitle(catalog: readonly CompactAppDestination[], ref: DestinationRef): string | null {
    const title = resolveStaticInstanceTitle(catalog, ref);
    if (title || ref.kind !== 'session' || !ref.params.id) return title;
    return readSessionDisplayTitle({ sessionId: ref.params.id, serverId: ref.params.serverId ?? null });
}

/**
 * The live title of each open destination instance (workspace lab T: "its title comes from the
 * destination"): a session's current name, a Details target's own name, a settings page or plugin
 * page title. One resolver for every tab bar, keyed by the caller's tab key; a key is absent when the
 * instance cannot be named yet, so the caller shows its saved title (loading, unavailable).
 */
export function useDestinationInstanceTitles(
    catalog: readonly CompactAppDestination[],
    entries: readonly DestinationInstanceTitleEntry[],
): ReadonlyMap<string, string> {
    const sessionEntries = React.useMemo(() => entries.filter((entry) => entry.ref.kind === 'session'
        && typeof entry.ref.params.id === 'string' && entry.ref.params.id.length > 0), [entries]);
    const addresses = React.useMemo(() => sessionEntries.map((entry) => ({
        sessionId: entry.ref.params.id!, serverId: entry.ref.params.serverId ?? null,
    })), [sessionEntries]);
    const sessionTitles = useSessionDisplayNameProjections(addresses, sessionDisplayTitle);
    const discussionEntries = React.useMemo(() => entries.flatMap(entry => {
        if (entry.ref.kind !== 'sessionDetails' || !entry.ref.params.id) return [];
        const details = parseSessionPaneUrlState(entry.ref.params)?.details;
        return details?.kind === 'discussion' ? [{ key: entry.key, serverId: entry.ref.params.serverId ?? null,
            sessionId: entry.ref.params.id!, discussionId: details.discussionId }] : [];
    }), [entries]);
    const discussionTitles = useSessionDiscussionTitleProjections(discussionEntries);
    return React.useMemo(() => {
        const titles = new Map<string, string>();
        for (const entry of entries) {
            const title = resolveStaticInstanceTitle(catalog, entry.ref);
            if (title) titles.set(entry.key, title);
        }
        sessionEntries.forEach((entry, index) => {
            const name = sessionTitles[index];
            if (!name) return;
            // A Details tab names its target; a session tab names the session.
            if (entry.ref.kind === 'session') titles.set(entry.key, name);
        });
        discussionEntries.forEach((entry, index) => {
            const name = discussionTitles[index];
            if (name) titles.set(entry.key, name);
        });
        return titles;
    }, [catalog, entries, sessionEntries, sessionTitles, discussionEntries, discussionTitles]);
}
