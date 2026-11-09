import {
    usePluginUiProjectionCurrentness,
    type PluginUiProjectionCurrentness,
} from '@/sync/domains/plugins/ui/usePluginUiProjectionCurrentness';

export { PLUGIN_SEARCH_SECTIONS } from '@/sync/domains/plugins/ui/usePluginUiProjectionCurrentness';

export function useScopedPluginUiProjection(params: Readonly<{
    machineId?: string | null;
    serverId?: string | null;
    enabled?: boolean;
    includeConnectedAccountPurposes?: boolean;
    sections?: readonly string[];
}>): PluginUiProjectionCurrentness {
    return usePluginUiProjectionCurrentness(params);
}
