import * as React from 'react';

import { applyInstalledPluginUiReactNativeRuntimeProjectionInvalidation } from '@/components/plugins/reactNative/projectionInvalidation';
import {
    usePluginUiProjectionCurrentness,
    type PluginUiProjectionCurrentness,
} from '@/sync/domains/plugins/ui/usePluginUiProjectionCurrentness';
import {
    EMPTY_PLUGIN_UI_PROJECTION,
    type PluginUiProjectionModel,
} from '@/sync/domains/plugins/ui/projection';

export function useScopedPluginUiProjection(params: Readonly<{
    machineId?: string | null;
    serverId?: string | null;
    enabled?: boolean;
}>): PluginUiProjectionCurrentness {
    const projection = usePluginUiProjectionCurrentness(params);
    const previousProjectionRef = React.useRef<PluginUiProjectionModel>(EMPTY_PLUGIN_UI_PROJECTION);

    React.useEffect(() => {
        const previous = previousProjectionRef.current;
        const next = projection.pluginUiProjection ?? EMPTY_PLUGIN_UI_PROJECTION;
        if (previous === next) return;
        previousProjectionRef.current = next;
        void applyInstalledPluginUiReactNativeRuntimeProjectionInvalidation(previous, next).catch(() => {
            // Scoped consumers invalidate caches only; a failure cannot grant authority.
        });
    }, [projection.pluginUiProjection]);

    return projection;
}
