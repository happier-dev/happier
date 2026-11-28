import * as React from 'react';
import { BULK_SESSION_COMPOSE_PATHNAME } from '@/components/sessions/bulkCompose/bulkSessionComposeRoute';
import { reconcilePluginUiProjectionValue } from '@/sync/domains/plugins/ui/projection';
import { workflowRunStoreKey } from '@/sync/store/domains/workflowRuns';
import { readWorkflowRunTarget } from '@/sync/domains/workflows/workflowRunRoute';
import { shallow } from 'zustand/shallow';
import { stripGroupSegmentsFromPath } from 'expo-router/build/matchers';
import { parseQueryParams } from 'expo-router/build/fork/getStateFromPath-forks';
import { useOpenAppSection } from '@/components/appShell/workspace/destinationRoute';
import { normalizeProjectPage, resolveProjectCockpitRouteFromPathname } from '@/components/workspaceCockpit/project/projectCockpitState';
import { SERVICES_ROUTE } from '@/components/projects/deployments/deploymentNavigation';
import { readProjectRouteWorktreeSelection, resolveProjectRouteHeaderTitle } from '@/components/projects/detail/projectRouteState';
import { projectPageLabel } from '@/components/projects/shell/ProjectShellHeader';
import { resolveWorkspaceRefById } from '@/sync/domains/workspaces/workspaceRefs';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import { readRegisteredStorageState } from '@/sync/domains/state/storageStateReaderBridge';
import type { DocumentTabTitleSource } from '@/components/ui/navigation/DocumentTabStrip';
import { EMPTY_WORKSPACE_REFS, readProjectWorkspaceRefs, readCurrentProjectAccountRows, isProjectAccountRowsCensusComplete } from '@/sync/store/domains/projectAccountRows';
import { isSessionRetiredForServer } from '@/sync/store/domains/sessions';
import type {
    PluginUiDestinationPlacementV1,
    PluginUiDestinationReferenceV1,
} from '@happier-dev/protocol/plugins/ui';

import {
    useAppShellPluginUiProjection,
    type AppShellPluginUiDeclarationSources,
} from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { isAppShellPluginCatalogPending } from '@/components/appShell/plugins/projectionAvailability';
import { createPluginLocalizedTextResolver, type PluginUiTranslationRuntime } from '@/sync/domains/plugins/ui/i18n';
import { readCurrentAppShellPluginUiTranslationRuntime, subscribeCommittedAppShellPluginUiProjection } from '@/components/appShell/plugins/committedPluginUiProjection';
import { getPreferredLanguage } from '@/text/preferredLanguage';
import type { SupportedLanguage } from '@/text/_all';
import {
    resolvePluginPages,
    resolvePluginPageView,
    selectPluginPagePlacements,
    type PluginPage,
} from '@/components/plugins/pages/pluginPages';
import { usePluginPageCatalogActivationHandler } from '@/components/plugins/pages/pluginPageNavigation';
import { buildPluginAppPageRoutePath, parsePluginAppPageRoutePath, readPluginAppPageRouteView } from '@/components/plugins/pages/pluginPageRoute';
import { buildPluginSurfaceDestinationId } from '@/components/plugins/surfaces/pluginSurfaceDestinations';
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
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { normalizeSessionAddress } from '@/sync/domains/session/sessionAddress';
import { useSessionContentDemand } from '@/sync/domains/session/useSessionContentDemand';
import type { KeyboardCommandId } from '@/keyboard/types';
import { selectPluginRightSidebarTabPlacements } from '@/sync/domains/plugins/ui/surfacePlacementSelectors';
import { getStorage, selectSessionDisplayNameSource, useActiveServerAccountScopeLifetime } from '@/sync/domains/state/storage';
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
import { createSessionPaneDetailsTab, parseSessionPaneUrlState, serializeSessionPaneUrlState, SESSION_PANE_URL_PARAM_KEYS } from '@/components/sessions/panes/url/sessionPaneUrlState';
import { isSessionDetailsWorkspacePath, resolveSessionRoutePathForSurface } from '@/components/workspaceCockpit/session/sessionCockpitState';
import { resolveSettingsRouteTitleKey } from '@/components/settings/navigation/settingsRouteRegistry';
import { readSessionDisplayTitle, sessionDisplayTitle } from '@/utils/sessions/sessionDisplayTitle';
import { readDiscussionTitle, useDiscussionTitleProjections } from '@/sync/ops/discussions/useDiscussionRepositorySnapshot';
import { matchWorkspaceDestinationRoute, registeredWorkspaceRoutes, workspacePluginAppPageRouteKey, workspaceRouteHref } from '@/components/appShell/workspace/workspaceRoutes';
import { useWorkspaceDestinationTitles, type WorkspaceDestinationTitle } from '@/components/appShell/workspace/WorkspaceNavigationContext';
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
import { isArtifactInventoryLoaded } from '@/sync/domains/artifacts/artifactInventory';
import { readSessionRecordingVisibility, subscribeSessionRecordingVisibility } from '@/sync/store/sessionRecordingVisibility';

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
export const BUILTIN_APP_SHELL_COLUMN_IDS = ['sessions', 'discussions', 'projects', 'workflows', 'boards', 'plugins', 'settings', 'machines', 'services', 'reviews'] as const;
export type BuiltinAppShellColumnId = typeof BUILTIN_APP_SHELL_COLUMN_IDS[number];

export function isBuiltinAppShellColumnId(value: string): value is BuiltinAppShellColumnId {
    return (BUILTIN_APP_SHELL_COLUMN_IDS as readonly string[]).includes(value);
}

/**
 * The columns another destination may be placed in. Settings is not one: settings contributions are
 * settings pages, with the Settings catalog as their one owner. Workflows is not one either: its
 * column lists workflow sections from their own owners (FIN 04 §3.3), not other destinations. Nor is
 * Boards: its column lists the user's boards (INT §5.1). Nor is Machines: its column is the machine
 * list (plan machine-resources 10 §4.2). Nor is Services: its column is the Projects with their Environments (lab pfc-redesign).
 * Reviews likewise owns its project-grouped Review rows (Reviews plan 04 U3).
 */
const UNPLACEABLE_APP_SHELL_COLUMNS = ['settings', 'workflows', 'boards', 'machines', 'services', 'reviews'] as const satisfies readonly BuiltinAppShellColumnId[];
export type PlaceableAppShellColumnId = Exclude<BuiltinAppShellColumnId, typeof UNPLACEABLE_APP_SHELL_COLUMNS[number]>;

const UNPLACEABLE_APP_SHELL_COLUMN_IDS: ReadonlySet<string> = new Set(UNPLACEABLE_APP_SHELL_COLUMNS);

function isPlaceableAppShellColumnId(value: string): value is PlaceableAppShellColumnId {
    return isBuiltinAppShellColumnId(value) && !UNPLACEABLE_APP_SHELL_COLUMN_IDS.has(value);
}

export type AppDestinationRailRegion = 'app' | 'plugins' | 'account';

/**
 * The rail's bands (owner Q8, 2026-10-30): visual separation only, no labels, the same icons. The app's
 * own destinations stand in Work, Together and Library; plugin destinations and the account keep their
 * regions. Personal order and placement stay with the rail's customizer.
 */
export type AppRailBand = 'work' | 'together' | 'library' | 'plugins' | 'account';

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
    /**
     * Contextual (owner Q3, 2026-10-30): a plugin destination that did not ask for the rail. It is listed
     * like any other (its route, the command palette, the entry points where it belongs) but navigation
     * surfaces leave it off until the person pins it.
     */
    contextual?: true;
    /** The host-built route of the destination's own page. */
    routePath: string;
}>;

export type CompactAppDestinationSignal = 'inboxCount' | 'deploymentAttentionCount';

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
    /**
     * Its other top-level pages, drawn as main screens like its own route (a phone's Home line and bar, no Back): the
     * pages its column lists beside its route, never a record it opens (Machines' fleet Updates and Activity, lab
     * rdMach-fUpdp/fActp).
     */
    mainScreenRoutePaths?: readonly string[];
    /** The keyboard command that also opens it, shown beside its title. */
    shortcut?: KeyboardCommandId;
    /** A live count the rail marks on its icon, read only by that badge's own leaf. */
    signal?: CompactAppDestinationSignal;
    /** Offered by the command palette before anything is typed. */
    suggested?: true;
    /** Its rail band, for an app-region destination. */
    band?: Extract<AppRailBand, 'work' | 'together' | 'library'>;
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
    badge?: PluginPage['badge'];
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
    search?: boolean;
    /** The Workflows destination is discoverable (`useWorkflowsDestinationAccess`). */
    workflows: boolean;
    friends: boolean;
    bots?: boolean;
    botsRoster?: boolean;
}>;

/** A placement as requested: by an author, or by a built-in row. */
type RequestedAppDestinationPlacement =
    | Readonly<{ kind: 'rail'; region: AppDestinationRailRegion }>
    | Readonly<{ kind: 'column'; column: string }>;

type BuiltinDestinationRow = Readonly<{
    contextual?: true;
    id: string;
    titleKey: TranslationKeyNoParams;
    icon: IconName;
    placement: RequestedAppDestinationPlacement;
    column?: BuiltinAppShellColumnId;
    activation: 'navigate' | 'overlay' | 'botsRoster';
    routePath: string;
    currentRoutePatterns?: readonly string[];
    mainScreenRoutePaths?: readonly string[];
    shortcut?: KeyboardCommandId;
    signal?: CompactAppDestinationSignal;
    suggested?: true;
    railControl?: 'footer';
    band?: CompactAppBuiltinDestination['band'];
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
    // Work (owner Q8): where the person's own work starts and comes back.
    {
        id: SESSIONS_DESTINATION_ID, titleKey: 'tabs.sessions', icon: 'chats-circle',
        placement: { kind: 'rail', region: 'app' }, band: 'work', column: 'sessions', activation: 'navigate', routePath: '/',
        currentRoutePatterns: ['/session/[...rest]'], suggested: true,
    },
    {
        id: SEARCH_DESTINATION_ID, titleKey: 'tools.names.search', icon: 'magnifying-glass',
        shortcut: 'commandPalette.open',
        placement: { kind: 'rail', region: 'app' }, band: 'work', activation: 'overlay', routePath: UNIVERSAL_SEARCH_ROUTE,
        available: (availability) => availability.search === true,
    },
    {
        id: 'inbox', titleKey: 'tabs.inbox', icon: 'tray', placement: { kind: 'rail', region: 'app' }, band: 'work',
        activation: 'navigate', routePath: '/inbox', currentRoutePatterns: ['/inbox/[...rest]'], signal: 'inboxCount',
        available: (availability) => availability.inbox,
    },
    {
        id: 'projects', titleKey: 'tabs.projects', icon: 'folder', placement: { kind: 'rail', region: 'app' }, band: 'work',
        column: 'projects', activation: 'navigate', routePath: '/projects', signal: 'deploymentAttentionCount', currentRoutePatterns: ['/projects/[...rest]'],
    },
    {
        id: 'workflows', titleKey: 'workflows.title', icon: 'tree-structure',
        placement: { kind: 'rail', region: 'app' }, band: 'work', column: 'workflows',
        activation: 'navigate', routePath: '/workflows',
        // The Automation pages that still exist (a legacy trigger's page, its runs, the create and
        // edit forms) open inside Workflows until the trigger popover and the run route target
        // replace them and their routes become redirect-only (FIN 04 §3.2).
        currentRoutePatterns: ['/workflows/[...rest]', '/automations', '/automations/[...rest]'],
        available: (availability) => availability.workflows,
    },
    // Together: the people and agents the person works with.
    {
        id: DISCUSSIONS_DESTINATION_ID, titleKey: 'session.collaboration.discussion.title', icon: 'chat-circle',
        placement: { kind: 'rail', region: 'app' }, band: 'together', column: 'discussions', activation: 'navigate', routePath: '/discussions',
        currentRoutePatterns: ['/discussions/[...rest]'],
        workspaceNavigationIdentity: { resourceParam: 'discussionId', scopeParams: ['serverId'] },
        available: (availability) => availability.discussions === true,
    },
    {
        id: 'friends', titleKey: 'tabs.friends', icon: 'users', placement: { kind: 'rail', region: 'app' }, band: 'together',
        activation: 'navigate', routePath: '/friends', currentRoutePatterns: ['/friends/[...rest]'],
        available: (availability) => availability.friends,
    },
    // Last of Together, its rail-pinned Bots right under it (lab `b-rail A`).
    {
        id: 'bots', titleKey: 'bots.title', icon: BOTS_GLYPH,
        placement: { kind: 'rail', region: 'app' }, band: 'together', activation: 'botsRoster', routePath: '/',
        available: availability => availability.bots === true,
        activationAvailable: availability => availability.botsRoster === true,
    },
    // Services (pfc-redesign): everything the Account runs, as views, beside its column of Projects and their
    // Environments; an Environment page and every page under Services (a Check) keep that column (lab `sideSvc`).
    // Overflow/pinning policy unchanged (owner 11-12).
    {
        id: 'deployments', titleKey: 'projects.deployments.services.title', icon: 'rocket-launch',
        placement: { kind: 'rail', region: 'app' }, band: 'library', column: 'services', activation: 'navigate',
        routePath: SERVICES_ROUTE, currentRoutePatterns: ['/deployments/[projectSourceId]', `${SERVICES_ROUTE}/[...rest]`],
        signal: 'deploymentAttentionCount',
    },
    // Monitoring (MONITOR-LAB-1115 B): whether everything the Account runs is up, beside Services. Its rows are the
    // saved Checks; a Check's page stays a Services page.
    {
        id: 'monitoring', titleKey: 'projects.deployments.monitoring.title', icon: 'pulse',
        placement: { kind: 'rail', region: 'app' }, band: 'library', activation: 'navigate',
        routePath: '/monitoring', currentRoutePatterns: ['/monitoring/[...rest]'],
    },
    // Library: what the person keeps.
    {
        // Live sessions, runs, workflows and machines, arranged by the user (INT §5.1).
        id: 'boards', titleKey: 'boards.title', icon: 'squares-four',
        placement: { kind: 'rail', region: 'app' }, band: 'library', column: 'boards',
        activation: 'navigate', routePath: '/boards', currentRoutePatterns: ['/boards/[...rest]'],
    },
    {
        // Everything saved to the Account Artifact store, as one browser page (RU2 §9.6).
        id: 'artifacts', titleKey: 'artifacts.title', icon: 'files',
        placement: { kind: 'rail', region: 'app' }, band: 'library',
        activation: 'navigate', routePath: '/artifacts', currentRoutePatterns: ['/artifacts/[...rest]'],
    },
    {
        id: 'reviews', titleKey: 'homeSettings.groups.reviews', icon: 'check-square',
        placement: { kind: 'rail', region: 'app' }, band: 'library', column: 'reviews',
        activation: 'navigate', routePath: '/reviews', currentRoutePatterns: ['/reviews/[...rest]'],
    },
    {
        // The bulk composer's page (opened from a selection, never from navigation): catalogued only so its tab
        // and title read as Compose beside the Sessions column instead of as a session.
        id: 'sessions.compose', titleKey: 'session.participants.bulk.pageTitle', icon: 'pencil-simple',
        placement: { kind: 'column', column: 'sessions' }, activation: 'navigate',
        routePath: BULK_SESSION_COMPOSE_PATHNAME, visibility: 'hidden',
    },
    {
        id: BROWSE_EXISTING_SESSIONS_DESTINATION_ID, titleKey: 'externalSessions.browseOpenExisting', icon: 'folder-open',
        placement: { kind: 'column', column: 'sessions' }, activation: 'navigate', routePath: '/external/browse',
        available: (availability) => availability.externalSessions,
    },
    {
        // Heads the plugins region: where plugins are installed and found. Plugin-contributed pages
        // under `/plugins/<pluginId>/…` are their own destinations.
        id: PLUGINS_DESTINATION_ID, titleKey: 'settingsPlugins.surfaces.storeTitle', icon: PLUGINS_SURFACE_ICON,
        placement: { kind: 'rail', region: 'plugins' }, column: 'plugins', activation: 'navigate',
        routePath: PLUGINS_APP_ROUTE, currentRoutePatterns: PLUGINS_APP_PAGE_PATTERNS,
    },
    {
        id: 'store.bots', titleKey: 'bots.title', icon: BOTS_GLYPH,
        placement: { kind: 'column', column: 'plugins' }, activation: 'navigate',
        routePath: '/plugins/bots', contextual: true,
    },
    {
        // One Machines page with two doors (R1): this rail door opens it beside the machine list, without
        // the Settings column; Settings → Machines is the other door. The rail's footer Machines icon is
        // this destination's control (its popover), so no second rail icon is drawn. Presets is a record table the page
        // opens, not a fleet page: a phone keeps its Back to Machines (round 18).
        id: 'machines', titleKey: 'settings.machines', icon: 'desktop', placement: { kind: 'rail', region: 'account' },
        column: 'machines', activation: 'navigate', routePath: '/machines',
        currentRoutePatterns: ['/machines/[...rest]'], mainScreenRoutePaths: ['/machines/updates', '/machines/activity'], railControl: 'footer',
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
            currentRoutePatterns: [`/${routeKey}`],
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

/**
 * A plugin asks for the rail or a column. Without a placement it is contextual (owner Q3): listed in
 * the plugins region, so the person can pin it, but not shown there until they do.
 */
function resolvePluginPlacement(requested: PluginUiDestinationPlacementV1 | undefined): Readonly<{
    placement: AppDestinationPlacement;
    contextual?: true;
}> {
    return {
        placement: resolvePlacement(requested?.kind === 'column' ? requested : { kind: 'rail', region: 'plugins' }, 'plugins'),
        ...(requested === undefined ? { contextual: true as const } : {}),
    };
}

/** The rail band a destination stands in (owner Q8). */
export function resolveAppRailBand(destination: CompactAppDestination): AppRailBand {
    if (destination.kind === 'builtin' && destination.band !== undefined) return destination.band;
    return destination.placement.kind === 'rail' && destination.placement.region === 'account' ? 'account' : 'plugins';
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
    baseline?: readonly CompactAppDestination[];
    builtins: AppBuiltinDestinationAvailability;
    pages: readonly PluginPage[];
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
            ...(row.contextual === undefined ? {} : { contextual: row.contextual }),
            ...(row.column === undefined ? {} : { column: row.column }),
            ...(row.currentRoutePatterns === undefined ? {} : { currentRoutePatterns: row.currentRoutePatterns }),
            ...(row.mainScreenRoutePaths === undefined ? {} : { mainScreenRoutePaths: row.mainScreenRoutePaths }),
            ...(row.shortcut === undefined ? {} : { shortcut: row.shortcut }),
            ...(row.signal === undefined ? {} : { signal: row.signal }),
            ...(row.suggested === undefined ? {} : { suggested: row.suggested }),
            ...(row.railControl === undefined ? {} : { railControl: row.railControl }),
            ...(row.band === undefined ? {} : { band: row.band }),
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
            ...resolvePluginPlacement(page.requestedPlacement),
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
            ...resolvePluginPlacement(tab.requestedPlacement),
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
    const previousById = new Map(input.baseline?.map(row => [row.id, row]));
    const ordered = destinations.sort(compare).map((destination, order) =>
        reconcilePluginUiProjectionValue(previousById.get(destination.id), Object.freeze({ ...destination, order })));
    return input.baseline && input.baseline.length === ordered.length && ordered.every((row, index) => row === input.baseline?.[index])
        ? input.baseline : Object.freeze(ordered);
}

export type CompactAppDestinationSources = Pick<AppShellPluginUiDeclarationSources, 'projection' | 'accountLifetime' | 'ready'> & Readonly<{
    locale: SupportedLanguage;
    builtins: AppBuiltinDestinationAvailability;
}>;

type CompactDestinationVariant = {
    destinations: readonly CompactAppDestination[];
    published: boolean;
    builtins: AppBuiltinDestinationAvailability;
    listeners: Set<() => void>;
};

type CompactDestinationPublication = {
    source: CompactAppDestinationSources;
    prepared: Readonly<{
        pages: readonly PluginPage[];
        rightSidebarTabs: readonly RightSidebarPluginTabDefinition[];
    }> | null;
    variants: Map<number, CompactDestinationVariant>;
    lastDestinations: readonly CompactAppDestination[];
    retirement: Readonly<{ dispose(): void }> | null;
    demandedPlugins: Set<string>;
    translationRuntime: PluginUiTranslationRuntime | null;
    releaseTranslations: (() => void) | null;
    releaseCopyOwner: (() => void) | null;
};

const UNPUBLISHED_COMPACT_DESTINATIONS: readonly CompactAppDestination[] = Object.freeze([]);
const compactDestinationPublications = new Set<CompactDestinationPublication>();
let latestCompactDestinationPublication: CompactDestinationPublication | null = null;
/**
 * Each builtin variant's last published rows, per Account lifetime. A projection republish
 * starts a new publication and can prune the previous one before every variant re-subscribes;
 * the variant's own rows (not another variant's) are the baseline that keeps an equal catalog.
 */
const lastCompactDestinationsByLifetime = new WeakMap<object, Map<number, readonly CompactAppDestination[]>>();

function isCompactDestinationSourceCurrent(source: CompactAppDestinationSources): boolean {
    return source.ready && (!source.accountLifetime || source.accountLifetime.isCurrent());
}

function compactDestinationVariantKey(builtins: AppBuiltinDestinationAvailability): number {
    return Number(builtins.externalSessions) | (Number(builtins.inbox) << 1)
        | (Number(builtins.discussions === true) << 2) | (Number(builtins.workflows) << 3)
        | (Number(builtins.friends) << 4) | (Number(builtins.botsRoster === true) << 5) | (Number(builtins.bots === true) << 6)
        | (Number(builtins.search === true) << 7);
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
    if (matchingVariant !== UNPUBLISHED_COMPACT_DESTINATIONS) return matchingVariant;
    return (source.accountLifetime && lastCompactDestinationsByLifetime.get(source.accountLifetime)?.get(key)) || lastKnown;
}

/** Reads never prepare pages, sort destinations, compare rows, or publish a source. */
export function readCommittedCompactAppDestinations(source: CompactAppDestinationSources): readonly CompactAppDestination[] {
    if (!isCompactDestinationSourceCurrent(source)) return UNPUBLISHED_COMPACT_DESTINATIONS;
    return findCompactDestinationPublication(source)?.variants.get(compactDestinationVariantKey(source.builtins))?.destinations
        ?? readLastKnownCompactDestinations(source);
}

export function isCompactDestinationSourcePublished(source: CompactAppDestinationSources): boolean {
    return isCompactDestinationSourceCurrent(source)
        && findCompactDestinationPublication(source)?.variants.get(compactDestinationVariantKey(source.builtins))?.published === true;
}

function releaseCompactDestinationPublication(publication: CompactDestinationPublication): void {
    compactDestinationPublications.delete(publication);
    publication.retirement?.dispose();
    publication.releaseTranslations?.();
    publication.releaseCopyOwner?.();
    if (latestCompactDestinationPublication === publication) latestCompactDestinationPublication = null;
}

function bindCompactDestinationTranslations(publication: CompactDestinationPublication): void {
    if (!compactDestinationPublications.has(publication) || !isCompactDestinationSourceCurrent(publication.source)) return;
    const runtime = readCurrentAppShellPluginUiTranslationRuntime(publication.source.projection);
    if (runtime !== publication.translationRuntime) {
        publication.releaseTranslations?.();
        publication.translationRuntime = runtime;
        publication.releaseTranslations = runtime?.subscribe(pluginId => {
            if (!publication.demandedPlugins.has(pluginId)) return;
            publication.prepared = null;
            for (const variant of publication.variants.values()) {
                variant.published = false;
                commitCompactAppDestinationSources({ ...publication.source, builtins: variant.builtins });
            }
        }) ?? null;
    }
    const { projection, locale } = publication.source;
    if (runtime && projection) {
        for (const pluginId of publication.demandedPlugins) {
            if (runtime.matchesSource(projection, pluginId)) void runtime.demand(pluginId, locale);
        }
    }
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
            lastDestinations: UNPUBLISHED_COMPACT_DESTINATIONS, retirement: null,
            demandedPlugins: new Set(), translationRuntime: null, releaseTranslations: null, releaseCopyOwner: null };
        compactDestinationPublications.add(publication);
        const owned = publication;
        publication.releaseCopyOwner = subscribeCommittedAppShellPluginUiProjection(() => bindCompactDestinationTranslations(owned));
        publication.retirement = source.accountLifetime?.onRetire(() => {
            releaseCompactDestinationPublication(owned);
            if (owned.source.accountLifetime) lastCompactDestinationsByLifetime.delete(owned.source.accountLifetime);
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
        variant = { destinations: readLastKnownCompactDestinations(source), published: false, builtins: source.builtins, listeners: new Set() };
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
        const resolve = createPluginLocalizedTextResolver({ projection, locale: source.locale,
            runtime: readCurrentAppShellPluginUiTranslationRuntime(projection) });
        const localize = (pluginId: string, value: unknown) => {
            if (typeof value === 'object' && value !== null && 'key' in value) publication.demandedPlugins.add(pluginId);
            return resolve(pluginId, value);
        };
        let baselinePages: readonly PluginPage[] | undefined;
        for (const previous of compactDestinationPublications) {
            if (previous.source.accountLifetime === source.accountLifetime && previous.source.locale === source.locale && previous.prepared)
                baselinePages = previous.prepared.pages;
        }
        publication.prepared = {
            pages: projection ? resolvePluginPages({ target: { kind: 'app' }, placements: selectPluginPagePlacements(projection, { container: 'appPage', targetKind: 'app' }), localize, baseline: baselinePages }) : [],
            rightSidebarTabs: projection ? resolveRightSidebarTabs({ scope: 'app',
                pluginPlacements: selectPluginRightSidebarTabPlacements(projection, 'app'),
                localize,
            }).filter(tab => tab.owner === 'plugin') : [],
        };
    }
    const previous = variant.destinations;
    variant.destinations = resolveCompactAppDestinations({
        builtins: source.builtins, ...publication.prepared, baseline: previous,
    });
    variant.published = true;
    publication.lastDestinations = variant.destinations;
    if (source.accountLifetime) {
        let remembered = lastCompactDestinationsByLifetime.get(source.accountLifetime);
        if (!remembered) lastCompactDestinationsByLifetime.set(source.accountLifetime, remembered = new Map());
        remembered.set(compactDestinationVariantKey(source.builtins), variant.destinations);
    }
    latestCompactDestinationPublication = publication;
    // The catalog is committed before acquiring copy; abandoned renders acquire nothing.
    void Promise.resolve().then(() => bindCompactDestinationTranslations(publication));
    pruneCompactDestinationPublications();
    if (previous !== variant.destinations) for (const listener of variant.listeners) listener();
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
    // A tab hands its href (query and anchor included); the route is the path alone.
    const actual = splitPath(normalizePathname(pathname.split(/[?#]/, 1)[0]!));
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

/**
 * A main screen (owner 11-10): the page is a rail destination's own route (Boards, not a board; the Store, not a
 * listing). The tab bar is its way around, so it draws no Back; a page it pushes, an entry inside a column (Browse
 * external sessions) and a route no destination claims keep theirs.
 */
export function isAppDestinationRootPath(catalog: readonly CompactAppDestination[], pathname: string): boolean {
    const current = resolveCurrentAppDestination(catalog, pathname);
    if (!current || current.placement.kind !== 'rail' || current.activation !== 'navigate') return false;
    const actual = normalizePathname(pathname.split(/[?#]/, 1)[0]!);
    return [current.routePath, ...(current.kind === 'builtin' ? current.mainScreenRoutePaths ?? [] : [])]
        .some((path) => normalizePathname(path.split('?')[0]!) === actual);
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
    // Reject before URL normalization can remove a plugin-local traversal segment.
    if (/^\/projects\/[^/]+\/plugins\//.test(href) && !resolveProjectCockpitRouteFromPathname(href)) return null;
    let url: URL;
    try {
        url = new URL(href, 'https://happier.invalid');
    } catch {
        return null;
    }
    const path = normalizePathname(url.pathname);
    const decodedParts = splitPath(path).map(decodeSegment);
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
            // The bare route reveals Details within the same retained Session instance.
            if (!details) return query.details ? null : {
                kind: 'session', params: { ...query, id: second, workspacePathname: path },
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
    if (first === 'workflows' && second && third === undefined && !['runs', 'events', 'new', 'edit', 'settings'].includes(second)) {
        return { kind: 'workflow', params: { ...query, id: second } };
    }
    if (first === 'automations' && second && third === undefined && !['settings', 'new', 'edit'].includes(second)) {
        return { kind: 'automation', params: { ...query, id: second } };
    }
    if (route && workspacePluginAppPageRouteKey(route.routeKey)) {
        // The address is known before the page declaration. The body owns the pending and unavailable states.
        const appPage = parsePluginAppPageRoutePath(href);
        if (!appPage) return null;
        const { pluginId, localId, subPath } = appPage;
        return {
            kind: buildPluginSurfaceDestinationId(pluginId, localId),
            params: { ...query, ...(subPath ? { subPath } : {}), pluginId, localId },
        };
    }
    const destination = resolveCurrentAppDestination(catalog, path);
    if (!destination || destination.activation !== 'navigate') return null;
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

/** A registered app-page address exists before its declaration is published. */
export function readWorkspacePluginAppPageAddress(ref: DestinationRef) {
    const { pluginId, localId, subPath } = ref.params;
    return pluginId && localId && ref.kind === buildPluginSurfaceDestinationId(pluginId, localId)
        ? { pluginId, localId, subPath } : null;
}

const BARE_SESSION_DETAILS_EXCLUDED_PARAMS = [
    'id', 'workspacePathname', ...SESSION_PANE_URL_PARAM_KEYS.filter(key => key !== 'right' && key !== 'bottom'),
];

/** The inverse URL projection for the focused tab's destination. */
export function hrefForDestinationRef(
    catalog: readonly CompactAppDestination[],
    ref: DestinationRef,
): string | null {
    const params = ref.params;
    if (ref.kind === 'session' && params.id && isSessionDetailsWorkspacePath(params.workspacePathname)) {
        // The pane URL mirror can hold a selected resource in the Session ref.
        // Keep the workspace address bare so re-admission preserves its identity.
        return appendQuery(`/session/${encodedSegment(params.id)}/details`, params, BARE_SESSION_DETAILS_EXCLUDED_PARAMS);
    }
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
    const appPage = readWorkspacePluginAppPageAddress(ref);
    if (appPage) {
        const path = buildPluginAppPageRoutePath(appPage);
        return appendQuery(path, params, ['pluginId', 'localId', 'subPath']);
    }
    const destination = catalog.find((item) => item.id === ref.kind && item.activation === 'navigate');
    if (!destination || destination.kind === 'plugin') return null;
    return appendQuery(destination.routePath, params, []);
}

export { useCompactAppDestinationCatalog, useCompactAppDestinations } from './useCompactAppDestinations';

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
    const navigateSection = useOpenAppSection();
    const activatePluginAppPage = usePluginPageCatalogActivationHandler(navigateSection);
    const universalSearch = useOptionalUniversalSearchRuntime();
    const openAppRightSidebarTab = useOpenAppRightSidebarTab();
    const botsRosterRuntime = useOptionalBotsRosterRuntime();
    // The owners above change with the route; the returned callback does not, so every memoized row
    // and rail icon that holds it keeps its identity across navigation.
    const latest = React.useRef({ navigateSection, activatePluginAppPage, universalSearch, openAppRightSidebarTab, botsRosterRuntime, ...activationOwners });
    latest.current = { navigateSection, activatePluginAppPage, universalSearch, openAppRightSidebarTab, botsRosterRuntime, ...activationOwners };
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
        const result = runGuardedNavigation(() => owners.navigateSection(routePath));
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
function resolveStaticInstanceTitle(ref: DestinationRef, { href, destination, presentation }: DestinationInstanceRoute): string | null {
    if (ref.kind === 'newTab') return t('workspaceBar.newTab');
    if (ref.kind === 'session' || ref.kind === 'project') return null;
    if (ref.kind === 'sessionDetails') {
        const details = parseSessionPaneUrlState(ref.params)?.details;
        return details ? createSessionPaneDetailsTab(details)?.title ?? null : null;
    }
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
    if (destination?.kind === 'plugin') return presentation?.title ?? destination.title;
    return destination && pathname === destination.routePath ? destination.title : null;
}

/** Resolve the route owner and the declared presentation of this workspace instance. */
export function resolveWorkspaceDestinationInstanceRoute(catalog: readonly CompactAppDestination[], ref: DestinationRef) {
    const href = hrefForDestinationRef(catalog, ref);
    const destination = href ? resolveCurrentAppDestination(catalog, href) : null;
    const presentation = destination?.kind === 'plugin' && destination.container === 'appPage'
        ? resolvePluginPageView(destination, catalog, destination.destination.pluginId, readPluginAppPageRouteView(ref.params.view))
        : destination;
    return { href, destination, presentation };
}

type DestinationInstanceRoute = ReturnType<typeof resolveWorkspaceDestinationInstanceRoute>;
type DestinationInstanceTitleSource = DocumentTabTitleSource & Readonly<{
    href: string | null;
    icon: IconName | undefined;
}>;

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
function resolvePublishedOrStaticInstanceTitle(
    catalog: readonly CompactAppDestination[],
    ref: DestinationRef,
    options?: DestinationInstanceTitleOptions,
    storedTitle?: string | null,
    route = resolveWorkspaceDestinationInstanceRoute(catalog, ref),
    catalogPending = false,
): string | null {
    const { href, destination } = route;
    const pathname = href?.split(/[?#]/, 1)[0];
    const redirectSource = options?.publishedTitle?.ref === ref ? options.publishedTitle.redirectSource : undefined;
    if (ref.kind === 'settings' && redirectSource?.kind === 'settings') {
        const sourceRoute = resolveWorkspaceDestinationInstanceRoute(catalog, redirectSource);
        const sourcePath = sourceRoute.href?.split(/[?#]/, 1)[0];
        const collectionTitle = resolveStaticInstanceTitle(redirectSource, sourceRoute);
        if (sourcePath && pathname?.startsWith(`${sourcePath}/`) && collectionTitle) return collectionTitle;
    }
    // Home's greeting is content, while the shell catalog calls its rail Sessions.
    if (ref.kind === SESSIONS_DESTINATION_ID && pathname === '/') return t('common.home');
    const publishParams = pathname === '/settings/plugins/publish' ? new URLSearchParams(href?.split('?')[1]) : null;
    const templatePublisher = Boolean(publishParams?.get('templateArtifactId') && publishParams.get('templateServerId'));
    const staticTitle = templatePublisher ? null : resolveStaticInstanceTitle(ref, route);
    // Collection/status headlines and automatically selected detail panels do not
    // rename their destination. Explicit entity routes have no static identity here.
    if (staticTitle && (ref.kind === 'settings'
        || (destination?.kind === 'builtin' && pathname === destination.routePath))) return staticTitle;
    // Approval tabs reuse the open page's subject-aware base while their stored lifecycle
    // owns the status suffix. A fallback publication never replaces the stored title.
    // The always-mounted strip takes no Machine subscription to resolve that subject.
    if (isApprovalInstanceRef(ref)) {
        if (storedTitle) return storedTitle;
        const savedTitle = resolveSavedInstanceTitle(catalog, ref, options?.fallbackTitle);
        if (savedTitle) return savedTitle;
    }
    const title = options?.publishedTitle?.ref === ref
        ? options.publishedTitle.title
        : staticTitle ?? storedTitle ?? resolveSavedInstanceTitle(catalog, ref, options?.fallbackTitle);
    if (title) return title;
    if (catalogPending && !destination) return t('common.loading');
    // Restored/background tabs need not mount their pages to publish a title.
    if (!href) return null;
    if (isSessionTitleRef(ref)) return t('session.untitled');
    if (ref.kind === 'settings') {
        const key = resolveSettingsRouteTitleKey(href.split(/[?#]/, 1)[0]);
        if (key) return t(key);
    }
    // An Artifact route carries no kind: until its row names it (or the census settles it missing) it names nothing,
    // never its parent "Artifacts" (G3b).
    if (ref.kind === 'artifacts' && ref.params.id) return '';
    return destination?.title ?? t('common.unavailable');
}

/**
 * The same title, read once without subscribing (a drag preview names what it carries and where it
 * lands only when the verdict changes). `null` when nothing can name it yet.
 */
export function readDestinationInstanceTitle(catalog: readonly CompactAppDestination[], ref: DestinationRef, options?: DestinationInstanceTitleOptions): string | null {
    const address = readDestinationSessionAddress(ref);
    if (address && !readSessionRecordingVisibility()(address)) return t('session.untitled');
    const state = readRegisteredStorageState();
    const missing = resolveKnownMissingInstanceTitle(ref, state);
    if (missing) return missing;
    const stored = resolveStoredInstanceTitle(ref, state, resolveSavedInstanceTitle(catalog, ref, options?.fallbackTitle), options?.publishedTitle);
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

export function isApprovalInstanceRef(ref: DestinationRef): boolean {
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

/**
 * An entity settings tab names its entity once a catalog can. Until then, and when the read failed,
 * was refused or the entity is gone, it returns null so the route's own title names the page
 * (the same title the phone header shows); "Unavailable" never names a tab.
 */
function resolveSettingsEntityInstanceTitle(ref: DestinationRef, state: ReturnType<typeof readRegisteredStorageState>): string | null {
    const demand = readSettingsEntityTitleDemand(ref);
    if (!demand || !state?.profileScope) return null;
    const scope = state.profileScope;
    if (demand.serverId && !areServerProfileIdentifiersEquivalent(scope.serverId, demand.serverId)) return null;
    if (demand.kind === 'provider') {
        const snapshot = getProviderCatalogSnapshot(scope);
        const connection = snapshot?.data?.connections.find(row => row.id === demand.id);
        if (connection && snapshot?.data) return presentProviderConnectionIdentity(describeAccountProviderConnectionV1(
            // Destination titles are Account-only and never pick a Machine to resolve a name.
            composeProviderSettingsV1(snapshot.data, {}), connection, readAccountProviderDeclarations({ kind: 'account' }),
        )).title;
        return null;
    }
    if (demand.kind === 'profile') {
        const snapshot = getProfileCatalogSnapshot(scope);
        const profile = (snapshot && readUiProfileCatalogSnapshot(snapshot).profiles.find(row => row.id === demand.id))
            ?? getBuiltInProfile(demand.id);
        if (profile) return getProfileDisplayName(projectAiLaunchProfileForLegacyUi(profile));
        return null;
    }
    const snapshot = getMcpServerCatalogSnapshot(scope);
    const server = snapshot.value?.servers.find(row => row.id === demand.id);
    return server ? mcpServerDisplayName(server) : null;
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

/** A Project tab's checkout is gone: the complete Project census no longer has it. Never a scoped cache miss. */
export function isProjectDestinationKnownGone(ref: DestinationRef, state: ReturnType<typeof readRegisteredStorageState>): boolean {
    if (ref.kind !== 'project' || !ref.params.workspaceRefId || !state?.profileScope || (ref.params.serverId
        && !areServerProfileIdentifiersEquivalent(state.profileScope.serverId, ref.params.serverId))) return false;
    const resolution = resolveWorkspaceRefById(readProjectWorkspaceRefs(state), ref.params.workspaceRefId, ref.params.serverId);
    return resolution.kind !== 'resolved' && resolution.kind !== 'ambiguous' && isProjectAccountRowsCensusComplete(readCurrentProjectAccountRows(state));
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
    if (ref.kind === 'project') return isProjectDestinationKnownGone(ref, state) ? t('projects.detail.notFoundTitle') : null;
    if ((ref.kind === 'workflow' || ref.kind === 'artifacts') && ref.params.id && !resolveBuiltinWorkflowTitle(ref)
        && !state.artifacts[ref.params.id] && isArtifactInventoryLoaded(state,
            // A generic Artifact route carries no kind; only the full census can prove its absence.
            ref.kind === 'workflow' ? ['workflow-definition.v1'] : undefined)) {
        return t(ref.kind === 'artifacts' ? 'artifacts.notFound' : 'common.unavailable');
    }
    return null;
}

/** Retained tabs read the same Account projections as their pages, without mounting page effects. */
function resolveStoredInstanceTitle(ref: DestinationRef, state: ReturnType<typeof readRegisteredStorageState>, fallbackTitle?: string | null, published?: WorkspaceDestinationTitle): string | null {
    if (readSettingsEntityTitleDemand(ref)) return resolveSettingsEntityInstanceTitle(ref, state);
    if (!state?.profileScope || (ref.params.serverId
        && !areServerProfileIdentifiersEquivalent(state.profileScope.serverId, ref.params.serverId))) return null;
    if (isApprovalInstanceRef(ref) && ref.params.id) {
        const artifact = state.artifacts[ref.params.id];
        if (!artifact) return null;
        if (!artifact.isDecrypted) return t('common.unavailable');
        if (!isApprovalArtifactKindV1(artifact.header?.kind)) return null;
        const parsed = typeof artifact.body === 'string' ? approvalArtifactBodyMatchesHeaderV1(artifact.header ?? {}, artifact.body) : null;
        const title = resolveApprovalRequestTitle({ ...readApprovalArtifactTitleInput(artifact, parsed, artifact.sessions ?? []),
            publishedTitle: published?.ref === ref && published.source === 'page' ? published
                : fallbackTitle ? { title: fallbackTitle, source: 'page' } : undefined }).title;
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

/** One tab's projection is invalidated by its own records, never an unrelated root publication. */
function createDestinationInstanceTitleProjection(catalog: readonly CompactAppDestination[], entry: DestinationInstanceTitleEntry) {
    const { ref, fallbackTitle } = entry;
    const route = resolveWorkspaceDestinationInstanceRoute(catalog, ref);
    const savedTitle = resolveSavedInstanceTitle(catalog, ref, fallbackTitle);
    const settingsDemand = readSettingsEntityTitleDemand(ref);
    const session = isSessionTitleRef(ref);
    const managedRunId = ref.kind === 'workflowRun' && readWorkflowRunTarget(ref.params)?.kind === 'managed' ? ref.params.runId : undefined;
    const artifactId = ref.kind === 'workflow' || ref.kind === 'artifacts' || isApprovalInstanceRef(ref) ? ref.params.id : undefined;
    let storeInputs: readonly unknown[] | undefined;
    let inputs: readonly unknown[] | undefined;
    let projection: ReturnType<typeof project> | undefined;
    function project(state: ReturnType<typeof readRegisteredStorageState>, source: ReturnType<typeof selectSessionDisplayNameSource> | null, published?: WorkspaceDestinationTitle) {
        return {
            stored: resolveStoredInstanceTitle(ref, state, savedTitle, published),
            missing: resolveKnownMissingInstanceTitle(ref, state),
            session: session ? sessionDisplayTitle(source) : null,
            project: ref.kind === 'project' && state ? resolveProjectInstanceTitle(ref, readProjectWorkspaceRefs(state)) : null,
        };
    }
    let settingsInputs: readonly unknown[] | undefined;
    let settingsTitle: string | null = null;
    let titleInputs: readonly unknown[] | undefined;
    let title: string | null = null;
    return {
        entry, catalog, fallbackTitle, settingsDemand, session, managedRunId, route,
        read(state: ReturnType<typeof readRegisteredStorageState>, published?: WorkspaceDestinationTitle) {
            // Producer-owned record/container identities decide whether canonical lookup is needed.
            const nextStoreInputs = [state?.profileScope, isApprovalInstanceRef(ref) ? published : null,
                artifactId ? state?.artifacts[artifactId] : null,
                managedRunId && state?.profileScope ? state.workflowRunsById[workflowRunStoreKey(managedRunId, state.profileScope)] : null,
                ref.kind === 'project' ? state?.projectAccountRows : null,
                session ? state?.sessions : null, session ? state?.sessionListRowsByServerId : null,
                session ? state?.ordinarySessionListMembershipByServerId : null, session ? state?.deletedSessionIds : null,
                artifactId ? state?.artifactsLoaded : null, artifactId ? state?.artifactBrowserLoaded : null,
                artifactId ? state?.artifactInventoryKindsLoaded : null];
            if (projection && storeInputs && shallow(storeInputs, nextStoreInputs)) return projection;
            storeInputs = nextStoreInputs;
            const source = session && ref.params.id && state ? selectSessionDisplayNameSource(state, ref.params.id, ref.params.serverId) : null;
            const projectRows = ref.kind === 'project' && state ? readCurrentProjectAccountRows(state) : null;
            const projectRef = ref.kind === 'project' && ref.params.workspaceRefId && state
                ? resolveWorkspaceRefById(readProjectWorkspaceRefs(state), ref.params.workspaceRefId, ref.params.serverId) : null;
            const nextInputs = [state?.profileScope, isApprovalInstanceRef(ref) ? published : null, artifactId ? state?.artifacts[artifactId] : null,
                managedRunId && state?.profileScope ? state.workflowRunsById[workflowRunStoreKey(managedRunId, state.profileScope)] : null,
                projectRef?.kind === 'resolved' ? projectRef.ref : projectRef?.kind, isProjectAccountRowsCensusComplete(projectRows),
                artifactId && state ? isArtifactInventoryLoaded(state, ref.kind === 'workflow' ? ['workflow-definition.v1'] : undefined) : false,
                session && state && ref.params.id ? isSessionRetiredForServer(state.deletedSessionIds, ref.params.id, ref.params.serverId ?? state.profileScope?.serverId ?? null) : false,
                ...Object.values(source ?? {})];
            if (!projection || !inputs || !shallow(inputs, nextInputs)) {
                inputs = nextInputs;
                projection = project(state, source, published);
            }
            return projection;
        },
        readSettings(state: ReturnType<typeof readRegisteredStorageState>) {
            if (!settingsDemand) return null;
            const scope = state?.profileScope;
            const nextInputs = [scope, scope ? settingsDemand.kind === 'provider' ? getProviderCatalogSnapshot(scope)
                : settingsDemand.kind === 'profile' ? getProfileCatalogSnapshot(scope) : getMcpServerCatalogSnapshot(scope) : null];
            if (!settingsInputs || !shallow(settingsInputs, nextInputs)) {
                settingsInputs = nextInputs;
                settingsTitle = resolveSettingsEntityInstanceTitle(ref, state);
            }
            return settingsTitle;
        },
        title(value: ReturnType<typeof project>, settings: string | null, discussion: string | null | undefined,
            published: WorkspaceDestinationTitle | undefined, catalogPending: boolean) {
            const nextInputs = [value, settings, discussion, published, catalogPending];
            if (!titleInputs || !shallow(titleInputs, nextInputs)) {
                titleInputs = nextInputs;
                const fallback = resolvePublishedOrStaticInstanceTitle(catalog, ref, { publishedTitle: published, fallbackTitle },
                    settings ?? value.stored, route, catalogPending);
                title = value.missing ?? (discussion || null) ?? (value.session || null) ?? value.project ?? fallback;
            }
            return title;
        },
    };
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
    /** The entries whose Session content is demanded (the tabs a strip has mounted); every entry when omitted. */
    contentDemandKeys?: ReadonlySet<string> | null,
): ReadonlyMap<string, string> {
    const sources = useDestinationInstanceTitleSources(catalog, entries, contentDemandKeys);
    const source = React.useMemo(() => {
        let titles: ReadonlyMap<string, string> = new Map();
        return {
            subscribe(listener: () => void) {
                const stopStore = getStorage().subscribe(listener, {
                    profileScope: true, projectAccountRows: true, sessions: true,
                    sessionListRowsByServerId: true, ordinarySessionListMembershipByServerId: true,
                    deletedSessionIds: true, artifacts: true, artifactsLoaded: true,
                    artifactBrowserLoaded: true, artifactInventoryKindsLoaded: true, workflowRunsById: true,
                });
                const stopSettings = subscribeSettingsEntityTitles(listener);
                const stopPrivacy = entries.some(entry => readDestinationSessionAddress(entry.ref))
                    ? subscribeSessionRecordingVisibility(listener) : null;
                return () => { stopStore(); stopSettings(); stopPrivacy?.(); };
            },
            read() {
                const next = new Map<string, string>();
                for (const [key, source] of sources) {
                    const title = source.getSnapshot();
                    if (title) next.set(key, title);
                }
                if (!shallow(titles, next)) titles = next;
                return titles;
            },
        };
    }, [sources]);
    return React.useSyncExternalStore(source.subscribe, source.read, source.read);
}

/** Strips subscribe in the tab leaf; grouped content demand stays at this owner. */
export function useDestinationInstanceTitleSources(
    catalog: readonly CompactAppDestination[],
    entries: readonly DestinationInstanceTitleEntry[],
    /** The entries whose Session content is demanded (the tabs a strip has mounted); every entry when omitted. */
    contentDemandKeys?: ReadonlySet<string> | null,
): ReadonlyMap<string, DestinationInstanceTitleSource> {
    const destinationTitles = useWorkspaceDestinationTitles();
    const catalogPending = useAppShellPluginUiProjection(isAppShellPluginCatalogPending);
    const accountLifetime = useActiveServerAccountScopeLifetime();
    const previous = React.useRef(new Map<string, ReturnType<typeof createDestinationInstanceTitleProjection>>());
    const projections = React.useMemo(() => {
        const next = new Map<string, ReturnType<typeof createDestinationInstanceTitleProjection>>();
        for (const entry of entries) {
            const old = previous.current.get(entry.key);
            next.set(entry.key, old?.catalog === catalog && (old.entry === entry || (old.entry.ref === entry.ref
                && old.fallbackTitle === entry.fallbackTitle && old.entry.instanceKey === entry.instanceKey))
                ? old : createDestinationInstanceTitleProjection(catalog, entry));
        }
        previous.current = next;
        return [...next.values()];
    }, [catalog, entries]);
    const settingsDemands = projections.map(entry => entry.settingsDemand);
    const hasProviders = settingsDemands.some(demand => demand?.kind === 'provider');
    const hasProfiles = settingsDemands.some(demand => demand?.kind === 'profile');
    const hasMcp = settingsDemands.some(demand => demand?.kind === 'mcp');
    React.useEffect(() => {
        if (!accountLifetime?.isCurrent() || !(hasProviders || hasProfiles || hasMcp)) return;
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
    const runEntries = React.useMemo(() => projections.filter(entry => entry.managedRunId), [projections]);
    const unreadRunIdsKey = getStorage()(state => runEntries.length === 0 ? '[]' : JSON.stringify([...new Set(runEntries.flatMap(entry => {
        const { ref } = entry.entry;
        return state.profileScope && (!ref.params.serverId || areServerProfileIdentifiersEquivalent(ref.params.serverId, state.profileScope.serverId))
            && !state.workflowRunsById[workflowRunStoreKey(entry.managedRunId!, state.profileScope)] ? [entry.managedRunId!] : [];
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
    const sessionEntries = React.useMemo(() => projections.filter(entry => entry.session && entry.entry.ref.params.id
        && (!contentDemandKeys || contentDemandKeys.has(entry.entry.key))).map(entry => entry.entry), [projections, contentDemandKeys]);
    const addresses = React.useMemo(() => sessionEntries.map((entry) => ({
        sessionId: entry.ref.params.id!, serverId: entry.ref.params.serverId ?? null,
    })), [sessionEntries]);
    // A restored tab's page is not mounted, so its Session is named from content nobody has demanded yet.
    const activeServerId = useActiveServerSnapshot(addresses.some(address => !address.serverId)).serverId;
    const demandedSessions = React.useMemo(() => addresses.flatMap(address => {
        const demanded = normalizeSessionAddress(address.serverId ?? activeServerId, address.sessionId);
        return demanded ? [demanded] : [];
    }), [addresses, activeServerId]);
    useSessionContentDemand(demandedSessions, { tag: 'workspace.hydrateSessionTabs', hydrate: 'unsettled', contentDemand: 'list-display' });
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
    type TitleSourceEntry = Readonly<{
        projection: ReturnType<typeof createDestinationInstanceTitleProjection>;
        published: WorkspaceDestinationTitle | undefined;
        discussion: string | null | undefined;
        pending: boolean;
        source: DestinationInstanceTitleSource;
    }>;
    const previousSources = React.useRef(new Map<string, TitleSourceEntry>());
    return React.useMemo(() => {
        const next = new Map<string, TitleSourceEntry>();
        const sources = new Map<string, DestinationInstanceTitleSource>();
        const discussionsByKey = new Map(discussionEntries.map((entry, index) => [entry.key, discussionTitles[index]]));
        for (const projection of projections) {
            const entry = projection.entry;
            const address = readDestinationSessionAddress(entry.ref);
            const published = destinationTitles?.[entry.instanceKey ?? entry.key];
            const discussion = discussionsByKey.get(entry.key);
            const old = previousSources.current.get(entry.key);
            const pending = catalogPending && !projection.route.destination
                && (entry.ref.kind === 'plugins' || readWorkspacePluginAppPageAddress(entry.ref) !== null);
            const source: DestinationInstanceTitleSource = old?.projection === projection && old.published === published
                && old.discussion === discussion && old.pending === pending ? old.source : {
                href: projection.route.href,
                icon: projection.route.presentation?.icon,
                getSnapshot: () => {
                    if (address && !readSessionRecordingVisibility()(address)) return t('session.untitled');
                    const state = readRegisteredStorageState();
                    return projection.title(projection.read(state, published), projection.readSettings(state), discussion, published, pending);
                },
                subscribe: (listener: () => void) => {
                    const stopStore = getStorage().subscribe(listener, {
                        profileScope: true, projectAccountRows: true, sessions: true,
                        sessionListRowsByServerId: true, ordinarySessionListMembershipByServerId: true,
                        deletedSessionIds: true, artifacts: true, artifactsLoaded: true,
                        artifactBrowserLoaded: true, artifactInventoryKindsLoaded: true, workflowRunsById: true,
                    });
                    const stopSettings = projection.settingsDemand ? subscribeSettingsEntityTitles(listener) : null;
                    const stopPrivacy = address ? subscribeSessionRecordingVisibility(listener) : null;
                    return () => { stopStore(); stopSettings?.(); stopPrivacy?.(); };
                },
            };
            next.set(entry.key, { projection, published, discussion, pending, source });
            sources.set(entry.key, source);
        }
        previousSources.current = next;
        return sources;
    }, [catalogPending, projections, discussionEntries, discussionTitles, destinationTitles]);
}
