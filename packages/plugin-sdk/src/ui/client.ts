import { PluginUiHostApiClientError, createPluginUiHostApiClientFromTransport } from './clientTransport.js';
import { readPluginUiHostApiClientBootstrap } from './clientBootstrap.js';
import type { PluginUiHostApi } from './hostApi.js';

type CreatePluginUiHostApiClientOptions = Readonly<{ signal?: AbortSignal }>;

export const createPluginUiHostApiClient = async (
    options: CreatePluginUiHostApiClientOptions = {},
): Promise<PluginUiHostApi> => {
    const bootstrap = readPluginUiHostApiClientBootstrap();
    if (!bootstrap) {
        throw new PluginUiHostApiClientError(
            'ui_host_bootstrap_missing',
            'The hosted plugin UI client was loaded outside a Happier hosted-web surface.',
        );
    }
    return createPluginUiHostApiClientFromTransport({
        identity: bootstrap.identity,
        transport: bootstrap.transport,
        ...(bootstrap.apiRange === undefined ? {} : { apiRange: bootstrap.apiRange }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
};
