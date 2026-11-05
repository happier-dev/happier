import type { HappierStorageCategoryIdV1 } from '@happier-dev/protocol/storage/storageV1';

/** Pure route types: core callers do not depend on the visual tab table and its component graph. */
export type MachinePageTabId = 'overview' | 'services' | 'processes' | 'storage' | 'guard';

/** A tab and the params it owns (one arm per tab; each tab's plan adds its params with its row). */
export type MachinePageTabParams =
    | Readonly<{ id: 'overview' }>
    /** Plan 30 S30-6e: the services list, or one service's page with its logs (`page=service&service=<serviceId>`). */
    | Readonly<{ id: 'services'; page?: 'service' | 'roles'; service?: string }>
    /**
     * Plan 30 §10: sorted by a column; on a phone an owner (`page=owner&owner=<row>`), one external app
     * (`page=app&app=<name>`, All processes) or one process pushes.
     * `scope=all` opens on All processes (the way back from an app's page). `filter=leftBehind` opens only what ended sessions left running (the Machines widget's Clean up).
     */
    | Readonly<{ id: 'processes'; sort?: 'memory' | 'cpu'; page?: 'owner' | 'process' | 'app'; owner?: string; process?: string; app?: string; scope?: 'all'; filter?: 'leftBehind' }>
    /** Plan 40 §4.11: the Happier view, or one category's page (`page=category&categoryId=caches`). */
    /**
     * Plan 40 §4.11: the Happier view or Whole disk (`view=disk`, an opened folder `nodeId`, Large/Old `files`),
     * a pushed page (a kind, Worktrees, Suggestions, Protected folders), or the low-disk moment
     * (`prepare=lowDisk&volumeId=…`, plan 20's `free_up_space` step).
     */
    | Readonly<{ id: 'storage'; view?: 'happier' | 'disk'; page?: 'category' | 'worktrees' | 'suggestions' | 'protected';
        categoryId?: HappierStorageCategoryIdV1; nodeId?: string; files?: 'large' | 'old'; prepare?: 'lowDisk'; volumeId?: string }>
    /** Plan 50 §5.4: the rules, or the full Activity page (`page=activity`). */
    | Readonly<{ id: 'guard'; page?: 'activity' }>;

export type MachinePageTabBodyProps = Readonly<{
    serverId: string;
    machineId: string;
    machineName: string;
    online: boolean | null;
    params: MachinePageTabParams;
    setParams(next: MachinePageTabParams): void;
    /** The tab's bar accessory is drawn at the end of the tab bar, so the body leaves its own copy out. */
    barAccessoryShown?: boolean;
}>;

/** What a tab draws at the end of the tab bar (Overview: freshness and history range, lab `rv` O). */
export type MachinePageTabBarAccessoryProps = Readonly<{
    serverId: string;
    machineId: string;
    online: boolean | null;
    /** The open tab's params, for an accessory that switches the tab's own view (Storage: Happier | Whole disk). */
    params?: MachinePageTabParams;
    setParams?: (next: MachinePageTabParams) => void;
}>;

/**
 * A tab's params as the route query carries them: `tab` plus the tab's own params (`sort=memory`).
 * Overview is the page itself and names nothing. The one encoder for links and in-place switches.
 */
export function machinePageTabQuery(params: MachinePageTabParams): Readonly<Record<string, string>> {
    if (params.id === 'overview') return {};
    const { id, ...rest } = params;
    const query: Record<string, string> = { tab: id };
    for (const [key, value] of Object.entries(rest)) {
        if (value !== undefined) query[key] = String(value);
    }
    return query;
}

/** Every key across the tabs' param arms. The record must name each one exactly, so a tab's new param is cleared too. */
type MachinePageTabParamKey = MachinePageTabParams extends infer Arm ? Arm extends unknown ? Exclude<keyof Arm, 'id'> : never : never;
const MACHINE_PAGE_TAB_PARAM_KEYS = Object.keys({
    service: true, sort: true, page: true, owner: true, process: true, app: true, scope: true, filter: true,
    view: true, categoryId: true, nodeId: true, files: true, prepare: true, volumeId: true,
} satisfies Record<MachinePageTabParamKey, true>);

/**
 * The route params that switch the page to `next` in place. A router merges params, so every key a
 * tab owns is cleared and `next` is written by the one encoder. Keys no tab owns are the route's own
 * (the machine id and Home, and the destination's path) and are never touched: clearing one would
 * move the page off `/machines/[id]`.
 */
export function machinePageTabRouteParams(next: MachinePageTabParams): Record<string, string | undefined> {
    const params: Record<string, string | undefined> = { tab: undefined };
    for (const key of MACHINE_PAGE_TAB_PARAM_KEYS) params[key] = undefined;
    return { ...params, ...machinePageTabQuery(next) };
}

/**
 * Whether the params name the tab itself. A page the tab pushes (a category, one process, full Activity) or its
 * Whole disk view is a destination of its own: blocks that close a tab (Ask an agent) belong to the root only.
 */
/**
 * Whether the params name a page the tab pushes (a service, a category, one process, full Activity, a plugin page's
 * own location): it owns the top of the page, so a phone draws no Machine header above it. A tab's alternate view
 * (Storage's Whole disk) is not pushed.
 */
export function isMachinePageTabPushed(params: MachinePageTabParams): boolean {
    return 'page' in params && params.page !== undefined;
}

export function isMachinePageTabRoot(params: MachinePageTabParams): boolean {
    if ('page' in params && params.page !== undefined) return false;
    return !(params.id === 'storage' && params.view === 'disk');
}
