import { normalizePluginUiSubPathV1, PluginUiDestinationReferenceV1Schema } from '@happier-dev/protocol/plugins/ui';

/** Read the raw path before URL can erase traversal segments. */
export function parsePluginProjectPageRoutePath(href: string): Readonly<{
    workspaceRefId: string; pluginId: string; localId: string; subPath: string;
}> | null {
    const path = href.split(/[?#]/, 1)[0] ?? '';
    const match = /^\/projects\/([^/]+)\/plugins\/([^/]+)\/([^/]+)(?:\/(.*))?\/?$/.exec(path);
    if (!match) return null;
    try {
        const workspaceRefId = decodeURIComponent(match[1]!);
        const pluginId = decodeURIComponent(match[2]!);
        const localId = decodeURIComponent(match[3]!);
        if (!workspaceRefId || workspaceRefId === 'open' || workspaceRefId === 'sources') return null;
        if ([workspaceRefId, pluginId, localId].some(value => !value.trim() || /[\u0000-\u001f\u007f\\]/u.test(value))) return null;
        if ([pluginId, localId].some(value => /\//u.test(value) || value === '.' || value === '..')) return null;
        if (!PluginUiDestinationReferenceV1Schema.safeParse({ pluginId, localId }).success) return null;
        const rawSubPath = (match[4] ?? '').replace(/\/$/, '');
        const decoded = rawSubPath ? rawSubPath.split('/').map(segment => decodeURIComponent(segment)) : [];
        if (decoded.some(segment => /[/\\]/u.test(segment))) return null;
        const subPath = normalizePluginUiSubPathV1(decoded.join('/'));
        return subPath === null ? null : { workspaceRefId, pluginId, localId, subPath };
    } catch { return null; }
}

export const PLUGIN_APP_PAGE_ROUTE_PREFIX = '/plugins';

export type PluginPageTarget = Readonly<{ kind: 'app' }> | Readonly<{
    kind: 'project';
    workspaceRefId: string;
    serverId?: string | null;
    rawWorktreeId?: string | null;
    rawActiveRootPath?: string | null;
}>;

export function pluginPageTargetKey(target: PluginPageTarget): string {
    return target.kind === 'app' ? 'app' : JSON.stringify([
        'project', target.serverId ?? null, target.workspaceRefId,
        target.rawWorktreeId ?? null, target.rawActiveRootPath ?? null,
    ]);
}

export function buildPluginProjectPageRoutePath(input: Readonly<{
    workspaceRefId: string; pluginId: string; localId: string; subPath?: string;
    serverId?: string | null; rawWorktreeId?: string | null; rawActiveRootPath?: string | null;
}>): string {
    const root = `/projects/${encodeURIComponent(input.workspaceRefId)}/plugins/${encodeURIComponent(input.pluginId)}/${encodeURIComponent(input.localId)}`;
    const query = new URLSearchParams();
    if (input.serverId?.trim()) query.set('serverId', input.serverId.trim());
    if (input.rawWorktreeId?.trim()) query.set('worktreeId', input.rawWorktreeId.trim());
    else if (input.rawActiveRootPath?.trim()) query.set('activeRootPath', input.rawActiveRootPath.trim());
    return appendPluginPageRouteSubPath(query.size ? `${root}?${query}` : root, input.subPath ?? '');
}

/** Extend only the plugin-local location of a host-issued root, retaining its query. */
export function appendPluginPageRouteSubPath(routePath: string, subPath: string): string {
    const normalized = normalizePluginUiSubPathV1(subPath);
    if (normalized === null) throw new Error('plugin_surface_open_sub_path_invalid');
    const [root, query] = routePath.split('?', 2);
    const path = normalized ? `${root}/${normalized.split('/').map(encodeURIComponent).join('/')}` : root!;
    return query ? `${path}?${query}` : path;
}

/** The host owns the prefix and encodes each plugin-local identity/location segment. */
export function buildPluginAppPageRoutePath(input: Readonly<{
    pluginId: string; localId: string; subPath?: string;
    /** The page's own declared view the location presents (`replacePageLocation` `view`), when not the page itself. */
    view?: string | null;
}>): string {
    const root = `${PLUGIN_APP_PAGE_ROUTE_PREFIX}/${encodeURIComponent(input.pluginId)}/${encodeURIComponent(input.localId)}`;
    const normalized = input.subPath === undefined ? '' : (normalizePluginUiSubPathV1(input.subPath) ?? '');
    const path = normalized.length === 0 ? root : `${root}/${normalized.split('/').map(encodeURIComponent).join('/')}`;
    return input.view == null || input.view === input.localId ? path : `${path}?view=${encodeURIComponent(input.view)}`;
}

/** The declared view an app-page route names in its `view` query, or `null`. The page resolves it against its views. */
export function readPluginAppPageRouteView(value: unknown): string | null {
    const view = Array.isArray(value) ? value[0] : value;
    return typeof view === 'string' && view.trim() !== '' && !/[/\\]/u.test(view) ? view : null;
}

/**
 * The two identity segments of a generated plugin-page route.
 *
 * Expo Router hands a dynamic segment back as a string or, on a repeated match,
 * an array; both spellings resolve to the same identity here so the screen never
 * carries a second parsing rule. A missing or empty segment resolves to `''`,
 * which the page catalog fails closed on — the host never guesses a page.
 */
export type PluginPageRouteIdentity = Readonly<{
    pluginId: string;
    localId: string;
}>;

function readRouteSegment(value: unknown): string {
    if (Array.isArray(value)) {
        return readRouteSegment(value[0]);
    }
    return typeof value === 'string' ? value.trim() : '';
}

export function readPluginPageRouteIdentity(
    params: Readonly<Record<string, unknown>>,
): PluginPageRouteIdentity {
    return {
        pluginId: readRouteSegment(params.pluginId),
        localId: readRouteSegment(params.localId),
    };
}
