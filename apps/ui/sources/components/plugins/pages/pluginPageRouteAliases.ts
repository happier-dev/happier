import type { PluginUiAppPageRouteAliasV1 } from '@happier-dev/protocol/plugins/contributions/ui/routeAliases';
import type { PluginUiSurfaceBindingV1 } from '@happier-dev/protocol/plugins/ui';
import { readCurrentAppShellPluginUiProjection } from '@/components/appShell/plugins/committedPluginUiProjection';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { createWorkspaceRouteMatcher } from '@/components/appShell/workspace/workspaceRouteMatch';
import { buildPluginAppPageRoutePath } from './pluginPageRoute';

type RouteParams = Readonly<Record<string, string | string[] | undefined>>;
type PageAliasSource = Readonly<{
    binding: PluginUiSurfaceBindingV1;
    routeAliases?: readonly PluginUiAppPageRouteAliasV1[];
}>;
type AliasResolver = (pathname: string, params: RouteParams) => string | null;

// These immutable rows already belong to the projection owner. Prepare the matcher
// once per published set rather than sorting the page inventory on each route read.
const resolvers = new WeakMap<Readonly<Record<string, PageAliasSource>>, AliasResolver>();

/** Workspace hosting and Expo redirects consume the same admitted app-page aliases. */
export function resolvePluginAppPageRouteAlias(pathname: string, params: RouteParams): string | null {
    const scope = getActiveServerAccountScope();
    const pages = readCurrentAppShellPluginUiProjection(scope ? { scope, declarationsOnly: true } : undefined)?.surfacePlacementsById;
    if (!pages) return null;
    let resolve = resolvers.get(pages);
    if (!resolve) {
        const aliases = new Map<string, Readonly<{ alias: PluginUiAppPageRouteAliasV1; pluginId: string; localId: string }>>();
        for (const page of Object.values(pages)) {
            if (page.binding.kind !== 'destination' || page.binding.container !== 'appPage' || page.binding.targetKind !== 'app') continue;
            for (const alias of page.routeAliases ?? []) {
                aliases.set(alias.pathname, { alias, ...page.binding.destination });
            }
        }
        const match = createWorkspaceRouteMatcher([...aliases.keys()]);
        resolve = (path, query) => {
            const matched = match(path);
            if (!matched) return null;
            const selected = aliases.get(matched.routeKey)!;
            let missingParameter = false;
            const subPath = selected.alias.subPath?.replace(/\{([^{}]+)\}/g, (_, key: string) => {
                const value = matched.params[key] ?? query[key];
                const first = Array.isArray(value) ? value[0] : value;
                if (!first) { missingParameter = true; return ''; }
                return encodeURIComponent(first);
            });
            return buildPluginAppPageRoutePath({ pluginId: selected.pluginId, localId: selected.localId,
                ...(missingParameter || subPath === undefined ? {} : { subPath }) });
        };
        resolvers.set(pages, resolve);
    }
    return resolve(pathname, params);
}
