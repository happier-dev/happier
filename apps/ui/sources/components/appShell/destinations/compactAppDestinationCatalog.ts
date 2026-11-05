import * as React from 'react';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { workflowRunStoreKey } from '@/sync/store/domains/workflowRuns';
import { readWorkflowRunTarget } from '@/sync/domains/workflows/workflowRunRoute';
import { useShallow } from 'zustand/react/shallow';
import { stripGroupSegmentsFromPath } from 'expo-router/build/matchers';
import { parseQueryParams } from 'expo-router/build/fork/getStateFromPath-forks';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { normalizeProjectPage, resolveProjectCockpitRouteFromPathname } from '@/components/workspaceCockpit/project/projectCockpitState';
import { readProjectRouteWorktreeSelection, resolveProjectRouteHeaderTitle } from '@/components/projects/detail/projectRouteState';
import { projectPageLabel } from '@/components/projects/shell/ProjectShellHeader';
import { resolveWorkspaceRefById } from '@/sync/domains/workspaces/workspaceRefs';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import { readRegisteredStorageState } from '@/sync/domains/state/storageStateReaderBridge';
import { EMPTY_WORKSPACE_REFS, readProjectWorkspaceRefs, readCurrentProjectAccountRows, isProjectAccountRowsCensusComplete } from '@/sync/store/domains/projectAccountRows';
import { isSessionRetiredForServer } from '@/sync/store/domains/sessions';
import type {
    PluginUiDestinationPlacementV1,
    PluginUiDestinationReferenceV1,
} from '@happier-dev/protocol/plugins/ui';

import {
    useAppShellPluginUiDeclarationSources,
    type AppShellPluginUiDeclarationSources,
} from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { createPluginLocalizedTextResolver } from '@/sync/domains/plugins/ui/i18n';
import { usePreferredLanguage } from '@/text/usePreferredLanguage';
import { getPreferredLanguage } from '@/text/preferredLanguage';
import type { SupportedLanguage } from '@/text/_all';
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
import { useOptionalBotsRosterRuntime } from '@/components/sessions/bots/BotsRosterRuntime';
import { BOTS_GLYPH } from '@/components/sessions/bots/botsGlyph';
import type { IconName } from '@/components/ui/icons/Icon';
import {
    resolveRightSidebarTabs,
} from '@/components/appShell/rightSidebar/rightSidebarTabRegistry';
import type { RightSidebarPluginTabDefinition } from '@/components/appShell/rightSidebar/rightSidebarBuiltinTabs';
import { useWorkflowsDestinationAccess } from '@/components/workflows/gating/workflowsDestinationAccess';
import { useInboxAvailable } from '@/hooks/inbox/useInboxAvailable';
import { useFeatureDecision } from '@/hooks/server/useFeatureDecision';
import { useFriendsEnabled } from '@/hooks/server/useFriendsEnabled';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { normalizeSessionAddress } from '@/sync/domains/session/sessionAddress';
import { useSessionContentDemand } from '@/sync/domains/session/useSessionContentDemand';
import type { KeyboardCommandId } from '@/keyboard/types';
import { selectPluginRightSidebarTabPlacements } from '@/sync/domains/plugins/ui/surfacePlacementSelectors';
import { getStorage, selectSessionDisplayNameSource, useActiveServerAccountScopeLifetime, useSessionDisplayNameProjections } from '@/sync/domains/state/storage';
import { t, tLoose, type TranslationKeyNoParams } from '@/text';
import { BUILTIN_WORKFLOW_CATALOG_V1 } from '@happier-dev/protocol/workflows/builtins/catalog';
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
import { resolveSessionRoutePathForSurface } from '@/components/workspaceCockpit/session/sessionCockpitState';
import { resolveSettingsRouteTitleKey } from '@/components/settings/navigation/settingsRouteRegistry';
import { readSessionDisplayTitle, sessionDisplayTitle } from '@/utils/sessions/sessionDisplayTitle';
import { readDiscussionTitle, useDiscussionTitleProjections } from '@/sync/ops/discussions/useDiscussionRepositorySnapshot';
import { matchWorkspaceDestinationRoute, registeredWorkspaceRoutes, workspaceRouteHref } from '@/components/appShell/workspace/workspaceRoutes';
import { useOptionalWorkspaceNavigation, type WorkspaceDestinationTitle } from '@/components/appShell/workspace/WorkspaceNavigationContext';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { formatWorkflowRunDisplayName, resolveWorkflowRunDisplayName } from '@/components/workflows/presentation/workflowRunDisplayName';
import { getProfileCatalogSnapshot, subscribeProfileCatalogSnapshots } from '@/sync/store/settings/profileCatalogSnapshot';
import { getProviderCatalogSnapshot, subscribeProviderCatalogSnapshots } from '@/sync/store/settings/providerCatalogSnapshot';
import { getMcpServerCatalogSnapshot, subscribeMcpServerCatalogSnapshots } from '@/sync/store/settings/mcpServerCatalogSnapshot';
import { projectAiLaunchProfileForLegacyUi, readUiProfileCatalogSnapshot } from '@/sync/domains/profiles/aiLaunchProfileCollection';
import { getProfileDisplayName } from '@/components/profiles/profileDisplay';
import { getBuiltInProfile } from '@/sync/domains/profiles/profileUtils';
import { mcpServerDisplayName } from '@/components/settings/mcpServers/collection/mcpServerCollectionModel';
import { describeAccountProviderConnectionV1 } from '@happier-dev/protocol/providers/connections/accountProviderActionV1';
import { composeProviderSettingsV1 } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { readAccountProviderDeclarations } from '@/providers/catalog/accountProviderDeclarations';
import { presentProviderConnectionIdentity } from '@/providers/connection/presentation';
import { isApprovalArtifactKindV1 } from '@happier-dev/protocol/approvals/approvalArtifactKindV1';
import { ApprovalRequestV2StatusSchema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { readApprovalArtifactTitleInput, resolveApprovalRequestTitle } from '@/components/approvals/approvalRequestTitle';
import { approvalArtifactBodyMatchesHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { formatApprovalStatusLabel, readApprovalArtifactDisplayStatus } from '@/components/approvals/approvalStatusLabel';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { buildDiscussionsRouteHref } from '@/components/discussions/discussionRoutes';

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
export const DISCUSSIONS_DESTINATION_ID = 'discussions';

/**
 * The columns this host can stand beside a page. `AppShellColumn` renders each through one table
 * typed against this list, so a column id without a renderer is a type error. A placement naming any
 * other column falls back to the rail.
 */
export const BUILTIN_APP_SHELL_COLUMN_IDS = ['sessions', 'discussions', 'projects', 'workflows', 'boards', 'plugins', 'settings', 'machines'] as const;
export type BuiltinAppShellColumnId = typeof BUILTIN_APP_SHELL_COLUMN_IDS[number];

export function isBuiltinAppShellColumnId(value: string): value is BuiltinAppShellColumnId {
    return (BUILTIN_APP_SHELL_COLUMN_IDS as readonly string[]).includes(value);
}

/**
 * The columns another destination may be placed in. Settings is not one: settings contributions are
 * settings pages, with the Settings catalog as their one owner. Workflows is not one either: its
 * column lists workflow sections from their own owners (FIN 04 §3.3), not other destinations. Nor is
 * Boards: its column lists the user's boards (INT §5.1). Nor is Machines: its column is the machine
 * list (plan machine-resources 10 §4.2).
 */
export type PlaceableAppShellColumnId = Exclude<BuiltinAppShellColumnId, 'settings' | 'workflows' | 'boards' | 'machines'>;

const UNPLACEABLE_APP_SHELL_COLUMN_IDS: ReadonlySet<string> = new Set(['settings', 'workflows', 'boards', 'machines']);

function isPlaceableAppShellColumnId(value: string): value is PlaceableAppShellColumnId {
    return isBuiltinAppShellColumnId(value) && !UNPLACEABLE_APP_SHELL_COLUMN_IDS.has(value);
}

export type AppDestinationRailRegion = 'app' | 'plugins' | 'account';

/** Where a destination is listed, after resolving its request against this host's columns. */
export type AppDestinationPlacement =
    | Readonly<{ kind: 'rail'; region: AppDestinationRailRegion }>
    | Readonly<{ kind: 'column'; column: PlaceableAppShellColumnId }>;

/** What activating a destination does. The one activation owner is {@link useActivateAppDestination}. */
export type AppDestinationActivation = 'navigate' | 'overlay' | 'rightSidebarTab' | 'botsRoster';

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
    /**
     * The rail already draws this destination as one of its own footer controls (Machines is the
     * `app-rail-machines` icon and its popover), so the rail, its customizer and the phone launcher do
     * not list it again; it stays a visible destination for the command palette and location.
     */
    railControl?: 'footer';
    /** Reuse this resource on ordinary navigation; explicit new-tab/split intents remain independent. */
    workspaceNavigationIdentity?: Readonly<{ resourceParam: string; scopeParams: readonly string[] }>;
    availability: 'available' | 'unavailable';
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

/** Available launch owners, plus the existing route-owned unavailable plugin App-page tombstone. */
export function isCompactAppDestinationInvokable(destination: CompactAppDestination): boolean {
    return destination.availability === 'available'
        || (destination.kind === 'plugin' && destination.container === 'appPage' && destination.activation === 'navigate');
}

export type AppDestinationActivationOwners = Readonly<{ openBotsRoster?: () => void }>;

/** The address of one page instance. Tab identity is separate: two tabs may hold the same ref. */
export type DestinationRef = Readonly<{
    kind: string;
    params: Readonly<Record<string, string>>;
}>;

/** Which optional built-ins this viewer can open; each comes from its own availability owner. */
export type AppBuiltinDestinationAvailability = Readonly<{
    externalSessions: boolean;
    inbox: boolean;
    discussions?: boolean;
    /** The Workflows destination is discoverable (`useWorkflowsDestinationAccess`). */
    workflows: boolean;
    friends: boolean;
    botsRoster?: boolean;
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
    activation: 'navigate' | 'overlay' | 'botsRoster';
    routePath: string;
    currentRoutePatterns?: readonly string[];
    shortcut?: KeyboardCommandId;
    signal?: 'inboxCount';
    suggested?: true;
    railControl?: 'footer';
    workspaceNavigationIdentity?: CompactAppBuiltinDestination['workspaceNavigationIdentity'];
    available?: (availability: AppBuiltinDestinationAvailability) => boolean;
    activationAvailable?: (availability: AppBuiltinDestinationAvailability) => boolean;
    visibility?: CompactAppDestinationVisibility;
}>;

/**
 * The host's own destinations, in their default order within each placement group. Workflows is the
 * one destination for workflows and their triggers; the retired Automations routes redirect into it.
 */
function readBuiltinDestinationRows(): readonly BuiltinDestinationRow[] {
    // Route adapters can load this catalog through DestinationInstanceHost. Read their bindings
    // at projection time rather than capturing an unfinished circular module initialization.
    return [
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
        id: DISCUSSIONS_DESTINATION_ID, titleKey: 'session.collaboration.discussion.title', icon: 'chat-circle',
        placement: { kind: 'rail', region: 'app' }, column: 'discussions', activation: 'navigate', routePath: '/discussions',
        currentRoutePatterns: ['/discussions/[...rest]'],
        workspaceNavigationIdentity: { resourceParam: 'discussionId', scopeParams: ['serverId'] },
        available: (availability) => availability.discussions === true,
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
    // Last of the app's own entries, on its own beside its rail-pinned Bots (lab `b-rail A`).
    {
        id: 'bots', titleKey: 'bots.title', icon: BOTS_GLYPH,
        placement: { kind: 'rail', region: 'app' }, activation: 'botsRoster', routePath: '/',
        activationAvailable: availability => availability.botsRoster === true,
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
        // One Machines page with two doors (R1): this rail door opens it beside the machine list, without
        // the Settings column; Settings → Machines is the other door. The rail's footer Machines icon is
        // this destination's control (its popover), so no second rail icon is drawn.
        id: 'machines', titleKey: 'settings.machines', icon: 'desktop', placement: { kind: 'rail', region: 'account' },
        column: 'machines', activation: 'navigate', routePath: '/machines',
        currentRoutePatterns: ['/machines/[...rest]'], railControl: 'footer',
        workspaceNavigationIdentity: { resourceParam: 'id', scopeParams: ['serverId'] },
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
}

/** A destination the rail draws as its own control, so rail lists (rail, customizer, phone launcher) skip it. */
export function isRailControlDestination(destination: CompactAppDestination): boolean {
    return destination.kind === 'builtin' && destination.railControl !== undefined;
}

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

    readBuiltinDestinationRows().forEach((row, order) => {
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
            ...(row.railControl === undefined ? {} : { railControl: row.railControl }),
            ...(row.workspaceNavigationIdentity === undefined ? {} : { workspaceNavigationIdentity: row.workspaceNavigationIdentity }),
            ...(row.visibility === undefined ? {} : { visibility: row.visibility }),
            availability: row.activationAvailable && !row.activationAvailable(input.builtins) ? 'unavailable' : 'available',
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
            // An unavailable page mounts no column renderer, so it has no column to reserve or peek.
            ...(page.columnPlacement && unavailableReason === null ? { ownColumn: true as const } : {}),
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

export type CompactAppDestinationSources = Pick<AppShellPluginUiDeclarationSources, 'projection' | 'accountLifetime' | 'ready'> & Readonly<{
    locale: SupportedLanguage;
    builtins: AppBuiltinDestinationAvailability;
}>;

type CompactDestinationVariant = {
    destinations: readonly CompactAppDestination[];
    published: boolean;
    listeners: Set<() => void>;
};

type CompactDestinationPublication = {
    source: CompactAppDestinationSources;
    prepared: Readonly<{
        pages: readonly PluginAppPage[];
        rightSidebarTabs: readonly RightSidebarPluginTabDefinition[];
    }> | null;
    variants: Map<number, CompactDestinationVariant>;
    lastDestinations: readonly CompactAppDestination[];
    retirement: Readonly<{ dispose(): void }> | null;
};

const UNPUBLISHED_COMPACT_DESTINATIONS: readonly CompactAppDestination[] = Object.freeze([]);
const compactDestinationPublications = new Set<CompactDestinationPublication>();
let latestCompactDestinationPublication: CompactDestinationPublication | null = null;

function isCompactDestinationSourceCurrent(source: CompactAppDestinationSources): boolean {
    return source.ready && (!source.accountLifetime || source.accountLifetime.isCurrent());
}

function compactDestinationVariantKey(builtins: AppBuiltinDestinationAvailability): number {
    return Number(builtins.externalSessions) | (Number(builtins.inbox) << 1)
        | (Number(builtins.discussions === true) << 2) | (Number(builtins.workflows) << 3)
        | (Number(builtins.friends) << 4) | (Number(builtins.botsRoster === true) << 5);
}

function findCompactDestinationPublication(source: CompactAppDestinationSources): CompactDestinationPublication | undefined {
    for (const publication of compactDestinationPublications) {
        if (publication.source.accountLifetime === source.accountLifetime
            && publication.source.projection === source.projection
            && publication.source.locale === source.locale) return publication;
    }
    return undefined;
}

function readLastKnownCompactDestinations(source: CompactAppDestinationSources): readonly CompactAppDestination[] {
    const key = compactDestinationVariantKey(source.builtins);
    let matchingVariant = UNPUBLISHED_COMPACT_DESTINATIONS;
    let lastKnown = UNPUBLISHED_COMPACT_DESTINATIONS;
    for (const publication of compactDestinationPublications) {
        if (publication.source.accountLifetime !== source.accountLifetime) continue;
        if (publication.lastDestinations !== UNPUBLISHED_COMPACT_DESTINATIONS) lastKnown = publication.lastDestinations;
        const variant = publication.variants.get(key);
        if (variant?.published) matchingVariant = variant.destinations;
    }
    return matchingVariant === UNPUBLISHED_COMPACT_DESTINATIONS ? lastKnown : matchingVariant;
}

/** Reads never prepare pages, sort destinations, compare rows, or publish a source. */
export function readCommittedCompactAppDestinations(source: CompactAppDestinationSources): readonly CompactAppDestination[] {
    if (!isCompactDestinationSourceCurrent(source)) return UNPUBLISHED_COMPACT_DESTINATIONS;
    return findCompactDestinationPublication(source)?.variants.get(compactDestinationVariantKey(source.builtins))?.destinations
        ?? readLastKnownCompactDestinations(source);
}

function isCompactDestinationSourcePublished(source: CompactAppDestinationSources): boolean {
    return isCompactDestinationSourceCurrent(source)
        && findCompactDestinationPublication(source)?.variants.get(compactDestinationVariantKey(source.builtins))?.published === true;
}

function releaseCompactDestinationPublication(publication: CompactDestinationPublication): void {
    compactDestinationPublications.delete(publication);
    publication.retirement?.dispose();
    if (latestCompactDestinationPublication === publication) latestCompactDestinationPublication = null;
}

function pruneCompactDestinationPublications(): void {
    // Keep the current source for remounts, and older tuples only while actually subscribed.
    // Each source has only the six builtin booleans' demanded variants; no revision history.
    for (const publication of compactDestinationPublications) {
        if (publication !== latestCompactDestinationPublication
            && [...publication.variants.values()].every(variant => variant.listeners.size === 0)) {
            releaseCompactDestinationPublication(publication);
        }
    }
}

function retainCompactDestinationVariant(source: CompactAppDestinationSources): Readonly<{
    publication: CompactDestinationPublication;
    variant: CompactDestinationVariant;
}> {
    let publication = findCompactDestinationPublication(source);
    if (!publication) {
        publication = { source, prepared: null, variants: new Map(),
            lastDestinations: UNPUBLISHED_COMPACT_DESTINATIONS, retirement: null };
        compactDestinationPublications.add(publication);
        const owned = publication;
        publication.retirement = source.accountLifetime?.onRetire(() => {
            releaseCompactDestinationPublication(owned);
            owned.prepared = null;
            owned.lastDestinations = UNPUBLISHED_COMPACT_DESTINATIONS;
            for (const variant of owned.variants.values()) {
                variant.destinations = UNPUBLISHED_COMPACT_DESTINATIONS;
                variant.published = false;
                for (const listener of variant.listeners) listener();
            }
        }) ?? null;
    }
    const key = compactDestinationVariantKey(source.builtins);
    let variant = publication.variants.get(key);
    if (!variant) {
        variant = { destinations: readLastKnownCompactDestinations(source), published: false, listeners: new Set() };
        publication.variants.set(key, variant);
    }
    return { publication, variant };
}

export function subscribeCompactAppDestinations(source: CompactAppDestinationSources, listener: () => void): () => void {
    if (!isCompactDestinationSourceCurrent(source)) return () => {};
    const { variant } = retainCompactDestinationVariant(source);
    variant.listeners.add(listener);
    return () => { variant.listeners.delete(listener); pruneCompactDestinationPublications(); };
}

function shareCompactDestinationRows(previous: readonly CompactAppDestination[], next: readonly CompactAppDestination[]): readonly CompactAppDestination[] {
    const previousById = new Map(previous.map(row => [row.id, row]));
    const shared = next.map(row => {
        const retained = previousById.get(row.id);
        return retained && sameStrictJsonValue(retained, row) ? retained : row;
    });
    return previous.length === shared.length && shared.every((row, index) => row === previous[index])
        ? previous : Object.freeze(shared);
}

/** One committed declaration/locale prepares pages and tabs for every builtin/Bots variant. */
export function commitCompactAppDestinationSources(source: CompactAppDestinationSources): void {
    // Builtin titles read the ready locale's host catalog. A superseded layout callback must
    // not publish those titles under the preceding locale's otherwise-valid declaration key.
    if (!isCompactDestinationSourceCurrent(source) || source.locale !== getPreferredLanguage()) return;
    const { publication, variant } = retainCompactDestinationVariant(source);
    if (variant.published) {
        latestCompactDestinationPublication = publication;
        pruneCompactDestinationPublications();
        return;
    }
    if (!publication.prepared) {
        const projection = source.projection;
        const localize = createPluginLocalizedTextResolver({ projection, locale: source.locale });
        publication.prepared = {
            pages: projection ? resolvePluginAppPages({ placements: selectPluginAppPagePlacements(projection), localize }) : [],
            rightSidebarTabs: projection ? resolveRightSidebarTabs({ scope: 'app',
                pluginPlacements: selectPluginRightSidebarTabPlacements(projection, 'app'),
                localize,
            }).filter((tab): tab is RightSidebarPluginTabDefinition => tab.owner === 'plugin') : [],
        };
    }
    const previous = variant.destinations;
    variant.destinations = shareCompactDestinationRows(previous, resolveCompactAppDestinations({
        builtins: source.builtins, ...publication.prepared,
    }));
    variant.published = true;
    publication.lastDestinations = variant.destinations;
    latestCompactDestinationPublication = publication;
    pruneCompactDestinationPublications();
    if (variant.destinations !== previous) for (const listener of variant.listeners) listener();
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
    if (destination.activation === 'rightSidebarTab' || destination.activation === 'botsRoster') return null;
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

function appendQuery(path: string, params: Readonly<Record<string, string>>, excluded: readonly string[], anchorIsQuery = false): string {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
        if ((key !== 'anchor' || anchorIsQuery) && !excluded.includes(key)) query.set(key, value);
    }
    const search = query.toString();
    const anchor = params.anchor && !anchorIsQuery ? `#${encodedSegment(params.anchor)}` : '';
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
    const canonicalHref = workspaceRouteHref(path, { ...query, ...route?.params });
    if (canonicalHref.split('?')[0] !== path) {
        return resolveDestinationRefFromHref(catalog, `${canonicalHref}${url.hash}`);
    }
    if (url.hash.length > 1) {
        const anchor = decodeSegment(url.hash.slice(1));
        if (anchor === null) return null;
        query.anchor = anchor;
    }

    if (first === 'session' && second) {
        if (third === 'details') {
            if (rest.length > 0) return null;
            const details = parseSessionPaneUrlState(query)?.details;
            // Without an addressed resource, Details presents the Session's retained workspace.
            // Keep its instance (and contributed tabs) instead of falling back to an Expo scope.
            if (!details) return query.details ? null : {
                kind: 'session', params: { ...query, id: second, mobileSurface: 'tabs' },
            };
            return { kind: 'sessionDetails', params: {
                id: second,
                ...(query.serverId ? { serverId: query.serverId } : {}),
                ...serializeSessionPaneUrlState({ details }),
            } };
        }
        if (third === undefined && (!route || route.routeKey === 'session/[id]')) return { kind: 'session', params: { ...query, id: second } };
    }
    if (first === 'projects' && second) {
        if (!route) return null;
        if (route.routeKey.startsWith('projects/[workspaceRefId]')) {
            if (!resolveProjectCockpitRouteFromPathname(path)) return null;
            return {
                kind: 'project',
                params: { ...query, ...route.params, ...(third ? { pageId: [third, ...rest].join('/') } : {}), workspaceRefId: second },
            };
        }
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
        // A decoded slash inside a dynamic segment is not a route separator.
        // Keep the registered path for the inverse projection and body loader.
        if (route.params.pageId || Object.values(route.params).some((value) => value.includes('/'))) return { kind: 'settings', params: {
            ...query, ...route.params, workspacePathname: path,
        } };
        return { kind: 'settings', params: { ...query, ...route.params, pageId: parts.slice(1).join('/') } };
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
        if (params.mobileSurface === 'tabs') {
            const { id, serverId, mobileSurface: _mobileSurface, ...query } = params;
            return resolveSessionRoutePathForSurface(id, 'tabs', { serverId, query });
        }
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
        if (!resolveProjectCockpitRouteFromPathname(path)) return null;
        return appendQuery(path, params, ['workspaceRefId', 'pageId', ...Object.keys(matchWorkspaceDestinationRoute(path)?.params ?? {})], Boolean(params.initialFile));
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

function useAppBuiltinDestinationAvailability(owners: AppDestinationActivationOwners): AppBuiltinDestinationAvailability {
    // The same decision the Sessions list reads for its external sessions (`useSessionListStorageKind`).
    const externalSessions = useFeatureDecision('sessions.direct')?.state === 'enabled';
    const inbox = useInboxAvailable();
    const discussions = useFeatureDecision('sessions.conversations')?.state === 'enabled';
    // Listed while discoverable, including a local-policy disablement whose repair it leads to.
    const workflows = useWorkflowsDestinationAccess().discoverable;
    const friends = useFriendsEnabled();
    // The roster opens from the app-wide runtime (rail anchor or sheet); an explicit owner overrides it.
    const botsRosterRuntime = useOptionalBotsRosterRuntime();
    const botsRoster = (owners.openBotsRoster ?? botsRosterRuntime?.open) !== undefined;
    return React.useMemo(
        () => ({ externalSessions, inbox, discussions, workflows, friends, botsRoster }),
        [externalSessions, friends, inbox, discussions, workflows, botsRoster],
    );
}

/**
 * App-shell adapter for the catalog. Discovery requires a current admitted projection, not daemon
 * interaction: pages can be host-local or Account-artifact-backed and must remain
 * navigable/offline-tombstonable while executable bridge methods are separately unavailable.
 */
export function useCompactAppDestinationCatalog(owners: AppDestinationActivationOwners = {}): Readonly<{
    destinations: readonly CompactAppDestination[];
    ready: boolean;
    accountLifetime: AppShellPluginUiDeclarationSources['accountLifetime'];
}> {
    const declaration = useAppShellPluginUiDeclarationSources();
    const locale = usePreferredLanguage();
    const builtins = useAppBuiltinDestinationAvailability(owners);
    const source = React.useMemo<CompactAppDestinationSources>(() => ({ ...declaration, locale, builtins }), [builtins, declaration, locale]);
    const subscribe = React.useCallback((listener: () => void) => subscribeCompactAppDestinations(source, listener), [source]);
    const getSnapshot = React.useCallback(() => readCommittedCompactAppDestinations(source), [source]);
    const destinations = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    const ready = isCompactDestinationSourcePublished(source);
    const [, refresh] = React.useReducer((value: boolean) => !value, false);
    React.useLayoutEffect(() => {
        commitCompactAppDestinationSources(source);
        // useSyncExternalStore subscribes passively. Admit the first complete catalog before
        // paint, including equal-row publications whose exact source just became ready.
        if (destinations !== getSnapshot() || ready !== isCompactDestinationSourcePublished(source)) refresh();
    }, [destinations, getSnapshot, ready, source]);
    return { destinations, ready, accountLifetime: declaration.accountLifetime };
}

export function useCompactAppDestinations(owners: AppDestinationActivationOwners = {}): readonly CompactAppDestination[] {
    return useCompactAppDestinationCatalog(owners).destinations;
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
export function useActivateAppDestination(activationOwners: AppDestinationActivationOwners = {}): ActivateAppDestination {
    const router = useRouter();
    const activatePluginAppPage = usePluginAppPageCatalogActivationHandler();
    const universalSearch = useOptionalUniversalSearchRuntime();
    const openAppRightSidebarTab = useOpenAppRightSidebarTab();
    const botsRosterRuntime = useOptionalBotsRosterRuntime();
    // The owners above change with the route; the returned callback does not, so every memoized row
    // and rail icon that holds it keeps its identity across navigation.
    const latest = React.useRef({ router, activatePluginAppPage, universalSearch, openAppRightSidebarTab, botsRosterRuntime, ...activationOwners });
    latest.current = { router, activatePluginAppPage, universalSearch, openAppRightSidebarTab, botsRosterRuntime, ...activationOwners };
    return React.useCallback((destination, options) => {
        const owners = latest.current;
        if (!isCompactAppDestinationInvokable(destination)) return;
        if (destination.activation === 'botsRoster') {
            (owners.openBotsRoster ?? owners.botsRosterRuntime?.open)?.();
            return;
        }
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
        const home = destination.id === DISCUSSIONS_DESTINATION_ID ? getActiveServerAccountScope() : null;
        const routePath = home ? buildDiscussionsRouteHref(home) : destination.routePath;
        const result = runGuardedNavigation(() => owners.router.push(routePath as never));
        if (result !== true) fireAndForget(result, { tag: 'AppDestination.activate' });
    }, []);
}

export type DestinationInstanceTitleEntry = Readonly<{ key: string; ref: DestinationRef; instanceKey?: string; fallbackTitle?: string }>;
export type DestinationInstanceTitleOptions = Readonly<{ publishedTitle?: WorkspaceDestinationTitle; fallbackTitle?: string }>;

function resolveSavedInstanceTitle(catalog: readonly CompactAppDestination[], ref: DestinationRef, title: string | undefined): string | null {
    if (!title?.trim()) return null;
    const href = hrefForDestinationRef(catalog, ref);
    const destination = href ? resolveCurrentAppDestination(catalog, href) : null;
    // Earlier layouts could retain an area's generic label for an entity.
    // Preserve a known entity name, never that misleading area placeholder.
    if (destination && href && (ref.kind !== destination.id || href.split(/[?#]/, 1)[0] !== destination.routePath)
        && title === destination.title) return null;
    return title;
}


/**
 * The title of what is open, without asking any store: a Details target's own title (its file name,
 * "Board", a terminal), a settings page's title, or the catalog's title for a plugin page or an
 * app area. `null` when only live data can name it (a session or Project) or nothing can.
 */
function resolveStaticInstanceTitle(catalog: readonly CompactAppDestination[], ref: DestinationRef): string | null {
    if (ref.kind === 'newTab') return t('workspaceBar.newTab');
    if (ref.kind === 'session' || ref.kind === 'project') return null;
    if (ref.kind === 'sessionDetails') {
        const details = parseSessionPaneUrlState(ref.params)?.details;
        return details ? createSessionPaneDetailsTab(details)?.title ?? null : null;
    }
    const href = hrefForDestinationRef(catalog, ref);
    if (!href) return null;
    const pathname = href.split(/[?#]/, 1)[0]!;
    if (isApprovalInstanceRef(ref)) return t('approvals.title');
    if (ref.kind === 'settings') {
        // Entity pages supply their current identity after hydration. The route's
        // generic native-header title must not stand in for that identity.
        if (Object.keys(matchWorkspaceDestinationRoute(pathname)?.params ?? {}).length > 0) return null;
        const key = resolveSettingsRouteTitleKey(pathname);
        if (key) return t(key);
    }
    const destination = resolveCurrentAppDestination(catalog, pathname);
    return destination && (destination.kind === 'plugin' || pathname === destination.routePath)
        ? destination.title : null;
}

function resolveProjectInstanceTitle(ref: DestinationRef, workspaceRefs: readonly WorkspaceRefV1[]): string | null {
    if (!ref.params.workspaceRefId) return null;
    const resolution = resolveWorkspaceRefById(workspaceRefs, ref.params.workspaceRefId, ref.params.serverId);
    if (resolution.kind !== 'resolved') return null;
    const selection = readProjectRouteWorktreeSelection({
        rawWorktreeId: ref.params.worktreeId,
        rawLegacyActiveRootPath: ref.params.activeRootPath,
        defaultRootPath: resolution.ref.rootPath,
    });
    const project = resolveProjectRouteHeaderTitle(resolution.ref, selection.requestedRootPath);
    const page = normalizeProjectPage(ref.params.pageId);
    if (page) return `${project} · ${projectPageLabel(page)}`;
    if (ref.params.pageId === 'terminal') return `${project} · ${t('settings.terminal')}`;
    return project;
}

/** One fallback rule for live chrome and synchronous history/drag snapshots. */
function resolvePublishedOrStaticInstanceTitle(catalog: readonly CompactAppDestination[], ref: DestinationRef, options?: DestinationInstanceTitleOptions, storedTitle?: string | null): string | null {
    const href = hrefForDestinationRef(catalog, ref);
    const pathname = href?.split(/[?#]/, 1)[0];
    const redirectSource = options?.publishedTitle?.ref === ref ? options.publishedTitle.redirectSource : undefined;
    if (ref.kind === 'settings' && redirectSource?.kind === 'settings') {
        const sourcePath = hrefForDestinationRef(catalog, redirectSource)?.split(/[?#]/, 1)[0];
        const collectionTitle = resolveStaticInstanceTitle(catalog, redirectSource);
        if (sourcePath && pathname?.startsWith(`${sourcePath}/`) && collectionTitle) return collectionTitle;
    }
    // Home's greeting is content, while the shell catalog calls its rail Sessions.
    if (ref.kind === SESSIONS_DESTINATION_ID && pathname === '/') return t('common.home');
    const staticTitle = resolveStaticInstanceTitle(catalog, ref);
    const destination = pathname ? resolveCurrentAppDestination(catalog, pathname) : null;
    // Collection/status headlines and automatically selected detail panels do not
    // rename their destination. Explicit entity routes have no static identity here.
    if (staticTitle && (ref.kind === 'settings'
        || (destination?.kind === 'builtin' && pathname === destination.routePath))) return staticTitle;
    // Approval history stays open by workspace policy. Its live index lifecycle,
    // including header-only socket updates, must supersede the page's earlier title.
    if (isApprovalInstanceRef(ref) && storedTitle) return storedTitle;
    const title = options?.publishedTitle?.ref === ref
        ? options.publishedTitle.title
        : staticTitle ?? storedTitle ?? resolveSavedInstanceTitle(catalog, ref, options?.fallbackTitle);
    if (title) return title;
    // Restored/background tabs need not mount their pages. A missing publication
    // is an unnamed destination, not evidence that a title fetch is still running.
    if (!href) return null;
    if (isSessionTitleRef(ref)) return t('session.untitled');
    if (ref.kind === 'settings') {
        const key = resolveSettingsRouteTitleKey(href.split(/[?#]/, 1)[0]);
        if (key) return t(key);
    }
    return resolveCurrentAppDestination(catalog, href)?.title ?? t('common.unavailable');
}

/**
 * The same title, read once without subscribing (a drag preview names what it carries and where it
 * lands only when the verdict changes). `null` when nothing can name it yet.
 */
export function readDestinationInstanceTitle(catalog: readonly CompactAppDestination[], ref: DestinationRef, options?: DestinationInstanceTitleOptions): string | null {
    const state = readRegisteredStorageState();
    const missing = resolveKnownMissingInstanceTitle(ref, state);
    if (missing) return missing;
    const stored = resolveStoredInstanceTitle(ref, state, resolveSavedInstanceTitle(catalog, ref, options?.fallbackTitle));
    if (ref.kind === 'project') {
        const state = readRegisteredStorageState();
        const project = resolveProjectInstanceTitle(ref, state ? readProjectWorkspaceRefs(state) : EMPTY_WORKSPACE_REFS);
        if (project) return project;
    }
    if (isSessionTitleRef(ref) && ref.params.id) {
        const session = readSessionDisplayTitle({ sessionId: ref.params.id, serverId: ref.params.serverId ?? null });
        if (session) return session;
    }
    if (ref.kind === DISCUSSIONS_DESTINATION_ID && ref.params.discussionId) {
        const discussion = readDiscussionTitle({ serverId: ref.params.serverId ?? null, discussionId: ref.params.discussionId });
        if (discussion) return discussion;
    }
    if (ref.kind === 'sessionDetails' && ref.params.id) {
        const details = parseSessionPaneUrlState(ref.params)?.details;
        if (details?.kind === 'discussion') {
            const discussion = readDiscussionTitle({ serverId: ref.params.serverId ?? null, discussionId: details.discussionId });
            if (discussion) return discussion;
        }
    }
    return resolvePublishedOrStaticInstanceTitle(catalog, ref, options, stored);
}

function isSessionTitleRef(ref: DestinationRef): boolean {
    return ref.kind === 'session' || (ref.kind === 'sessions'
        && matchWorkspaceDestinationRoute(ref.params.workspacePathname ?? '')?.routeKey === 'session/[id]/info');
}

/** Session-owned destinations keep the same privacy address across chat and detail panes. */
export function readDestinationSessionAddress(ref: DestinationRef): Readonly<{ sessionId: string; serverId: string | null }> | null {
    const sessionOwned = ref.kind === 'session' || ref.kind === 'sessionDetails'
        || (ref.kind === SESSIONS_DESTINATION_ID
            && matchWorkspaceDestinationRoute(ref.params.workspacePathname ?? '')?.routeKey.startsWith('session/[id]/'));
    return sessionOwned && ref.params.id
        ? { sessionId: ref.params.id, serverId: ref.params.serverId ?? null } : null;
}

function isApprovalInstanceRef(ref: DestinationRef): boolean {
    return ref.kind === 'inbox'
        && matchWorkspaceDestinationRoute(ref.params.workspacePathname ?? '')?.routeKey === 'inbox/approvals/[id]';
}

function readSettingsEntityTitleDemand(ref: DestinationRef) {
    if (ref.kind !== 'settings') return null;
    const route = matchWorkspaceDestinationRoute(`/settings/${ref.params.pageId ?? ''}`);
    if (route?.routeKey === 'settings/providers/[connectionId]') return { kind: 'provider' as const, id: route.params.connectionId!, serverId: ref.params.serverId };
    if (route?.routeKey === 'settings/profiles/[profileId]') return { kind: 'profile' as const, id: route.params.profileId!, serverId: ref.params.serverId };
    // This route's serverId is the MCP entity, not a Home qualifier.
    if (route?.routeKey === 'settings/mcp/[serverId]') return { kind: 'mcp' as const, id: route.params.serverId!, serverId: undefined };
    return null;
}

function resolveSettingsEntityInstanceTitle(ref: DestinationRef, state: ReturnType<typeof readRegisteredStorageState>): string | null {
    const demand = readSettingsEntityTitleDemand(ref);
    if (!demand || !state?.profileScope) return null;
    const scope = state.profileScope;
    if (demand.serverId && !areServerProfileIdentifiersEquivalent(scope.serverId, demand.serverId)) return t('common.unavailable');
    if (demand.kind === 'provider') {
        const snapshot = getProviderCatalogSnapshot(scope);
        const connection = snapshot?.data?.connections.find(row => row.id === demand.id);
        if (connection && snapshot?.data) return presentProviderConnectionIdentity(describeAccountProviderConnectionV1(
            // Destination titles are Account-only and never pick a Machine to resolve a name.
            composeProviderSettingsV1(snapshot.data, {}), connection, readAccountProviderDeclarations({ kind: 'account' }),
        )).title;
        return snapshot && snapshot.status !== 'loading' ? t('common.unavailable') : null;
    }
    if (demand.kind === 'profile') {
        const snapshot = getProfileCatalogSnapshot(scope);
        const profile = (snapshot && readUiProfileCatalogSnapshot(snapshot).profiles.find(row => row.id === demand.id))
            ?? getBuiltInProfile(demand.id);
        if (profile) return getProfileDisplayName(projectAiLaunchProfileForLegacyUi(profile));
        return snapshot && snapshot.catalog.status !== 'loading' ? t('common.unavailable') : null;
    }
    const snapshot = getMcpServerCatalogSnapshot(scope);
    const server = snapshot.value?.servers.find(row => row.id === demand.id);
    return server ? mcpServerDisplayName(server) : snapshot.status !== 'loading' ? t('common.unavailable') : null;
}

function subscribeSettingsEntityTitles(listener: () => void): () => void {
    const disposers = [subscribeProfileCatalogSnapshots(listener), subscribeProviderCatalogSnapshots(listener), subscribeMcpServerCatalogSnapshots(listener)];
    return () => disposers.forEach(dispose => dispose());
}

/** A built-in Workflow is a protocol catalog entry, never an Account artifact: its tab names the entry. */
function resolveBuiltinWorkflowTitle(ref: DestinationRef): string | null {
    if (ref.kind !== 'workflow' || !ref.params.id) return null;
    const entry = BUILTIN_WORKFLOW_CATALOG_V1.find((candidate) => candidate.id === ref.params.id);
    return entry ? tLoose(entry.titleKey) : null;
}

/** Absence is settled by a retirement or a complete owner census, never a scoped cache miss. */
function resolveKnownMissingInstanceTitle(ref: DestinationRef, state: ReturnType<typeof readRegisteredStorageState>): string | null {
    if (!state?.profileScope || (ref.params.serverId
        && !areServerProfileIdentifiersEquivalent(state.profileScope.serverId, ref.params.serverId))) return null;
    if (isSessionTitleRef(ref) && ref.params.id
        && !selectSessionDisplayNameSource(state, ref.params.id, ref.params.serverId ?? state.profileScope.serverId)
        && isSessionRetiredForServer(state.deletedSessionIds, ref.params.id, ref.params.serverId ?? state.profileScope.serverId)) {
        return t('errors.sessionDeleted');
    }
    if (ref.kind === 'project' && ref.params.workspaceRefId) {
        const rows = readCurrentProjectAccountRows(state);
        const resolution = resolveWorkspaceRefById(readProjectWorkspaceRefs(state), ref.params.workspaceRefId, ref.params.serverId);
        return resolution.kind !== 'resolved' && resolution.kind !== 'ambiguous' && isProjectAccountRowsCensusComplete(rows)
            ? t('projects.detail.notFoundTitle') : null;
    }
    if ((ref.kind === 'workflow' || ref.kind === 'artifacts') && ref.params.id && !resolveBuiltinWorkflowTitle(ref)
        && !state.artifacts[ref.params.id] && state.artifactsLoaded) {
        return t(ref.kind === 'artifacts' ? 'artifacts.notFound' : 'common.unavailable');
    }
    return null;
}

/** Retained tabs read the same Account projections as their pages, without mounting page effects. */
function resolveStoredInstanceTitle(ref: DestinationRef, state: ReturnType<typeof readRegisteredStorageState>, fallbackTitle?: string | null): string | null {
    if (readSettingsEntityTitleDemand(ref)) return resolveSettingsEntityInstanceTitle(ref, state);
    if (!state?.profileScope || (ref.params.serverId
        && !areServerProfileIdentifiersEquivalent(state.profileScope.serverId, ref.params.serverId))) return null;
    if (isApprovalInstanceRef(ref) && ref.params.id) {
        const artifact = state.artifacts[ref.params.id];
        if (!artifact) return null;
        if (!artifact.isDecrypted) return t('common.unavailable');
        if (!isApprovalArtifactKindV1(artifact.header?.kind)) return null;
        const parsed = typeof artifact.body === 'string' ? approvalArtifactBodyMatchesHeaderV1(artifact.header ?? {}, artifact.body) : null;
        const title = resolveApprovalRequestTitle(readApprovalArtifactTitleInput(artifact, parsed, artifact.sessions ?? [])).title;
        const status = ApprovalRequestV2StatusSchema.safeParse(readApprovalArtifactDisplayStatus(artifact));
        return status.success ? `${title} · ${formatApprovalStatusLabel(status.data)}` : title;
    }
    if (ref.kind === 'workflowRun' && ref.params.runId) {
        if (readWorkflowRunTarget(ref.params)?.kind !== 'managed') return fallbackTitle ?? t('workflows.run.title');
        const scope = state.profileScope;
        const inScope = scope && (!ref.params.serverId || areServerProfileIdentifiersEquivalent(ref.params.serverId, scope.serverId));
        const run = inScope ? state.workflowRunsById[workflowRunStoreKey(ref.params.runId, scope)] : undefined;
        return run ? formatWorkflowRunDisplayName(resolveWorkflowRunDisplayName(run.metadata))
            : fallbackTitle ?? formatWorkflowRunDisplayName(resolveWorkflowRunDisplayName(null));
    }
    const builtinWorkflowTitle = resolveBuiltinWorkflowTitle(ref);
    if (builtinWorkflowTitle) return builtinWorkflowTitle;
    if ((ref.kind === 'workflow' || ref.kind === 'artifacts') && ref.params.id) {
        const artifact = state.artifacts[ref.params.id];
        if (artifact) return artifact.isDecrypted ? artifact.title ?? t('common.unavailable') : t('common.unavailable');
        return null;
    }
    return null;
}

/**
 * The live title of each open destination instance (workspace lab T: "its title comes from the
 * destination"): a session's current name, a Details target's own name, a settings page or plugin
 * page title. One resolver for every tab bar, keyed by the caller's tab key; a key is absent when the
 * instance is unknown/unavailable. Unnamed registered destinations use an honest
 * category fallback until live data or their page can name them.
 * Project names and page/checkout qualification come from the Project display owners.
 */
export function useDestinationInstanceTitles(
    catalog: readonly CompactAppDestination[],
    entries: readonly DestinationInstanceTitleEntry[],
): ReadonlyMap<string, string> {
    const workspace = useOptionalWorkspaceNavigation();
    const accountLifetime = useActiveServerAccountScopeLifetime();
    const settingsDemands = entries.map(entry => readSettingsEntityTitleDemand(entry.ref));
    const hasProviders = settingsDemands.some(demand => demand?.kind === 'provider');
    const hasProfiles = settingsDemands.some(demand => demand?.kind === 'profile');
    const hasMcp = settingsDemands.some(demand => demand?.kind === 'mcp');
    const subscribeTitles = React.useCallback((listener: () => void) => hasProviders || hasProfiles || hasMcp
        ? subscribeSettingsEntityTitles(listener) : () => {}, [hasProviders, hasProfiles, hasMcp]);
    const readSettingsTitles = React.useCallback(() => JSON.stringify(entries.map(entry => resolveSettingsEntityInstanceTitle(
        entry.ref, readRegisteredStorageState(),
    ))), [entries, accountLifetime]);
    const settingsTitlesKey = React.useSyncExternalStore(subscribeTitles, readSettingsTitles, readSettingsTitles);
    const settingsTitles = React.useMemo(() => JSON.parse(settingsTitlesKey) as readonly (string | null)[], [settingsTitlesKey]);
    React.useEffect(() => {
        if (!accountLifetime?.isCurrent()) return;
        const disposers: (() => void)[] = [];
        let disposed = false;
        const scope = accountLifetime.scope;
        fireAndForget(Promise.all([
            hasProviders ? import('@/sync/engine/settings/providerCatalogEngine').then(owner => owner.observeProviderCatalog) : null,
            hasProfiles ? import('@/sync/engine/settings/profileCatalogEngine').then(owner => owner.observeProfileCatalog) : null,
            hasMcp ? import('@/sync/engine/settings/mcpServerCatalogEngine').then(owner => owner.observeMcpServerCatalog) : null,
        ]).then(owners => {
            if (disposed || !accountLifetime.isCurrent()) return;
            for (const observe of owners) if (observe) disposers.push(observe(scope));
        }), { tag: 'Workspace.settingsTitles' });
        return () => { disposed = true; disposers.forEach(dispose => dispose()); };
    }, [accountLifetime, hasProviders, hasProfiles, hasMcp]);
    const hasProjects = entries.some(entry => entry.ref.kind === 'project');
    const workspaceRefs = getStorage()(state => hasProjects ? readProjectWorkspaceRefs(state) : EMPTY_WORKSPACE_REFS);
    const storedTitles = getStorage()(useShallow(state => entries.map(entry => resolveStoredInstanceTitle(
        entry.ref, state, resolveSavedInstanceTitle(catalog, entry.ref, entry.fallbackTitle),
    ))));
    const missingTitles = getStorage()(useShallow(state => entries.map(entry => resolveKnownMissingInstanceTitle(entry.ref, state))));
    const unreadRunIdsKey = getStorage()(state => JSON.stringify([...new Set(entries.flatMap(entry => {
        const { ref } = entry;
        if (ref.kind !== 'workflowRun' || readWorkflowRunTarget(ref.params)?.kind !== 'managed' || !ref.params.runId || !state.profileScope
            || (ref.params.serverId && !areServerProfileIdentifiersEquivalent(ref.params.serverId, state.profileScope.serverId))
            || state.workflowRunsById[workflowRunStoreKey(ref.params.runId)]) return [];
        return [ref.params.runId];
    }))].sort()));
    React.useEffect(() => {
        if (unreadRunIdsKey === '[]' || !accountLifetime?.isCurrent()) return;
        // Restored chrome demands only the existing Account summary projection. It never
        // mounts an inactive page or reads its definition, usage or invocation history.
        fireAndForget(import('@/sync/engine/workflows/refreshWorkflowRun').then(owner => {
            if (!accountLifetime.isCurrent()) return;
            const runIds = JSON.parse(unreadRunIdsKey) as string[];
            return owner.refreshWorkflowRunSummaries(runIds.map(runId => ({ runId })));
        }), { tag: 'Workspace.runTitles' });
    }, [accountLifetime, unreadRunIdsKey]);
    const sessionEntries = React.useMemo(() => entries.filter((entry) => isSessionTitleRef(entry.ref)
        && typeof entry.ref.params.id === 'string' && entry.ref.params.id.length > 0), [entries]);
    const addresses = React.useMemo(() => sessionEntries.map((entry) => ({
        sessionId: entry.ref.params.id!, serverId: entry.ref.params.serverId ?? null,
    })), [sessionEntries]);
    const sessionTitles = useSessionDisplayNameProjections(addresses, sessionDisplayTitle);
    // A restored tab's page is not mounted, so its Session is named from content nobody has demanded yet.
    const activeServerId = useActiveServerSnapshot(addresses.some(address => !address.serverId)).serverId;
    const demandedSessions = React.useMemo(() => addresses.flatMap(address => {
        const demanded = normalizeSessionAddress(address.serverId ?? activeServerId, address.sessionId);
        return demanded ? [demanded] : [];
    }), [addresses, activeServerId]);
    useSessionContentDemand(demandedSessions, { tag: 'workspace.hydrateSessionTabs', hydrate: 'unsettled' });
    const discussionEntries = React.useMemo(() => entries.flatMap(entry => {
        if (entry.ref.kind === DISCUSSIONS_DESTINATION_ID && entry.ref.params.discussionId) {
            return [{ key: entry.key, serverId: entry.ref.params.serverId ?? null, discussionId: entry.ref.params.discussionId }];
        }
        if (entry.ref.kind !== 'sessionDetails' || !entry.ref.params.id) return [];
        const details = parseSessionPaneUrlState(entry.ref.params)?.details;
        return details?.kind === 'discussion' ? [{ key: entry.key, serverId: entry.ref.params.serverId ?? null,
            discussionId: details.discussionId }] : [];
    }), [entries]);
    const discussionTitles = useDiscussionTitleProjections(discussionEntries);
    return React.useMemo(() => {
        const titles = new Map<string, string>();
        for (const [index, entry] of entries.entries()) {
            const published = workspace?.destinationTitles?.[entry.instanceKey ?? entry.key];
            const fallback = resolvePublishedOrStaticInstanceTitle(catalog, entry.ref, { publishedTitle: published, fallbackTitle: entry.fallbackTitle }, settingsTitles[index] ?? storedTitles[index]);
            const title = entry.ref.kind === 'project'
                ? resolveProjectInstanceTitle(entry.ref, workspaceRefs) ?? fallback
                : fallback;
            if (title) titles.set(entry.key, title);
        }
        sessionEntries.forEach((entry, index) => {
            const name = sessionTitles[index];
            if (!name) return;
            // A Details tab names its target; a session tab names the session.
            titles.set(entry.key, name);
        });
        discussionEntries.forEach((entry, index) => {
            const name = discussionTitles[index];
            if (name) titles.set(entry.key, name);
        });
        entries.forEach((entry, index) => {
            const missing = missingTitles[index];
            if (missing) titles.set(entry.key, missing);
        });
        return titles;
    }, [catalog, entries, storedTitles, missingTitles, settingsTitles, workspaceRefs, sessionEntries, sessionTitles, discussionEntries, discussionTitles, workspace?.destinationTitles]);
}
