import type { QualifiedMachineV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import type { IconName } from '@/components/ui/icons/Icon';

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
    | Readonly<{ kind: 'listing'; sourceId: string; pluginId: string }>;

/** The route params naming `item`; `null` clears both, so an installed plugin never inherits a listing's source. */
export function pluginsOpenItemParams(item: PluginsOpenItem | null): { plugin: string | undefined; source: string | undefined } {
    return {
        plugin: item?.pluginId,
        source: item?.kind === 'listing' ? item.sourceId : undefined,
    };
}

export function readPluginsOpenItem(params: Readonly<Record<string, unknown>>): PluginsOpenItem | null {
    const pluginId = readParam(params.plugin);
    if (!pluginId) return null;
    const sourceId = readParam(params.source);
    return sourceId ? { kind: 'listing', sourceId, pluginId } : { kind: 'installed', pluginId };
}

/**
 * The Plugins home in `host`; `view` opens it on Installed or Browse (the home screen honours
 * `?view=`), and `open` with a plugin open beside it.
 */
export function buildPluginsHomeRoute(host: PluginsSurfaceHost, options?: Readonly<{
    view?: PluginsHomeView;
    open?: PluginsOpenItem | null;
}>) {
    const base = host === 'settings' ? SETTINGS_ROUTES.plugins : PLUGINS_APP_ROUTE;
    const open = pluginsOpenItemParams(options?.open ?? null);
    const query = [
        options?.view ? `view=${options.view}` : null,
        open.plugin ? `plugin=${encodeURIComponent(open.plugin)}` : null,
        open.source ? `source=${encodeURIComponent(open.source)}` : null,
    ].filter((part): part is string => part !== null);
    return query.length > 0 ? `${base}?${query.join('&')}` as const : base;
}

/** Whether `pathname` is the Plugins home itself (where a plugin opens in place beside the page). */
export function isPluginsHomePathname(pathname: string | null | undefined): boolean {
    const trimmed = (pathname ?? '').replace(/\/+$/, '');
    return trimmed === PLUGINS_APP_ROUTE || trimmed === SETTINGS_ROUTES.plugins;
}

/**
 * The home's one name, in Settings and in the sidebar alike: "Plugins" (lab app-surfaces R1p, settings
 * cplugins G1). "Plugin marketplace" named only its Browse half (R-APP-11).
 */
export const PLUGINS_HOME_TITLE_KEY = 'settingsPlugins.surfaces.navigationTitle' as const;

export type PluginListingRouteParams = Readonly<{ sourceId: string; pluginId: string }>;

/**
 * A marketplace listing before install, addressed by its source and plugin id so the page can be
 * reloaded or deep-linked: the listing is re-read from that exact source on arrival.
 */
export function buildPluginListingRoute(host: PluginsSurfaceHost, params: PluginListingRouteParams) {
    return {
        pathname: LISTING_PATHNAMES[host],
        params: { sourceId: params.sourceId, pluginId: params.pluginId },
    } as const;
}

/** One installed plugin's page (settings, updates, machines, leave actions) in `host`. */
export function buildPluginDetailRoute(host: PluginsSurfaceHost, pluginId: string) {
    return {
        pathname: DETAIL_PATHNAMES[host],
        params: { pluginId },
    } as const;
}

export function readPluginDetailRoutePluginId(value: unknown): string | null {
    return readParam(value);
}

function readParam(value: unknown): string | null {
    if (Array.isArray(value)) return readParam(value[0]);
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

export function readPluginListingRouteParams(params: Readonly<Record<string, unknown>>): PluginListingRouteParams | null {
    const sourceId = readParam(params.sourceId);
    const pluginId = readParam(params.pluginId);
    return sourceId && pluginId ? { sourceId, pluginId } : null;
}

export function storeMachineRouteParams(machine: QualifiedMachineV1 | null) {
    return { machine: machine ? JSON.stringify({ serverId: machine.serverId, machineId: machine.machineId }) : undefined };
}
