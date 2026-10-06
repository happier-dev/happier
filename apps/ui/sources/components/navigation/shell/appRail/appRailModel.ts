import {
    resolveCurrentAppDestination,
    selectAppDestinationsInPlacement,
    type BuiltinAppShellColumnId,
    type CompactAppDestination,
} from '@/components/appShell/destinations/compactAppDestinationCatalog';
import { t } from '@/text';
import type { NavigationPlacement } from '@/sync/domains/settings/mobileSurfacePinning';

/**
 * The desktop app shell (lab `xrail-R1`, user ruling 2026-09-27): a rail of destinations, a column that
 * belongs to the open destination, then the page. Every fact here is a projection of the one
 * destination catalog (`compactAppDestinationCatalog`): its placements say what the rail lists, and
 * its current destination says which entry is open and which column stands beside the page.
 */

/** What the second column shows beside the page. `none`: the destination is a full page. */
export type AppShellColumn =
    | Readonly<{ kind: 'builtin'; id: BuiltinAppShellColumnId }>
    /** A plugin page's own column, rendered by the plugin (`PluginAppPageColumn`). */
    | Readonly<{ kind: 'plugin'; destinationId: string }>
    | Readonly<{ kind: 'none' }>;

/** A column that is shown (not `none`). */
export type AppShellShownColumn = Exclude<AppShellColumn, Readonly<{ kind: 'none' }>>;

const NO_COLUMN: AppShellColumn = Object.freeze({ kind: 'none' });
const BUILTIN_COLUMNS: Readonly<Record<BuiltinAppShellColumnId, Extract<AppShellColumn, { kind: 'builtin' }>>> = {
    sessions: Object.freeze({ kind: 'builtin', id: 'sessions' }),
    projects: Object.freeze({ kind: 'builtin', id: 'projects' }),
    workflows: Object.freeze({ kind: 'builtin', id: 'workflows' }),
    boards: Object.freeze({ kind: 'builtin', id: 'boards' }),
    plugins: Object.freeze({ kind: 'builtin', id: 'plugins' }),
    settings: Object.freeze({ kind: 'builtin', id: 'settings' }),
};

const PLUGIN_COLUMNS = new Map<string, Extract<AppShellColumn, { kind: 'plugin' }>>();

/** The (referentially stable) model of a plugin page's own column. */
function pluginAppShellColumn(destinationId: string): Extract<AppShellColumn, { kind: 'plugin' }> {
    let column = PLUGIN_COLUMNS.get(destinationId);
    if (!column) {
        column = Object.freeze({ kind: 'plugin', destinationId });
        PLUGIN_COLUMNS.set(destinationId, column);
    }
    return column;
}

/** The (referentially stable) model of a built-in column. */
export function builtinAppShellColumn(id: BuiltinAppShellColumnId): Extract<AppShellColumn, { kind: 'builtin' }> {
    return BUILTIN_COLUMNS[id];
}

/** A rail entry is a catalog destination placed on the rail. */
export type AppRailEntry = CompactAppDestination;

export type AppRailEntries = Readonly<{
    /** The app's own destinations: Sessions, Search, Inbox, Projects, Workflows… */
    app: readonly AppRailEntry[];
    /** Plugins and every plugin destination placed on the rail (or whose column this host lacks). */
    plugins: readonly AppRailEntry[];
    /** The bottom of the rail: Settings. */
    account: readonly AppRailEntry[];
}>;

export type AppRailFooterItemId = 'app-rail-usage' | 'app-rail-machines' | 'app-rail-updates' | 'app-rail-account';
export type AppRailPlacementItem = Readonly<{
    id: string;
    title: string;
    icon: AppRailEntry['icon'];
    group: 'app' | 'plugins' | 'account';
    defaultPlacement: NavigationPlacement;
}> & (Readonly<{ kind: 'destination'; entry: AppRailEntry }> | Readonly<{ kind: 'footer'; id: AppRailFooterItemId }>);

/** All customizable controls, including the anchored footer's canonical actions. */
export function buildAppRailPlacementItems(entries: AppRailEntries, updatesVisible: boolean): readonly AppRailPlacementItem[] {
    const destinations = (items: readonly AppRailEntry[], group: AppRailPlacementItem['group']): AppRailPlacementItem[] =>
        items.map(entry => ({ kind: 'destination', id: entry.id, title: entry.title, icon: entry.icon, group,
            defaultPlacement: entry.visibility === 'hidden' ? 'hidden' : 'pinned', entry }));
    const footer = (id: AppRailFooterItemId, title: string, icon: AppRailEntry['icon']): AppRailPlacementItem =>
        ({ kind: 'footer', id, title, icon, group: 'account', defaultPlacement: 'pinned' });
    return [
        ...destinations(entries.app, 'app'), ...destinations(entries.plugins, 'plugins'),
        footer('app-rail-usage', t('settings.usage'), 'speedometer'),
        footer('app-rail-machines', t('settings.machines'), 'desktop'),
        ...(updatesVisible ? [footer('app-rail-updates', t('updates.title'), 'hard-drive-download')] : []),
        ...destinations(entries.account, 'account'),
        footer('app-rail-account', t('settings.account'), 'user-circle'),
    ];
}

/** The rail's entries, per region, in catalog order. Column destinations and hidden ones stay off. */
export function buildAppRailEntries(catalog: readonly CompactAppDestination[], options?: Readonly<{ includeHidden?: boolean }>): AppRailEntries {
    return {
        app: selectAppDestinationsInPlacement(catalog, { kind: 'rail', region: 'app' }, options),
        plugins: selectAppDestinationsInPlacement(catalog, { kind: 'rail', region: 'plugins' }, options),
        account: selectAppDestinationsInPlacement(catalog, { kind: 'rail', region: 'account' }, options),
    };
}

/** The column a destination stands beside its own page (a peek from its rail icon shows it); `null` for a full page. */
export function resolveAppRailEntryColumn(entry: AppRailEntry): AppShellShownColumn | null {
    if (entry.kind === 'builtin') return entry.column !== undefined ? builtinAppShellColumn(entry.column) : null;
    return entry.ownColumn ? pluginAppShellColumn(entry.id) : null;
}

export type AppShellLocation = Readonly<{
    /** The open destination. */
    current: CompactAppDestination | null;
    /** The rail entry that is open: the current destination, or the owner of the column it is placed in. */
    railEntryId: string | null;
    /** The column beside the page. */
    column: AppShellColumn;
}>;

/** The shell's one answer to "where am I": everything the rail, the column and the peek show. */
export function resolveAppShellLocation(
    catalog: readonly CompactAppDestination[],
    pathname: string,
): AppShellLocation {
    const current = resolveCurrentAppDestination(catalog, pathname);
    if (current === null) return { current: null, railEntryId: null, column: NO_COLUMN };
    if (current.placement.kind === 'column') {
        const columnId = current.placement.column;
        const owner = catalog.find((destination) => destination.kind === 'builtin' && destination.column === columnId);
        return { current, railEntryId: owner?.id ?? null, column: builtinAppShellColumn(columnId) };
    }
    return { current, railEntryId: current.id, column: resolveAppRailEntryColumn(current) ?? NO_COLUMN };
}
