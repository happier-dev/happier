import type { LocalServicePreviewPlatform } from '@/sync/domains/local/services/preview/url';
import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import {
    useSessionAddressForSessionId,
    useSessionPluginRuntime,
    type SessionPaneSurfaceScope,
    type SessionPluginRuntimeState,
} from '@/components/sessions/plugins/useSessionPluginRuntime';

export type SessionDetailsPanelPluginRuntimeState = SessionPluginRuntimeState;

export function useSessionDetailsPanelPluginRuntime(params: Readonly<{
    sessionId: string;
    routeServerId?: string | null;
    /**
     * AppPane's registered driver is the authority for target/projection facts.
     * Direct screen renders omit this and retain their incumbent local lookup.
     */
    paneSurfaceScope?: SessionPaneSurfaceScope;
    pluginUiProjection?: PluginUiProjectionModel | null;
    platform?: LocalServicePreviewPlatform;
}>): SessionDetailsPanelPluginRuntimeState {
    // Qualify the Home-local Session id once, at this entry boundary, through
    // the canonical Session server owner.
    const address = useSessionAddressForSessionId(
        params.sessionId,
        params.paneSurfaceScope?.serverId ?? params.routeServerId,
    );
    return useSessionPluginRuntime({
        address,
        paneSurfaceScope: params.paneSurfaceScope,
        pluginUiProjection: params.pluginUiProjection,
        platform: params.platform,
    });
}
