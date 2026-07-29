import type { PluginUiRenderSurface } from '@happier-dev/plugin-sdk/ui';
import {
    createPluginUiHostApiClient,
} from '@happier-dev/plugin-sdk/ui/client';
import type { PluginUiHostApi } from '@happier-dev/plugin-sdk/ui';

export const renderSurface: PluginUiRenderSurface = ({ surface }) => ({
    type: 'Text',
    props: { children: `Shared native renderer (${surface.platform})` },
    key: null,
});

export function connectHostedWebPanel(signal?: AbortSignal): Promise<PluginUiHostApi> {
    return createPluginUiHostApiClient(signal === undefined ? undefined : { signal });
}
