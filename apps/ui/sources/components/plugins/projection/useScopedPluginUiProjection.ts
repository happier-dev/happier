import {
    usePluginUiProjectionCurrentness,
    type PluginUiProjectionCurrentness,
} from '@/sync/domains/plugins/ui/usePluginUiProjectionCurrentness';

export function useScopedPluginUiProjection(params: Readonly<{
    machineId?: string | null;
    serverId?: string | null;
    enabled?: boolean;
}>): PluginUiProjectionCurrentness {
    return usePluginUiProjectionCurrentness(params);
}
