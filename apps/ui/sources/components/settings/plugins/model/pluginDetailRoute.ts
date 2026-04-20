export const PLUGIN_DETAIL_ROUTE = '/(app)/settings/plugins/[pluginId]' as const;

export function buildPluginDetailRoute(pluginId: string) {
    return {
        pathname: PLUGIN_DETAIL_ROUTE,
        params: { pluginId },
    } as const;
}

export function readPluginDetailRoutePluginId(value: unknown): string | null {
    if (Array.isArray(value)) {
        return readPluginDetailRoutePluginId(value[0]);
    }
    if (typeof value !== 'string') {
        return null;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}
