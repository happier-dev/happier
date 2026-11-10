import { resolveAnchoredListMoveV1 } from '@happier-dev/protocol/actions/anchoredListOrderV1';
import type { SessionOrganizationMoveInput } from '@happier-dev/protocol/actions/sessionOrganizationMoveAction';
import { treeRowId } from '@/components/sessions/shell/drop-resolution/treeRowId';

import {
    isRailControlDestination,
    resolveAppRailBand,
    resolveCurrentAppDestination,
    selectAppDestinationsInPlacement,
    type BuiltinAppShellColumnId,
    type CompactAppDestination,
} from '@/components/appShell/destinations/compactAppDestinationCatalog';
import { t } from '@/text';
import type { NavigationPlacement } from '@/sync/domains/settings/mobileSurfacePinning';
import type { SessionOrganizationProjection } from '@/sync/domains/session/organization';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { sessionAddressKey } from '@/sync/domains/session/sessionAddress';
import { readSessionBotFaceFacts, type SessionBotFaceFacts } from '@/components/sessions/bots/face/sessionBotFaceFacts';

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
    discussions: Object.freeze({ kind: 'builtin', id: 'discussions' }),
    projects: Object.freeze({ kind: 'builtin', id: 'projects' }),
    workflows: Object.freeze({ kind: 'builtin', id: 'workflows' }),
    boards: Object.freeze({ kind: 'builtin', id: 'boards' }),
    plugins: Object.freeze({ kind: 'builtin', id: 'plugins' }),
    settings: Object.freeze({ kind: 'builtin', id: 'settings' }),
    machines: Object.freeze({ kind: 'builtin', id: 'machines' }),
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

export type AppRailBotEntry = Readonly<{
    id: string;
    serverId: string;
    sessionId: string;
    /** The Bot's face, read once by the Session face owner. */
    face: SessionBotFaceFacts;
    session: SessionListRenderableSession;
}>;

export type AppRailBotHome = Readonly<{
    serverId: string;
    rowsBySessionId: Readonly<Record<string, SessionListRenderableSession | undefined>>;
    organization: SessionOrganizationProjection;
}>;

export type AppRailEntries = Readonly<{
    /** The app's own destinations: Sessions, Search, Inbox, Projects, Workflows… */
    app: readonly AppRailEntry[];
    /** Plugins and every plugin destination placed on the rail (or whose column this host lacks). */
    plugins: readonly AppRailEntry[];
    /** The bottom of the rail: Settings. */
    account: readonly AppRailEntry[];
    /** Explicit rail membership, projected only while the current authorized row is a Bot. */
    bots: readonly AppRailBotEntry[];
}>;

export type AppRailFooterItemId = 'app-rail-usage' | 'app-rail-machines' | 'app-rail-updates' | 'app-rail-account';
export type AppRailPlacementItem = Readonly<{
    id: string;
    title: string;
    icon: AppRailEntry['icon'];
    group: 'app' | 'plugins' | 'account';
    defaultPlacement: NavigationPlacement;
}> & (Readonly<{ kind: 'destination'; entry: AppRailEntry }> | Readonly<{ kind: 'footer'; id: AppRailFooterItemId }>);

/**
 * All customizable controls, including the anchored footer's canonical actions. A fresh rail pins only
 * the work band (owner Q8: Sessions, Search, Inbox, Projects, Workflows), Settings and Account; every
 * other destination and footer control starts in More (owner 2026-11-10). These are defaults only: the
 * person's own placements always win (`resolveNavigationPlacements`).
 */
export function buildAppRailPlacementItems(entries: AppRailEntries, updatesVisible: boolean): readonly AppRailPlacementItem[] {
    const destinations = (items: readonly AppRailEntry[], group: AppRailPlacementItem['group']): AppRailPlacementItem[] =>
        items.map(entry => ({ kind: 'destination', id: entry.id, title: entry.title, icon: entry.icon, group,
            // A contextual page (owner Q3) waits in the customizer until the person pins it.
            defaultPlacement: entry.visibility === 'hidden' || entry.contextual ? 'hidden'
                : resolveAppRailBand(entry) === 'work' || group === 'account' ? 'pinned' : 'overflow', entry }));
    const footer = (id: AppRailFooterItemId, title: string, icon: AppRailEntry['icon'], defaultPlacement: NavigationPlacement): AppRailPlacementItem =>
        ({ kind: 'footer', id, title, icon, group: 'account', defaultPlacement });
    return [
        ...destinations(entries.app, 'app'), ...destinations(entries.plugins, 'plugins'),
        footer('app-rail-usage', t('settings.usage'), 'speedometer', 'overflow'),
        footer('app-rail-machines', t('settings.machines'), 'desktop', 'overflow'),
        // Shown only while an update waits; burying it in More would hide the one thing it says.
        ...(updatesVisible ? [footer('app-rail-updates', t('updates.title'), 'hard-drive-download', 'pinned')] : []),
        ...destinations(entries.account, 'account'),
        footer('app-rail-account', t('settings.account'), 'user-circle', 'pinned'),
    ];
}

/**
 * The rail's entries, per region, in catalog order. Column destinations and hidden ones stay off, and
 * so do destinations the rail draws as its own footer control (Machines), which would otherwise appear
 * twice on the rail and in its customizer.
 */
export function buildAppRailEntries(catalog: readonly CompactAppDestination[], options?: Readonly<{
    includeHidden?: boolean;
    botHomes?: readonly AppRailBotHome[];
}>): AppRailEntries {
    const region = (name: 'app' | 'plugins' | 'account') => selectAppDestinationsInPlacement(catalog, { kind: 'rail', region: name }, options)
        .filter(destination => !isRailControlDestination(destination));
    return {
        app: region('app'),
        plugins: region('plugins'),
        account: region('account'),
        bots: (options?.botHomes ?? []).flatMap(home => home.organization.railPinnedSessionIds.flatMap(sessionId => {
            const session = home.rowsBySessionId[sessionId];
            const face = session ? readSessionBotFaceFacts(session, home.serverId) : null;
            if (!session || !face) return [];
            return [{ id: `bot:${sessionAddressKey({ serverId: home.serverId, sessionId })}`,
                serverId: home.serverId, sessionId, face, session }];
        })),
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

/** Rail pins reorder the shared pin order, including pins that only appear in the Sessions list. */
export function resolveAppRailBotDropDestinationKey(input: SessionOrganizationMoveInput, orderedPinSessionIds: readonly string[]): string | null {
    if (input.projection !== 'rail' || input.sourceKind !== 'leaf'
        || (input.instructionKind !== 'reorder-before' && input.instructionKind !== 'reorder-after')) return null;
    const ids = orderedPinSessionIds.map(id => treeRowId.session(input.scope.serverId, id));
    const order = resolveAnchoredListMoveV1(ids, input.sourceRowId, { anchorId: input.targetRowId,
        placement: input.instructionKind === 'reorder-before' ? 'before' : 'after' });
    return order ? JSON.stringify(['rail-pin-position', input.scope, input.containerId, order.indexOf(input.sourceRowId)]) : null;
}
