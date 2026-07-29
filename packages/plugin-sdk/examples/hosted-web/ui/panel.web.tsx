import {
    createPluginUiHostApiClient,
} from '@happier-dev/plugin-sdk/ui/client';
import type { PluginUiHostApi } from '@happier-dev/plugin-sdk/ui';

export function connectHostedWebPanel(signal?: AbortSignal): Promise<PluginUiHostApi> {
    return createPluginUiHostApiClient(signal === undefined ? undefined : { signal });
}
