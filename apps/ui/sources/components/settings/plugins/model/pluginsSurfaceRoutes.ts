import { z } from 'zod';
import type { QualifiedMachineV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import type { IconName } from '@/components/ui/icons/Icon';
import { readStoreListingReference, type StoreListingReference } from './storeListingSelection';
export type { StoreListingReference, StoreSoftwareListingReference } from './storeListingSelection';
import { StringSetSelectionV1Schema } from '@happier-dev/protocol/collections/filter/entityListFilterV1';
import type { SettingsCollectionFilter } from '@/components/settings/shell/settingsCollectionAdapter';
import { QualifiedProjectKeyV1Schema, type QualifiedProjectKeyV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';

/**
 * The Plugins screens (home with Installed | Browse, and a marketplace listing) have two hosts: the
 * Settings shell (`/settings/plugins…`) and the app page reached from the main sidebar
 * (`/plugins…`). The screens are the same; only their routes differ. This module is the one owner of
 * those routes, so a link inside the screens keeps the user in the host they are in.
 *
 * A plugin's page follows the host too. The "Sources and tools" pages are configuration and stay
 * Settings pages in both hosts.
 */
export type PluginsSurfaceHost = 'settings' | 'app';

/** The Plugins surface's one glyph, in both hosts: the rail destination and the Settings row. */
export const PLUGINS_SURFACE_ICON = 'cube' as const satisfies IconName;

/** The app-page host: the main sidebar's Plugins destination. */
export const PLUGINS_APP_ROUTE = '/plugins' as const;
/**
 * Everything under the app host's `/plugins` belongs to the Plugins destination — the listing, a
 * plugin's page, and a plugin page this viewer no longer has (its tombstone offers "Manage plugin") —
 * except a plugin-contributed app page (`/plugins/<pluginId>/<localId>…`), whose own destination
 * claims its route more specifically.
 */
export const PLUGINS_APP_PAGE_PATTERNS = ['/plugins/[...rest]'] as const;

/**
 * An App panel (`rightSidebarTab × app`) as its own page, under the Plugins destination: where it opens
 * on a phone, or from a page with no right sidebar.
 */
export const PLUGIN_PANELS_ROUTE = '/plugins/panels' as const;

export function buildPluginPanelsRoute(destination: Readonly<{ pluginId: string; localId: string }>): string {
    const query = new URLSearchParams({ pluginId: destination.pluginId, destinationId: destination.localId });
    return `${PLUGIN_PANELS_ROUTE}?${query.toString()}`;
}

const LISTING_PATHNAMES = {
    settings: '/(app)/settings/plugins/listing',
    app: '/(app)/plugins/listing',
} as const;

const DETAIL_PATHNAMES = {
    settings: '/(app)/settings/plugins/[pluginId]',
    app: '/(app)/plugins/[pluginId]',
} as const;

export type PluginsHomeView = 'installed' | 'browse';
export type StoreHomeView = 'discover' | 'installed' | 'updates' | 'kind' | 'search' | 'jobs' | 'job' | 'category';

/** Explicit view context only. Ambiguous or malformed identity never selects an ambient Project. */
export function readStoreProjectRoute(params: Readonly<Record<string, unknown>>): QualifiedProjectKeyV1 | null {
    if (typeof params.project !== 'string') return null;
    try {
        const parsed = QualifiedProjectKeyV1Schema.safeParse(JSON.parse(params.project));
        return parsed.success ? parsed.data : null;
    } catch { return null; }
}

export function storeProjectRouteParams(project: QualifiedProjectKeyV1 | null) {
    return { project: project ? JSON.stringify({ serverId: project.serverId, projectKey: project.projectKey }) : undefined };
}

/** A navigation hint only; the preparation picker's existing Machine admission still decides usability. */
const StoreMachineRouteSchema = z.object({ serverId: z.string().min(1), machineId: z.string().min(1) }).strict();
export function readStoreMachineRoute(params: Readonly<Record<string, unknown>>): QualifiedMachineV1 | null {
    if (typeof params.machine !== 'string') return null;
    try {
        const parsed = StoreMachineRouteSchema.safeParse(JSON.parse(params.machine));
        return parsed.success ? parsed.data : null;
    } catch { return null; }
}

export function storeMachineRouteParams(machine: QualifiedMachineV1 | null) {
    return { machine: machine ? JSON.stringify({ serverId: machine.serverId, machineId: machine.machineId }) : undefined };
}

/** The host a pathname belongs to. Anything outside `/settings` is the app page. */
export function resolvePluginsSurfaceHost(pathname: string | null | undefined): PluginsSurfaceHost {
    if (typeof pathname !== 'string') return 'settings';
    return pathname === '/settings' || pathname.startsWith('/settings/') ? 'settings' : 'app';
}

/**
 * The plugin open beside the Plugins page: an installed plugin, or a marketplace listing before
 * install (addressed by its source). The Plugins column, the grid and the list all open and mark the
 * same item, so it lives in the route (`?plugin=` and, for a listing, `?source=`), not in any one of
 * them: reload and back keep it, and a deep link opens it.
 */
export type PluginsOpenItem =
    | Readonly<{ kind: 'installed'; pluginId: string }>
    | (PluginListingRouteParams & Readonly<{ kind: 'listing' }>);

/** The route params naming `item`; `null` clears both, so an installed plugin never inherits a listing's source. */
export function pluginsOpenItemParams(item: PluginsOpenItem | null) {
    return {
        plugin: item?.pluginId,
        source: item?.kind === 'listing' ? item.sourceId : undefined,
        itemId: item?.kind === 'listing' ? item.itemId : undefined,
        version: item?.kind === 'listing' ? item.version : undefined,
        selection: undefined,
    };
}

/** Store selection carries an existing native reference, never a title or editorial operand. */
export function readStoreOpenItem(params: Readonly<Record<string, unknown>>): StoreListingReference | null {
    if (typeof params.selection !== 'string') return null;
    const serialized = readParam(params.selection);
    if (!serialized) return null;
    try {
        return readStoreListingReference(JSON.parse(serialized));
    } catch { return null; }
}

export function storeOpenItemParams(item: StoreListingReference | null) {
    return { plugin: undefined, source: undefined, itemId: undefined, version: undefined,
        selection: item ? JSON.stringify(item) : undefined };
}

export function buildStoreListingRoute(item: StoreListingReference, project?: QualifiedProjectKeyV1 | null, continuationId?: string, machine?: QualifiedMachineV1 | null) {
    return { pathname: LISTING_PATHNAMES.app, params: { selection: JSON.stringify(item),
        ...(continuationId ? { continuation: continuationId } : {}),
        ...(project ? storeProjectRouteParams(project) : {}),
        ...(machine ? storeMachineRouteParams(machine) : {}) } } as const;
}

export type StoreListingRouteSelection =
    | Readonly<{ kind: 'store'; reference: StoreListingReference }>
    | Readonly<{ kind: 'plugin'; listing: PluginListingRouteParams }>;

/** One ingress for both listing URLs. An explicit invalid selection never falls back to legacy operands. */
export function readStoreListingRoute(params: Readonly<Record<string, unknown>>): StoreListingRouteSelection | null {
    if (params.selection !== undefined) {
        const reference = readStoreOpenItem(params);
        return reference ? { kind: 'store', reference } : null;
    }
    const listing = readPluginListingRouteParams(params);
    return listing ? { kind: 'plugin', listing } : null;
}

/** Conditions remain the shared native shape; malformed narrowing cannot become Browse all. */
export function readStoreDirectoryRoute(params: Readonly<Record<string, unknown>>): Readonly<{
    query: string; filters: SettingsCollectionFilter;
}> | null {
    const query = readParam(params.q, false) ?? '';
    const serialized = readParam(params.filters);
    if (!serialized) return { query, filters: {} };
    try {
        const value: unknown = JSON.parse(serialized);
        if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
        const entries: Array<[string, import('@happier-dev/protocol/collections/filter/entityListFilterV1').SetSelectionV1<string>]> = [];
        for (const [key, selection] of Object.entries(value)) {
            const parsed = StringSetSelectionV1Schema.safeParse(selection);
            if (!parsed.success) return null;
            entries.push([key, parsed.data]);
        }
        return { query, filters: Object.fromEntries(entries) };
    } catch { return null; }
}

export function readPluginsOpenItem(params: Readonly<Record<string, unknown>>): PluginsOpenItem | null {
    if (params.selection !== undefined) return null;
    const pluginId = readParam(params.plugin);
    if (!pluginId) return null;
    const sourceId = readParam(params.source);
    return sourceId ? { kind: 'listing', sourceId, pluginId, ...readListingLocator(params) } : { kind: 'installed', pluginId };
}

/**
 * The Plugins home in `host`; `view` opens it on Installed or Browse (the home screen honours
 * `?view=`), and `open` with a plugin open beside it.
 */
export function buildPluginsHomeRoute(host: PluginsSurfaceHost, options?: Readonly<{
    view?: PluginsHomeView | StoreHomeView;
    open?: PluginsOpenItem | null;
    sourceId?: string;
    query?: string;
    kind?: string;
    job?: string;
    category?: string;
    catalogSourceId?: string;
    project?: QualifiedProjectKeyV1 | null;
    machine?: QualifiedMachineV1 | null;
    /** Shared Store conditions (`readStoreDirectoryRoute` reads them back): Open in Installed keeps a Machine. */
    filters?: SettingsCollectionFilter;
}>) {
    const base = host === 'settings' ? SETTINGS_ROUTES.plugins : PLUGINS_APP_ROUTE;
    const open = pluginsOpenItemParams(options?.open ?? null);
    const sourceId = open.source ?? (options?.open ? undefined : options?.sourceId);
    const query = [
        options?.view ? `view=${options.view}` : null,
        options?.query ? `q=${encodeURIComponent(options.query)}` : null,
        options?.filters && Object.keys(options.filters).length ? `filters=${encodeURIComponent(JSON.stringify(options.filters))}` : null,
        options?.kind ? `kind=${encodeURIComponent(options.kind)}` : null,
        options?.job ? `job=${encodeURIComponent(options.job)}` : null,
        options?.category ? `category=${encodeURIComponent(options.category)}` : null,
        options?.catalogSourceId ? `catalogSource=${encodeURIComponent(options.catalogSourceId)}` : null,
        options?.project ? `project=${encodeURIComponent(storeProjectRouteParams(options.project).project!)}` : null,
        options?.machine ? `machine=${encodeURIComponent(storeMachineRouteParams(options.machine).machine!)}` : null,
        open.plugin ? `plugin=${encodeURIComponent(open.plugin)}` : null,
        sourceId ? `source=${encodeURIComponent(sourceId)}` : null,
        open.itemId ? `itemId=${encodeURIComponent(open.itemId)}` : null,
        open.version ? `version=${encodeURIComponent(open.version)}` : null,
    ].filter((part): part is string => part !== null);
    return query.length > 0 ? `${base}?${query.join('&')}` as const : base;
}

/** Whether `pathname` is the Plugins home itself (where a plugin opens in place beside the page). */
export function isPluginsHomePathname(pathname: string | null | undefined): boolean {
    const trimmed = (pathname ?? '').replace(/\/+$/, '');
    return trimmed === PLUGINS_APP_ROUTE || trimmed === SETTINGS_ROUTES.plugins;
}

/**
 * Settings retains its management name. The app destination has its own Store title,
 * without changing the destination, placement or route identity.
 */
export const PLUGINS_HOME_TITLE_KEY = 'settingsPlugins.surfaces.navigationTitle' as const;
export const STORE_HOME_TITLE_KEY = 'settingsPlugins.surfaces.storeTitle' as const;

export function pluginsHomeTitleKey(host: PluginsSurfaceHost) {
    return host === 'app' ? STORE_HOME_TITLE_KEY : PLUGINS_HOME_TITLE_KEY;
}

export type PluginListingRouteParams = Readonly<{ sourceId: string; pluginId: string; itemId?: string; version?: string }>;

/**
 * A marketplace listing before install, addressed by its source and plugin id so the page can be
 * reloaded or deep-linked: the listing is re-read from that exact source on arrival.
 */
export function buildPluginListingRoute(host: PluginsSurfaceHost, params: PluginListingRouteParams, project?: QualifiedProjectKeyV1 | null) {
    return {
        pathname: LISTING_PATHNAMES[host],
        params: { sourceId: params.sourceId, pluginId: params.pluginId,
            ...(params.itemId ? { itemId: params.itemId } : {}), ...(params.version ? { version: params.version } : {}),
            ...(host === 'app' && project ? storeProjectRouteParams(project) : {}) },
    } as const;
}

/** One installed plugin's page (settings, updates, machines, leave actions) in `host`. */
export function buildPluginDetailRoute(host: PluginsSurfaceHost, pluginId: string, project?: QualifiedProjectKeyV1 | null) {
    return {
        pathname: DETAIL_PATHNAMES[host],
        params: { pluginId, ...(host === 'app' && project ? storeProjectRouteParams(project) : {}) },
    } as const;
}

export function readPluginDetailRoutePluginId(value: unknown): string | null {
    return readParam(value);
}

function readParam(value: unknown, trim = true): string | null {
    if (Array.isArray(value)) return readParam(value[0], trim);
    if (typeof value !== 'string') return null;
    if (!trim) return value;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

export function readPluginListingRouteParams(params: Readonly<Record<string, unknown>>): PluginListingRouteParams | null {
    const sourceId = readParam(params.sourceId);
    const pluginId = readParam(params.pluginId);
    return sourceId && pluginId ? { sourceId, pluginId, ...readListingLocator(params) } : null;
}

function readListingLocator(params: Readonly<Record<string, unknown>>) {
    const itemId = readParam(params.itemId);
    const version = readParam(params.version);
    return { ...(itemId ? { itemId } : {}), ...(version ? { version } : {}) };
}
